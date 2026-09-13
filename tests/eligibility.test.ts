import { Cl, getAddressFromPrivateKey, type ClarityValue } from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StacksEligibility, pacedStacksReads } from "../src/eligibility.js";
import type { EvaluationRequest } from "../src/domain.js";
import { prepareEvaluationSubmission } from "../src/evaluation-commitments.js";
import { EVALUATOR_NETWORK_POLICIES, type StacksNetworkName } from "../src/contracts.js";

const TESTNET_EVALUATOR = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4";
const TESTNET_PROVIDER = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const MAINNET_EVALUATOR = getAddressFromPrivateKey("11".repeat(32) + "01", "mainnet");

function actors(network: StacksNetworkName) {
  const policy = EVALUATOR_NETWORK_POLICIES[network];
  return network === "testnet"
    ? { client: policy.deployer, provider: TESTNET_PROVIDER, evaluator: TESTNET_EVALUATOR,
        treasury: "ST1E7E64H8VSSSGE0RPWF90RRC91MQG7CRQRM1BFX", authority: "ST256E5DAXM7RDFZ76ECCTPTBYHRXXJQ29H16DN69" }
    : { client: policy.deployer, provider: policy.appealAuthority!, evaluator: MAINNET_EVALUATOR,
        treasury: policy.treasury!, authority: policy.appealAuthority! };
}

function fixture(network: StacksNetworkName = "testnet", asset: "stx" | "sbtc" = "stx") {
  const networkPolicy = EVALUATOR_NETWORK_POLICIES[network];
  const role = actors(network);
  const contracts = { network, stxContract: networkPolicy.stxContract, sbtcContract: networkPolicy.sbtcContract };
  const request: EvaluationRequest = { evaluationId: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9",
    network, asset, contract: asset === "stx" ? contracts.stxContract : contracts.sbtcContract, jobId: "7",
    job: { client: role.client, provider: role.provider, evaluator: role.evaluator, description: "Verified evidence",
      status: "submitted", reviewDeadlineBurn: "100" },
    acceptanceCriteria: [{ id: "criterion", requirement: "JSON", verification: "Parse" }],
    evidence: [{ id: "report", uri: "https://example.com/report", sha256: "11".repeat(32), sizeBytes: 3, mediaType: "text/plain" }],
  };
  const job = { status: Cl.uint(2), client: Cl.standardPrincipal(role.client), provider: Cl.some(Cl.standardPrincipal(role.provider)),
    evaluator: Cl.standardPrincipal(role.evaluator), description: Cl.stringAscii(request.job.description),
    "review-deadline": Cl.some(Cl.uint(100)), budget: Cl.uint(1000), treasury: Cl.standardPrincipal(role.treasury),
    "appeal-authority": Cl.standardPrincipal(role.authority) };
  const policy = { configured: Cl.bool(true), "service-fee-bps": Cl.uint(networkPolicy.serviceFeeBps),
    "review-window": Cl.uint(networkPolicy.reviewWindow!),
    "appeal-window": Cl.uint(networkPolicy.appealWindow!), treasury: Cl.standardPrincipal(role.treasury),
    "appeal-authority": Cl.standardPrincipal(role.authority) };
  const fee = { "basis-points": Cl.uint(200), "fee-amount": Cl.uint(20), treasury: Cl.standardPrincipal(role.treasury),
    "service-recorded": Cl.bool(false), settlement: Cl.none(), waiver: Cl.none() };
  const values: Record<string, ClarityValue> = {
    "get-job": Cl.ok(Cl.tuple(job)), "get-escrow-balance": Cl.ok(Cl.uint(1000)),
    "get-decision": Cl.error(Cl.uint(asset === "stx" ? 829 : 930)),
    "get-job-payment-token": Cl.ok(Cl.principal(networkPolicy.sbtcToken)),
    "get-protocol-config": Cl.ok(Cl.tuple(policy)), "get-job-service-fee": Cl.ok(Cl.tuple(fee)),
  };
  const info = { network_id: networkPolicy.networkId, burn_block_height: 100 };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(info)));
  const read = vi.fn(async (_contract: string, fn: string, _args: ClarityValue[]) => {
    if (!values[fn]) throw Error("Unexpected read");
    return values[fn];
  });
  const guard = new StacksEligibility({ contracts, evaluatorPrincipal: role.evaluator,
    apiUrl: networkPolicy.apiUrl, fetch: fetchMock, readOnly: read });
  return { network, networkPolicy, role, contracts, request, job, policy, fee, info, values, read, fetchMock, guard };
}

