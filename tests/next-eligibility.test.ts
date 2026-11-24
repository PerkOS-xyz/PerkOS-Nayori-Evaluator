import { Cl, validateStacksAddress, type ClarityValue } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { StacksEligibility } from "../src/eligibility.js";
import type { EvaluationRequest } from "../src/domain.js";
import { prepareEvaluationSubmission } from "../src/evaluation-commitments.js";
import { EVALUATOR_NETWORK_POLICIES, NAYORI_NEXT_DEPLOYERS, NAYORI_NEXT_ROLES, nextEscrowContracts } from "../src/contracts.js";

const policy = EVALUATOR_NETWORK_POLICIES.testnet;
const NEXT_DEPLOYER = NAYORI_NEXT_DEPLOYERS.testnet;
const CLIENT = policy.deployer;
const PROVIDER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const EVALUATOR = policy.evaluator;
const next = nextEscrowContracts(NEXT_DEPLOYER);
const ROLES = NAYORI_NEXT_ROLES.testnet;

function nextFixture(asset: "stx" | "sbtc" = "stx") {
  const contracts = { network: "testnet" as const, stxContract: policy.stxContract, sbtcContract: policy.sbtcContract, next };
  const request: EvaluationRequest = { evaluationId: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9",
    network: "testnet", asset, contract: asset === "stx" ? next.stxContract : next.sbtcContract, jobId: "7",
    job: { client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, description: "Verified evidence",
      status: "submitted", reviewDeadlineBurn: "100" },
    acceptanceCriteria: [{ id: "criterion", requirement: "JSON", verification: "Parse" }],
    evidence: [{ id: "report", uri: "https://example.com/report", sha256: "11".repeat(32), sizeBytes: 3, mediaType: "text/plain" }],
  };
  const job: Record<string, ClarityValue> = { client: Cl.standardPrincipal(CLIENT), evaluator: Cl.standardPrincipal(EVALUATOR),
    provider: Cl.some(Cl.standardPrincipal(PROVIDER)), treasury: Cl.standardPrincipal(ROLES.treasury),
    "appeal-authority": Cl.standardPrincipal(ROLES.appealAuthority), budget: Cl.uint(1_000_000),
    description: Cl.stringAscii(request.job.description), "delivery-deadline": Cl.uint(90), "delivery-blocks": Cl.uint(144),
    "review-blocks": Cl.uint(12), status: Cl.uint(4) };
  const submission: Record<string, ClarityValue> = { deliverable: Cl.buffer(new Uint8Array(36)), "review-deadline": Cl.uint(100) };
  const values: Record<string, ClarityValue> = {
    "get-job": Cl.some(Cl.tuple(job)), "get-submission": Cl.some(Cl.tuple(submission)),
    "get-escrow-balance": Cl.uint(1_000_000), "get-decision": Cl.none(),
  };
  const info = { network_id: policy.networkId, burn_block_height: 100 };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(info)));
  const read = vi.fn(async (_contract: string, fn: string, _args: ClarityValue[]) => {
    if (!values[fn]) throw Error("Unexpected read");
    return values[fn];
  });
  const guard = new StacksEligibility({ contracts, evaluatorPrincipal: EVALUATOR, apiUrl: policy.apiUrl,
    fetch: fetchMock, readOnly: read, committedMinimumBudget: { stx: 100000n, sbtc: 1000n } });
  return { contracts, request, job, submission, values, info, read, fetchMock, guard };
}

