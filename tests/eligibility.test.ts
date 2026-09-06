import { Cl, type ClarityValue } from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StacksTestnetEligibility, pacedTestnetReads } from "../src/eligibility.js";
import type { EvaluationRequest } from "../src/domain.js";

const DEPLOYER = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5";
const PROVIDER = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const EVALUATOR = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4";
const TREASURY = "ST1E7E64H8VSSSGE0RPWF90RRC91MQG7CRQRM1BFX";
const AUTHORITY = "ST256E5DAXM7RDFZ76ECCTPTBYHRXXJQ29H16DN69";
const TOKEN = "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token";
function fixture(asset: "stx" | "sbtc" = "stx", fees = true) {
  const contracts = { stxContract: `${DEPLOYER}.agentic-commerce-v${fees ? 6 : 5}`,
    sbtcContract: `${DEPLOYER}.sbtc-commerce-v${fees ? 5 : 4}` };
  const request: EvaluationRequest = { evaluationId: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9",
    network: "testnet", asset, contract: asset === "stx" ? contracts.stxContract : contracts.sbtcContract, jobId: "7",
    job: { client: DEPLOYER, provider: PROVIDER, evaluator: EVALUATOR, description: "QA evidence",
      status: "submitted", reviewDeadlineBurn: "100" },
    acceptanceCriteria: [{ id: "criterion", requirement: "JSON", verification: "Parse" }],
    evidence: [{ id: "report", uri: "https://example.com/report", sha256: "11".repeat(32), sizeBytes: 3, mediaType: "text/plain" }],
  };
  const job = { status: Cl.uint(2), client: Cl.standardPrincipal(DEPLOYER), provider: Cl.some(Cl.standardPrincipal(PROVIDER)),
    evaluator: Cl.standardPrincipal(EVALUATOR), description: Cl.stringAscii(request.job.description),
    "review-deadline": Cl.some(Cl.uint(100)), budget: Cl.uint(1000), treasury: Cl.standardPrincipal(TREASURY),
    "appeal-authority": Cl.standardPrincipal(AUTHORITY) };
  const policy = { configured: Cl.bool(true), "service-fee-bps": Cl.uint(200), "review-window": Cl.uint(12),
    "appeal-window": Cl.uint(3), treasury: Cl.standardPrincipal(TREASURY), "appeal-authority": Cl.standardPrincipal(AUTHORITY) };
  const fee = { "basis-points": Cl.uint(200), "fee-amount": Cl.uint(20), treasury: Cl.standardPrincipal(TREASURY),
    "service-recorded": Cl.bool(false), settlement: Cl.none(), waiver: Cl.none() };
  const values: Record<string, ClarityValue> = {
    "get-job": Cl.ok(Cl.tuple(job)), "get-escrow-balance": Cl.ok(Cl.uint(1000)),
    "get-decision": Cl.error(Cl.uint(asset === "stx" ? 829 : 930)),
    "get-job-payment-token": Cl.ok(Cl.principal(TOKEN)),
    "get-protocol-config": Cl.ok(Cl.tuple(policy)), "get-job-service-fee": Cl.ok(Cl.tuple(fee)),
  };
  const info = { network_id: 2147483648, burn_block_height: 100 };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(info)));
  const read = vi.fn(async (_contract: string, fn: string, _args: ClarityValue[]) => {
    if (!values[fn]) throw Error("Unexpected read");
    return values[fn];
  });
  const guard = new StacksTestnetEligibility({ contracts, evaluatorPrincipal: EVALUATOR,
    apiUrl: "https://api.testnet.hiro.so", fetch: fetchMock, readOnly: read });
  return { request, job, policy, fee, info, values, read, fetchMock, guard };
}