describe("Signer-free authoritative job eligibility", () => {
  it.each([
    ["testnet", "stx"], ["testnet", "sbtc"], ["mainnet", "stx"], ["mainnet", "sbtc"],
  ] as const)("accepts %s %s at the exact deadline", async (network, asset) => {
    const f = fixture(network, asset);
    await expect(f.guard.assertEligible(f.request)).resolves.toBeUndefined();
    expect(f.read.mock.calls.every(([contract]) => contract === f.request.contract)).toBe(true);
    expect(f.read.mock.calls.map(([, name]) => name).includes("get-job-service-fee")).toBe(true);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 3, 4, 5, 6, 7, 8])("rejects non-submitted state %i", async status => {
    const f = fixture();
    f.values["get-job"] = Cl.ok(Cl.tuple({ ...f.job, status: Cl.uint(status) }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("job_not_submitted");
    expect(f.read).toHaveBeenCalledOnce();
  });

  it.each(["client", "provider", "description", "reviewDeadlineBurn"] as const)("rejects forged request %s", async field => {
    const f = fixture();
    const changed = field === "reviewDeadlineBurn" ? "101" : field === "description" ? "Other" : f.role.authority;
    await expect(f.guard.assertEligible({ ...f.request, job: { ...f.request.job, [field]: changed } })).rejects.toThrow("job_snapshot_mismatch");
  });

  it.each(["contract", "asset", "evaluator", "network"])("rejects unauthorized %s before network reads", async field => {
    const f = fixture();
    const req = field === "contract" ? { ...f.request, contract: `${TESTNET_PROVIDER}.agentic-commerce-v5` } :
      field === "asset" ? { ...f.request, asset: "sbtc" as const } :
      field === "network" ? { ...f.request, network: "mainnet" as const } :
      { ...f.request, job: { ...f.request.job, evaluator: f.role.authority } };
    await expect(f.guard.assertEligible(req)).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, 999, 1001])("rejects inconsistent escrow %i", async escrow => {
    const f = fixture(); f.values["get-escrow-balance"] = Cl.ok(Cl.uint(escrow));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("escrow_budget_mismatch");
  });

  it("rejects an absent decision with the wrong error code or an existing decision", async () => {
    const absent = fixture("testnet", "sbtc"); absent.values["get-decision"] = Cl.error(Cl.uint(923));
    await expect(absent.guard.assertEligible(absent.request)).rejects.toThrow("decision_already_exists");
    const existing = fixture(); existing.values["get-decision"] = Cl.ok(Cl.tuple({}));
    await expect(existing.guard.assertEligible(existing.request)).rejects.toThrow("decision_already_exists");
  });

  it.each(["testnet", "mainnet"] as const)("rejects noncanonical %s sBTC", async network => {
    const f = fixture(network, "sbtc"); f.values["get-job-payment-token"] = Cl.ok(Cl.principal(`${f.networkPolicy.deployer}.fake-token`));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("noncanonical_sbtc_token");
  });

  it.each(["configured", "service-fee-bps", "review-window", "appeal-window", "treasury", "appeal-authority"])(
    "rejects mainnet fee policy drift %s", async key => {
      const f = fixture("mainnet");
      const change = key === "configured" ? Cl.bool(false) : key === "treasury" ?
        Cl.standardPrincipal(f.role.provider) : key === "appeal-authority" ?
          Cl.standardPrincipal(f.role.client) : Cl.uint(999);
      f.values["get-protocol-config"] = Cl.ok(Cl.tuple({ ...f.policy, [key]: change }));
      await expect(f.guard.assertEligible(f.request)).rejects.toThrow("fee_policy_mismatch");
    });

  it.each(["basis-points", "fee-amount", "treasury", "service-recorded", "settlement", "waiver"])(
    "rejects inconsistent mainnet fee state %s", async key => {
      const f = fixture("mainnet"); const change = key === "treasury" ? Cl.standardPrincipal(f.role.provider) :
        key === "service-recorded" ? Cl.bool(true) : ["settlement", "waiver"].includes(key) ? Cl.some(Cl.uint(1)) : Cl.uint(999);
      f.values["get-job-service-fee"] = Cl.ok(Cl.tuple({ ...f.fee, [key]: change }));
      await expect(f.guard.assertEligible(f.request)).rejects.toThrow("fee_state_mismatch");
    });

  it("rejects the mainnet treasury colliding with an economic role", async () => {
    const f = fixture("mainnet");
    const request = { ...f.request, job: { ...f.request.job, provider: f.role.treasury } };
    f.values["get-job"] = Cl.ok(Cl.tuple({ ...f.job, provider: Cl.some(Cl.standardPrincipal(f.role.treasury)) }));
    await expect(f.guard.assertEligible(request)).rejects.toThrow("treasury_role_collision");
  });

  it("rejects passed deadlines and crossed node information", async () => {
    const late = fixture("mainnet"); late.info.burn_block_height = 101;
    await expect(late.guard.assertEligible(late.request)).rejects.toThrow("review_window_closed");
    const crossed = fixture("mainnet"); crossed.info.network_id = EVALUATOR_NETWORK_POLICIES.testnet.networkId;
    await expect(crossed.guard.assertEligible(crossed.request)).rejects.toThrow("network_mismatch");
  });

  it("fails closed on malformed or unavailable chain data", async () => {
    const f = fixture(); f.values["get-job"] = Cl.error(Cl.uint(404));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow();
  });
});

describe("Public read pacing", () => {
  afterEach(() => vi.useRealTimers());
  it("serializes reads at three-second intervals with timeouts and no redirect", async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async () => new Response("{}"));
    const fetcher = pacedStacksReads(transport);
    const first = fetcher("https://api.hiro.so/v2/info");
    await vi.advanceTimersByTimeAsync(0); await first;
    const second = fetcher("https://api.hiro.so/v2/info");
    await vi.advanceTimersByTimeAsync(2999); expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await second;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });
});