describe("Next-generation job eligibility", () => {
  it.each(["stx", "sbtc"] as const)("accepts a submitted %s job at the exact review deadline", async asset => {
    const f = nextFixture(asset);
    await expect(f.guard.assertEligible(f.request)).resolves.toBeUndefined();
    expect(f.read.mock.calls.every(([contract]) => contract === f.request.contract)).toBe(true);
    expect(f.read.mock.calls.map(([, name]) => name))
      .toEqual(["get-job", "get-submission", "get-escrow-balance", "get-decision"]);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it("does not act once the review window has closed (default approval is the keeper's job)", async () => {
    const f = nextFixture(); f.info.burn_block_height = 101;
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("review_window_closed");
  });

  it.each([0, 1, 2, 3, 5, 6, 7, 8, 9, 10])("rejects status %i (only 4 is submitted)", async status => {
    const f = nextFixture();
    f.values["get-job"] = Cl.some(Cl.tuple({ ...f.job, status: Cl.uint(status) }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("job_not_submitted");
    expect(f.read).toHaveBeenCalledOnce();
  });

  it("rejects a missing job or submission", async () => {
    const missing = nextFixture(); missing.values["get-job"] = Cl.none();
    await expect(missing.guard.assertEligible(missing.request)).rejects.toThrow("job_not_found");
    const unsubmitted = nextFixture(); unsubmitted.values["get-submission"] = Cl.none();
    await expect(unsubmitted.guard.assertEligible(unsubmitted.request)).rejects.toThrow();
    expect(unsubmitted.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["client", "provider", "description", "reviewDeadlineBurn"] as const)("rejects forged request %s", async field => {
    const f = nextFixture();
    const changed = field === "reviewDeadlineBurn" ? "101" : field === "description" ? "Other" : policy.appealAuthority;
    await expect(f.guard.assertEligible({ ...f.request, job: { ...f.request.job, [field]: changed } }))
      .rejects.toThrow(/job_snapshot_mismatch|treasury_role_collision/);
  });

  it("rejects a job whose evaluator is someone else", async () => {
    const f = nextFixture();
    f.values["get-job"] = Cl.some(Cl.tuple({ ...f.job, evaluator: Cl.standardPrincipal(policy.appealAuthority) }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("job_snapshot_mismatch");
  });

  it.each([
    { treasury: policy.treasury }, { "appeal-authority": policy.appealAuthority },
    { treasury: ROLES.appealAuthority, "appeal-authority": ROLES.treasury },
    { treasury: NAYORI_NEXT_ROLES.mainnet.treasury },
  ])("rejects a job whose treasury or appeal authority is not the pinned next role %j", async change => {
    const f = nextFixture();
    const roles = Object.fromEntries(Object.entries(change).map(([key, value]) => [key, Cl.standardPrincipal(value)]));
    f.values["get-job"] = Cl.some(Cl.tuple({ ...f.job, ...roles }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("next_roles_mismatch");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("pins valid role addresses for both networks", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const { treasury, appealAuthority } = NAYORI_NEXT_ROLES[network];
      expect(validateStacksAddress(treasury) && validateStacksAddress(appealAuthority)).toBe(true);
      expect(treasury).not.toBe(appealAuthority);
    }
    expect(NAYORI_NEXT_ROLES.mainnet).toEqual({ treasury: "SMFE58EKCK5ZPD7YCYM1CQY7K3H8SEXQH7C3YT8S",
      appealAuthority: "SM3950RVR364J25ZRFFNHB5TCNJ7VKPKKGD4N2RP9" });
  });

  it.each([0, 999_999, 1_000_001])("rejects inconsistent escrow %i", async escrow => {
    const f = nextFixture(); f.values["get-escrow-balance"] = Cl.uint(escrow);
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("escrow_budget_mismatch");
  });

  it("rejects an existing decision", async () => {
    const f = nextFixture(); f.values["get-decision"] = Cl.some(Cl.tuple({ decision: Cl.uint(1) }));
    await expect(f.guard.assertEligible(f.request)).rejects.toThrow("decision_already_exists");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("does not route the current pair through the next-generation reads", async () => {
    const f = nextFixture();
    f.values["get-job"] = Cl.ok(Cl.tuple({ ...f.job, status: Cl.uint(2) }));
    await expect(f.guard.assertEligible({ ...f.request, contract: policy.stxContract })).rejects.toThrow();
    expect(f.read.mock.calls.map(([contract, name]) => [contract, name])).toEqual([[policy.stxContract, "get-job"]]);
  });

  it("checks committed manifests against the submission deliverable", async () => {
    const f = nextFixture("sbtc");
    const commitment = await prepareEvaluationSubmission({
      network: "testnet", asset: "sbtc", contract: f.request.contract, jobId: f.request.jobId,
      client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, description: f.request.job.description,
      acceptanceCriteria: f.request.acceptanceCriteria, evidence: f.request.evidence,
    });
    const request: EvaluationRequest = { ...f.request, commitmentVersion: "1",
      job: { ...f.request.job, description: commitment.description } };
    f.values["get-job"] = Cl.some(Cl.tuple({ ...f.job, description: Cl.stringAscii(commitment.description) }));
    await expect(f.guard.assertEligible(request)).rejects.toThrow("evidence_commitment_mismatch");
    f.values["get-submission"] = Cl.some(Cl.tuple({ ...f.submission, deliverable: Cl.buffer(commitment.deliverable) }));
    await expect(f.guard.assertEligible(request)).resolves.toBeUndefined();
    await expect(f.guard.assertEligible({ ...request, evidence: [{ ...request.evidence[0]!, sha256: "22".repeat(32) }] }))
      .rejects.toThrow("evidence_commitment_mismatch");
  });
});

describe("Next-generation job eligibility on mainnet", () => {
  const main = EVALUATOR_NETWORK_POLICIES.mainnet;
  const mainNext = nextEscrowContracts(NAYORI_NEXT_DEPLOYERS.mainnet);
  const contracts = { network: "mainnet" as const, stxContract: main.stxContract, sbtcContract: main.sbtcContract, next: mainNext };
  const request: EvaluationRequest = { evaluationId: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9",
    network: "mainnet", asset: "sbtc", contract: mainNext.sbtcContract, jobId: "3",
    job: { client: main.deployer, provider: main.treasury, evaluator: main.evaluator, description: "Verified evidence",
      status: "submitted", reviewDeadlineBurn: "900" },
    acceptanceCriteria: [{ id: "criterion", requirement: "JSON", verification: "Parse" }],
    evidence: [{ id: "report", uri: "https://example.com/report", sha256: "11".repeat(32), sizeBytes: 3, mediaType: "text/plain" }],
  };
  function guard(roles: { treasury: string; appealAuthority: string }) {
    const job = Cl.tuple({ client: Cl.standardPrincipal(main.deployer), evaluator: Cl.standardPrincipal(main.evaluator),
      provider: Cl.some(Cl.standardPrincipal(main.treasury)), treasury: Cl.standardPrincipal(roles.treasury),
      "appeal-authority": Cl.standardPrincipal(roles.appealAuthority), budget: Cl.uint(5_000),
      description: Cl.stringAscii(request.job.description), status: Cl.uint(4) });
    const values: Record<string, ClarityValue> = { "get-job": Cl.some(job),
      "get-submission": Cl.some(Cl.tuple({ deliverable: Cl.buffer(new Uint8Array(36)), "review-deadline": Cl.uint(900) })),
      "get-escrow-balance": Cl.uint(5_000), "get-decision": Cl.none() };
    const read = vi.fn(async (contract: string, fn: string) => {
      if (contract !== mainNext.sbtcContract || !values[fn]) throw Error("Unexpected read");
      return values[fn];
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ network_id: main.networkId, burn_block_height: 899 })));
    return new StacksEligibility({ contracts, evaluatorPrincipal: main.evaluator, apiUrl: main.apiUrl,
      fetch: fetchMock, readOnly: read });
  }

  it("accepts a submitted job on the pinned mainnet escrow with the multisig roles", async () => {
    await expect(guard(NAYORI_NEXT_ROLES.mainnet).assertEligible(request)).resolves.toBeUndefined();
  });

  it("rejects the testnet roles on mainnet", async () => {
    await expect(guard(NAYORI_NEXT_ROLES.testnet).assertEligible(request)).rejects.toThrow("next_roles_mismatch");
  });
});