describe("Signer-free authoritative job eligibility", () => {
  it.each([["stx", false], ["sbtc", false], ["stx", true], ["sbtc", true]] as const)(
    "accepts %s fees=%s at the exact deadline", async (asset, fees) => {
      const f = fixture(asset, fees);
      await expect(f.guard.assertEligible(f.request)).resolves.toBeUndefined();
      expect(f.read.mock.calls.every(([contract]) => contract === f.request.contract)).toBe(true);
      expect(f.read.mock.calls.map(([, name]) => name).includes("get-job-service-fee")).toBe(fees);
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
    const changed = field === "reviewDeadlineBurn" ? "101" : field === "description" ? "Other" : AUTHORITY;
    await expect(f.guard.assertEligible({ ...f.request, job: { ...f.request.job, [field]: changed } })).rejects.toThrow("job_snapshot_mismatch");
  });
  it.each(["contract", "asset", "evaluator"])("rejects unauthorized %s before network reads", async field => {
    const f = fixture();
    const req = field === "contract" ? { ...f.request, contract: `${PROVIDER}.agentic-commerce-v6` } :
      field === "asset" ? { ...f.request, asset: "sbtc" as const } :
      { ...f.request, job: { ...f.request.job, evaluator: AUTHORITY } };
    await expect(f.guard.assertEligible(req)).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it.each([0, 999, 1001])("rejects inconsistent escrow %i", async escrow => {
    const f = fixture(); f.values["get-escrow-balance"] = Cl.ok(Cl.uint(escrow));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("escrow_budget_mismatch");
  });
  it("rejects absent decision with the wrong error code", async () => {
    const f = fixture("sbtc"); f.values["get-decision"] = Cl.error(Cl.uint(923));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("decision_already_exists");
  });
  it("rejects an existing decision", async () => {
    const f = fixture(); f.values["get-decision"] = Cl.ok(Cl.tuple({}));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("decision_already_exists");
  });
  it("rejects noncanonical sBTC", async () => {
    const f = fixture("sbtc"); f.values["get-job-payment-token"] = Cl.ok(Cl.principal(`${DEPLOYER}.fake-token`));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("noncanonical_sbtc_token");
  });
  it.each(["configured", "service-fee-bps", "review-window", "appeal-window", "treasury"])("rejects fee policy drift %s", async key => {
    const f = fixture(); const change = key === "configured" ? Cl.bool(false) : key === "treasury" ? Cl.standardPrincipal(PROVIDER) : Cl.uint(999);
    f.values["get-protocol-config"] = Cl.ok(Cl.tuple({ ...f.policy, [key]: change }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("fee_policy_mismatch");
  });
  it.each(["basis-points", "fee-amount", "treasury", "service-recorded", "settlement", "waiver"])("rejects inconsistent fee state %s", async key => {
    const f = fixture(); const change = key === "treasury" ? Cl.standardPrincipal(PROVIDER) :
      key === "service-recorded" ? Cl.bool(true) : ["settlement", "waiver"].includes(key) ? Cl.some(Cl.uint(1)) : Cl.uint(999);
    f.values["get-job-service-fee"] = Cl.ok(Cl.tuple({ ...f.fee, [key]: change }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("fee_state_mismatch");
  });
  it("rejects treasury colliding with an economic role", async () => {
    const f = fixture();
    f.values["get-job"] = Cl.ok(Cl.tuple({ ...f.job, treasury: Cl.standardPrincipal(PROVIDER) }));
    f.values["get-protocol-config"] = Cl.ok(Cl.tuple({ ...f.policy, treasury: Cl.standardPrincipal(PROVIDER) }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("treasury_role_collision");
  });
  it("rejects a passed deadline", async () => {
    const f = fixture(); f.info.burn_block_height = 101;
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("review_window_closed");
  });
  it("rejects mainnet node information", async () => {
    const f = fixture(); f.info.network_id = 1;
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("network_mismatch");
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
    const fetcher = pacedTestnetReads(transport);
    const first = fetcher("https://api.testnet.hiro.so/v2/info");
    await vi.advanceTimersByTimeAsync(0); await first;
    const second = fetcher("https://api.testnet.hiro.so/v2/info");
    await vi.advanceTimersByTimeAsync(2999); expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await second;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });
});
