import { Cl, ClarityType, fetchCallReadOnlyFunction, type ClarityValue } from "@stacks/transactions";
import type { EvaluationRequest } from "./domain.js";
import { EvaluationBlockedError } from "./evaluator.js";
import { commerceContractsSchema, hasServiceFees, isTestnetApiUrl, matchesTarget, type CommerceContracts } from "./contracts.js";

export interface EvaluationEligibility {
  assertEligible(request: EvaluationRequest): Promise<void>;
}
type ReadOnly = (contract: string, fn: string, args: ClarityValue[]) => Promise<ClarityValue>;
export interface EligibilityOptions {
  readonly contracts: CommerceContracts;
  readonly evaluatorPrincipal: string;
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
  readonly readOnly?: ReadOnly;
}
function ok(cv: ClarityValue): ClarityValue {
  if (cv.type !== ClarityType.ResponseOk) throw new Error("Public state is unavailable.");
  return cv.value;
}
function tuple(cv: ClarityValue) {
  if (cv.type !== ClarityType.Tuple) throw new Error("Invalid public tuple.");
  return cv.value;
}
function uint(cv: ClarityValue | undefined): bigint {
  if (cv?.type !== ClarityType.UInt) throw new Error("Invalid public uint.");
  return BigInt(cv.value);
}
function principal(cv: ClarityValue | undefined): string {
  if (cv?.type !== ClarityType.PrincipalStandard && cv?.type !== ClarityType.PrincipalContract) {
    throw new Error("Invalid public principal.");
  }
  return cv.value;
}
function some(cv: ClarityValue | undefined): ClarityValue {
  if (cv?.type !== ClarityType.OptionalSome) throw new Error("Missing public optional value.");
  return cv.value;
}
function requireState(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new EvaluationBlockedError(reason);
}

/** Serialize public reads across concurrent jobs; never used by the signing/broadcast adapter. */
export function pacedTestnetReads(transport: typeof fetch): typeof fetch {
  let tail: Promise<void> = Promise.resolve();
  let lastStart = 0;
  return (url, init) => {
    const run = tail.then(async () => {
      const wait = Math.max(0, 3_000 - (Date.now() - lastStart));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastStart = Date.now();
      return transport(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/** Public reads only. The contract is still authoritative if state changes after this check. */
export class StacksTestnetEligibility implements EvaluationEligibility {
  private readonly contracts: CommerceContracts;
  private readonly read: ReadOnly;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: EligibilityOptions) {
    this.contracts = commerceContractsSchema.parse(options.contracts);
    if (!isTestnetApiUrl(options.apiUrl)) throw new Error("Only the public testnet API is allowed.");
    this.fetcher = pacedTestnetReads(options.fetch ?? fetch);
    this.read = options.readOnly ?? (async (contract, functionName, functionArgs) => {
      const [contractAddress, contractName] = contract.split(".");
      return fetchCallReadOnlyFunction({
        contractAddress: contractAddress!, contractName: contractName!, functionName, functionArgs,
        senderAddress: options.evaluatorPrincipal, network: "testnet",
        client: { baseUrl: options.apiUrl.replace(/\/$/, ""), fetch: (url, init) =>
          this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }) },
      });
    });
  }

  async assertEligible(request: EvaluationRequest): Promise<void> {
    requireState(matchesTarget(this.contracts, request), "contract_not_allowlisted");
    requireState(request.job.evaluator === this.options.evaluatorPrincipal, "evaluator_principal_mismatch");
    const read = (fn: string, args = [Cl.uint(BigInt(request.jobId))]) => this.read(request.contract, fn, args);
    const job = tuple(ok(await read("get-job")));
    requireState(uint(job.status) === 2n, "job_not_submitted");
    requireState(principal(job.client) === request.job.client &&
      principal(some(job.provider)) === request.job.provider &&
      principal(job.evaluator) === this.options.evaluatorPrincipal &&
      job.description?.type === ClarityType.StringASCII && job.description.value === request.job.description &&
      uint(some(job["review-deadline"])) === BigInt(request.job.reviewDeadlineBurn), "job_snapshot_mismatch");
    requireState(new Set([request.job.client, request.job.provider, request.job.evaluator]).size === 3,
      "job_role_collision");
    const budget = uint(job.budget);
    requireState(budget > 0n && uint(ok(await read("get-escrow-balance"))) === budget, "escrow_budget_mismatch");
    const decision = await read("get-decision");
    requireState(decision.type === ClarityType.ResponseErr &&
      uint(decision.value) === (request.asset === "stx" ? 829n : 930n), "decision_already_exists");
    if (request.asset === "sbtc") {
      requireState(principal(ok(await read("get-job-payment-token"))) ===
        "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token", "noncanonical_sbtc_token");
    }
    if (hasServiceFees(this.contracts)) {
      const policy = tuple(ok(await read("get-protocol-config", [])));
      const fee = tuple(ok(await read("get-job-service-fee")));
      const treasury = principal(job.treasury);
      requireState(policy.configured?.type === ClarityType.BoolTrue &&
        uint(policy["service-fee-bps"]) === 200n && uint(policy["review-window"]) === 12n &&
        uint(policy["appeal-window"]) === 3n && principal(policy.treasury) === treasury &&
        principal(policy["appeal-authority"]) !== treasury, "fee_policy_mismatch");
      requireState(![request.job.client, request.job.provider, request.job.evaluator,
        principal(job["appeal-authority"])].includes(treasury), "treasury_role_collision");
      requireState(uint(fee["basis-points"]) === 200n && uint(fee["fee-amount"]) === budget / 50n &&
        principal(fee.treasury) === treasury && fee["service-recorded"]?.type === ClarityType.BoolFalse &&
        fee.settlement?.type === ClarityType.OptionalNone && fee.waiver?.type === ClarityType.OptionalNone,
      "fee_state_mismatch");
    }
    // Last read: enforce current burn height after the other sequential reads, never a wall clock estimate.
    const response = await this.fetcher(`${this.options.apiUrl.replace(/\/$/, "")}/v2/info`, {
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Public network state unavailable.");
    const info = await response.json() as { network_id?: unknown; burn_block_height?: unknown };
    requireState(info.network_id === 2147483648, "network_mismatch");
    if (typeof info.burn_block_height !== "number" || !Number.isSafeInteger(info.burn_block_height) ||
      info.burn_block_height < 0) throw new Error("Invalid burn height.");
    requireState(BigInt(info.burn_block_height) <= uint(some(job["review-deadline"])), "review_window_closed");
  }
}
