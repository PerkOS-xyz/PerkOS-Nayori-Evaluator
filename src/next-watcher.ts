import { Cl, ClarityType, type ClarityValue } from "@stacks/transactions";
import {
  commerceContractsSchema,
  isCanonicalApiUrl,
  policyForNetwork,
  type CommerceContracts,
} from "./contracts.js";
import { pacedStacksReads, publicReadOnly, readBurnHeight, type ReadOnly } from "./eligibility.js";
import { NAYORI_NEXT_STATUS } from "./next-generation.js";

export interface ReadyNextJob {
  readonly asset: "stx" | "sbtc";
  readonly contract: string;
  readonly jobId: string;
  readonly reviewDeadline: string;
  readonly blocksLeft: string;
}

export interface NextJobWatcherOptions {
  readonly contracts: CommerceContracts;
  readonly evaluatorPrincipal: string;
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
  readonly readOnly?: ReadOnly;
  /** Upper bound on read-only calls per scan, so a scan never floods the public API. */
  readonly maxReadsPerScan?: number;
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
function optionalTuple(cv: ClarityValue): Record<string, ClarityValue> | null {
  if (cv.type === ClarityType.OptionalNone) return null;
  if (cv.type !== ClarityType.OptionalSome || cv.value.type !== ClarityType.Tuple) {
    throw new Error("Invalid public optional tuple.");
  }
  return cv.value.value;
}

/**
 * Read-only watcher of the next-generation escrows. It finds jobs whose evaluator is this service,
 * at status 4 (submitted) and still inside their review window. It never signs: evaluation still
 * needs the job's criteria and evidence through the normal intake, and the eligibility gate
 * re-reads the chain before and after inference. Jobs whose window has closed are dropped; the
 * default approval after the window is the keeper's job, not the evaluator's.
 */
export class NextJobWatcher {
  private readonly contracts: CommerceContracts;
  private readonly read: ReadOnly;
  private readonly fetcher: typeof fetch;
  private readonly maxReads: number;
  /** Highest job id already read, per escrow. */
  private readonly cursor = new Map<string, bigint>();
  /** Jobs assigned to this evaluator that have not reached status 4 yet, per escrow. */
  private readonly tracked = new Map<string, Set<bigint>>();
  /** Alternates which escrow is read first, so one busy escrow cannot starve the other. */
  private turn = 0;

  constructor(private readonly options: NextJobWatcherOptions) {
    this.contracts = commerceContractsSchema.parse(options.contracts);
    if (!this.contracts.next) throw new Error("Next-generation contracts are not configured.");
    if (!isCanonicalApiUrl(this.contracts.network, options.apiUrl)) {
      throw new Error("Stacks API does not match the selected network.");
    }
    this.fetcher = pacedStacksReads(options.fetch ?? fetch);
    this.read = options.readOnly ?? publicReadOnly(this.contracts.network, options.apiUrl,
      options.evaluatorPrincipal, this.fetcher);
    this.maxReads = options.maxReadsPerScan ?? 10;
  }

  /** Returns each submitted, in-window job of this evaluator once (the first scan that sees it). */
  async scan(): Promise<ReadyNextJob[]> {
    const next = this.contracts.next!;
    const burnHeight = await readBurnHeight(this.fetcher, this.options.apiUrl,
      policyForNetwork(this.contracts.network).networkId);
    let budget = this.maxReads;
    const ready: ReadyNextJob[] = [];
    const escrows = [["stx", next.stxContract], ["sbtc", next.sbtcContract]] as const;
    const order = this.turn++ % 2 === 0 ? escrows : [...escrows].reverse();
    for (const [asset, contract] of order) {
      if (budget <= 0) break;
      const count = uint(await this.read(contract, "get-job-count", [])); budget--;
      const tracked = this.tracked.get(contract) ?? new Set<bigint>();
      this.tracked.set(contract, tracked);
      const cursor = this.cursor.get(contract) ?? 0n;
      // New ids first: the cursor only moves forward, so a bounded backlog always drains.
      const candidates: bigint[] = [];
      for (let id = cursor + 1n; id <= count; id++) candidates.push(id);
      candidates.push(...[...tracked].sort((a, b) => (a < b ? -1 : 1)));
      for (const id of candidates) {
        if (budget <= 0) break;
        const job = optionalTuple(await this.read(contract, "get-job", [Cl.uint(id)])); budget--;
        if (id > (this.cursor.get(contract) ?? 0n)) this.cursor.set(contract, id);
        const status = job ? uint(job.status) : undefined;
        if (!job || status === undefined || principal(job.evaluator) !== this.options.evaluatorPrincipal ||
          status > NAYORI_NEXT_STATUS.submitted) {
          tracked.delete(id);
          continue;
        }
        tracked.add(id);
        if (status !== NAYORI_NEXT_STATUS.submitted) continue;
        if (budget <= 0) break;
        const submission = optionalTuple(await this.read(contract, "get-submission", [Cl.uint(id)])); budget--;
        if (!submission) continue;
        const reviewDeadline = uint(submission["review-deadline"]);
        tracked.delete(id); // Reported once, or window closed: either way it is not read again.
        if (burnHeight > reviewDeadline) continue; // Never act; anyone may record the default approval.
        ready.push({ asset, contract, jobId: id.toString(), reviewDeadline: reviewDeadline.toString(),
          blocksLeft: (reviewDeadline - burnHeight).toString() });
      }
    }
    return ready;
  }
}