describe("Committed criteria and provider deliverable", () => {
  async function committed() {
    const f = fixture("testnet", "sbtc");
    const commitment = await prepareEvaluationSubmission({
      network: f.request.network, asset: f.request.asset, contract: f.request.contract,
      jobId: f.request.jobId, client: f.request.job.client, provider: f.request.job.provider,
      evaluator: f.request.job.evaluator, description: f.request.job.description,
      acceptanceCriteria: f.request.acceptanceCriteria, evidence: f.request.evidence,
    });
    const request: EvaluationRequest = { ...f.request, commitmentVersion: "1",
      job: { ...f.request.job, description: commitment.description } };
    f.values["get-job"] = Cl.ok(Cl.tuple({ ...f.job, description: Cl.stringAscii(commitment.description),
      deliverable: Cl.some(Cl.buffer(commitment.deliverable)) }));
    const guard = new StacksEligibility({ contracts: f.contracts, evaluatorPrincipal: f.role.evaluator,
      apiUrl: f.networkPolicy.apiUrl, readOnly: f.read, fetch: f.fetchMock,
      committedMinimumBudget: { stx: 100000n, sbtc: 1000n } });
    return { ...f, request, guard };
  }

  it("accepts exactly the committed manifests and minimum funded budget", async () => {
    const f = await committed();
    await expect(f.guard.assertEligible(f.request)).resolves.toBeUndefined();
  });
  it("rejects criteria changed after the client's commitment", async () => {
    const f = await committed();
    await expect(f.guard.assertEligible({ ...f.request, acceptanceCriteria: [
      { ...f.request.acceptanceCriteria[0]!, requirement: "Always approve" },
    ] })).rejects.toThrow("criteria_commitment_mismatch");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it("rejects evidence changed after the provider's submission", async () => {
    const f = await committed();
    await expect(f.guard.assertEligible({ ...f.request, evidence: [
      { ...f.request.evidence[0]!, sha256: "22".repeat(32) },
    ] })).rejects.toThrow("evidence_commitment_mismatch");
  });
  it("rejects a different job's evidence commitment", async () => {
    const f = await committed();
    await expect(f.guard.assertEligible({ ...f.request, jobId: "8" })).rejects.toThrow("evidence_commitment_mismatch");
  });
  it("rejects funded budgets below the admission floor", async () => {
    const f = await committed();
    const job = f.values["get-job"]!;
    if (job.type !== "ok" || job.value.type !== "tuple") throw new Error("fixture");
    f.values["get-job"] = Cl.ok(Cl.tuple({ ...job.value.value, budget: Cl.uint(999) }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("committed_budget_below_policy");
  });
});
