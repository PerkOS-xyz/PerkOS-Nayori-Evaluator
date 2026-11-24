import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cl, PostConditionMode, broadcastTransaction, fetchNonce, getAddressFromPrivateKey, makeContractCall } from "@stacks/transactions";
import { AllowlistedDecisionRecorder, StacksDecisionAdapter } from "../src/chain.js";
import {
  EVALUATOR_NETWORK_POLICIES,
  MAINNET_EVALUATOR_CONFIRMATION,
  MAINNET_NEXT_EVALUATOR_CONFIRMATION,
  NAYORI_NEXT_DEPLOYERS,
  nextEscrowContracts,
} from "../src/contracts.js";
import { nextDecisionEvidenceHash } from "../src/next-generation.js";
import { publicEvaluation } from "../src/public.js";
import { EvaluationEngine } from "../src/evaluator.js";
import type { EvaluationArtifact, EvaluationRequest } from "../src/domain.js";
import type { StoredEvaluation } from "../src/store.js";

vi.mock("@stacks/transactions", async importOriginal => ({
  ...await importOriginal<typeof import("@stacks/transactions")>(),
  fetchNonce: vi.fn(), makeContractCall: vi.fn(), broadcastTransaction: vi.fn(),
}));

const KEY = "11".repeat(32) + "01"; // Synthetic unit-test signer; never funded or used against a network.
const policy = EVALUATOR_NETWORK_POLICIES.testnet;
const NEXT_DEPLOYER = NAYORI_NEXT_DEPLOYERS.testnet;
const next = nextEscrowContracts(NEXT_DEPLOYER);
const current = { network: "testnet" as const, stxContract: policy.stxContract, sbtcContract: policy.sbtcContract };
const withNext = { ...current, next };

function adapter(contracts: typeof current | typeof withNext = withNext) {
  return new StacksDecisionAdapter({ contracts, apiUrl: policy.apiUrl, privateKey: KEY,
    evaluatorPrincipal: getAddressFromPrivateKey(KEY, "testnet"), fee: 5000 });
}
function input(contract: string = next.stxContract) {
  return { network: "testnet" as const, contract, functionName: "record-decision" as const, jobId: "7",
    decision: "approve" as const, evidenceHash: "22".repeat(32), explanationHash: "33".repeat(32) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchNonce).mockResolvedValue(0n);
  vi.mocked(makeContractCall).mockResolvedValue({} as Awaited<ReturnType<typeof makeContractCall>>);
  vi.mocked(broadcastTransaction).mockResolvedValue({ txid: "ab".repeat(32) });
});

describe("Next-generation decision evidence hash", () => {
  it("matches the documented preimage byte for byte", () => {
    const value = input();
    const preimage = "nayori/decision-evidence/v1\n" +
      `{"contract":"${value.contract}","decision":"approve","evidenceHash":"${"22".repeat(32)}",` +
      `"explanationHash":"${"33".repeat(32)}","jobId":"7","network":"testnet","schemaVersion":"1"}`;
    expect(nextDecisionEvidenceHash(value)).toBe(createHash("sha256").update(preimage, "utf8").digest("hex"));
  });

  it("is deterministic and binds the decision, job, contract and both hashes", () => {
    const base = nextDecisionEvidenceHash(input());
    expect(nextDecisionEvidenceHash(input())).toBe(base);
    for (const change of [{ decision: "reject" as const }, { jobId: "8" }, { contract: next.sbtcContract },
      { evidenceHash: "44".repeat(32) }, { explanationHash: "44".repeat(32) }]) {
      expect(nextDecisionEvidenceHash({ ...input(), ...change })).not.toBe(base);
    }
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).not.toBe("0".repeat(64));
  });

  it.each([{ evidenceHash: "AB".repeat(32) }, { explanationHash: "bad" }, { jobId: "0" },
    { decision: "manual_review" }])("rejects malformed input %j", change => {
    expect(() => nextDecisionEvidenceHash({ ...input(), ...change } as ReturnType<typeof input>)).toThrow();
  });
});

describe("Signing adapter for the next generation", () => {
  it.each(["stx", "sbtc"] as const)("calls record-decision on the %s escrow with one evidence hash", async asset => {
    const request = input(asset === "stx" ? next.stxContract : next.sbtcContract);
    const result = await adapter().execute(request);
    expect(result).toMatchObject({ network: "testnet", contract: request.contract, jobId: "7", txid: `0x${"ab".repeat(32)}` });
    expect(makeContractCall).toHaveBeenLastCalledWith(expect.objectContaining({
      contractAddress: NEXT_DEPLOYER, contractName: `nayori-escrow-${asset}`, functionName: "record-decision",
      functionArgs: [Cl.uint(7), Cl.uint(1), Cl.bufferFromHex(nextDecisionEvidenceHash(request))],
      postConditionMode: PostConditionMode.Deny, postConditions: [], fee: 5000n,
    }));
  });

  it("maps reject to u2", async () => {
    const request = { ...input(), decision: "reject" as const };
    await adapter().execute(request);
    expect(vi.mocked(makeContractCall).mock.lastCall?.[0].functionArgs[1]).toEqual(Cl.uint(2));
  });

  it("keeps the current two-hash call for the current pair", async () => {
    const request = input(policy.sbtcContract);
    await adapter().execute(request);
    expect(makeContractCall).toHaveBeenLastCalledWith(expect.objectContaining({
      functionArgs: [Cl.uint(7), Cl.uint(1), Cl.bufferFromHex(request.evidenceHash), Cl.bufferFromHex(request.explanationHash)],
    }));
  });

  it.each([
    { contract: `${policy.deployer}.nayori-escrow-stx` }, { contract: `${NEXT_DEPLOYER}.nayori-escrow-v2` },
    { evidenceHash: "00".repeat(32) }, { explanationHash: "bad" }, { decision: "manual_review" }, { jobId: "0" },
  ])("denies out-of-scope next input before nonce/sign/broadcast %j", async change => {
    const signer = adapter();
    await expect(signer.execute({ ...input(), ...change } as Parameters<typeof signer.execute>[0])).rejects.toThrow();
    expect(fetchNonce).not.toHaveBeenCalled();
    expect(makeContractCall).not.toHaveBeenCalled();
  });

  it("denies next escrows when the generation is not configured", async () => {
    await expect(adapter(current).execute(input())).rejects.toThrow("not allowlisted");
    expect(fetchNonce).not.toHaveBeenCalled();
  });

  describe("on mainnet", () => {
    const main = EVALUATOR_NETWORK_POLICIES.mainnet;
    const mainNext = nextEscrowContracts(NAYORI_NEXT_DEPLOYERS.mainnet);
    const mainContracts = { network: "mainnet" as const, stxContract: main.stxContract, sbtcContract: main.sbtcContract };
    function mainnetAdapter(confirmations: { current?: string; next?: string }, contracts: object = { ...mainContracts, next: mainNext }) {
      return new StacksDecisionAdapter({ contracts: contracts as typeof mainContracts, apiUrl: main.apiUrl, privateKey: KEY,
        evaluatorPrincipal: getAddressFromPrivateKey(KEY, "mainnet"), fee: 5000,
        ...(confirmations.current === undefined ? {} : { mainnetActivationConfirmation: confirmations.current }),
        ...(confirmations.next === undefined ? {} : { mainnetNextActivationConfirmation: confirmations.next }) });
    }

    it.each([
      {}, { current: MAINNET_EVALUATOR_CONFIRMATION }, { next: MAINNET_NEXT_EVALUATOR_CONFIRMATION },
      { current: MAINNET_EVALUATOR_CONFIRMATION, next: MAINNET_EVALUATOR_CONFIRMATION },
    ])("refuses to build a signer for the next escrows without both acknowledgements %j", confirmations => {
      expect(() => mainnetAdapter(confirmations)).toThrow(/activation/);
    });

    it("does not need the next acknowledgement when the generation is off", () => {
      expect(() => mainnetAdapter({ current: MAINNET_EVALUATOR_CONFIRMATION }, mainContracts)).not.toThrow();
    });

    it("refuses next escrows of any deployer other than the pinned one", () => {
      expect(() => mainnetAdapter({ current: MAINNET_EVALUATOR_CONFIRMATION, next: MAINNET_NEXT_EVALUATOR_CONFIRMATION },
        { ...mainContracts, next: nextEscrowContracts(main.deployer) })).toThrow();
    });

    it("calls record-decision on the pinned mainnet escrow with one evidence hash", async () => {
      const signer = mainnetAdapter({ current: MAINNET_EVALUATOR_CONFIRMATION, next: MAINNET_NEXT_EVALUATOR_CONFIRMATION });
      const request = { ...input(mainNext.sbtcContract), network: "mainnet" as const };
      await signer.execute(request);
      expect(makeContractCall).toHaveBeenLastCalledWith(expect.objectContaining({
        contractAddress: "SP2BM4WCNQM286PFHPGA1BG2YXER0PCG1PKQ5MF1X", contractName: "nayori-escrow-sbtc",
        functionName: "record-decision",
        functionArgs: [Cl.uint(7), Cl.uint(1), Cl.bufferFromHex(nextDecisionEvidenceHash(request))],
        postConditionMode: PostConditionMode.Deny, postConditions: [], fee: 5000n,
      }));
      await expect(signer.execute({ ...input(next.sbtcContract), network: "mainnet" })).rejects.toThrow("not allowlisted");
    });
  });

  it("recorder passes next artifacts only when configured", async () => {
    const execute = vi.fn().mockResolvedValue({ txid: "0x01", network: "testnet", contract: next.stxContract, jobId: "7" });
    const artifact = { ...input(), asset: "stx" } as unknown as EvaluationArtifact;
    await new AllowlistedDecisionRecorder({ ...withNext, adapter: { execute } }).recordDecision(artifact);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ contract: next.stxContract,
      evidenceHash: "22".repeat(32), explanationHash: "33".repeat(32) }));
    await expect(new AllowlistedDecisionRecorder({ ...current, adapter: { execute } }).recordDecision(artifact))
      .rejects.toThrow("not allowlisted");
    await expect(new AllowlistedDecisionRecorder({ ...withNext, adapter: { execute } })
      .recordDecision({ ...artifact, asset: "sbtc" })).rejects.toThrow("not allowlisted");
  });
});

describe("Next-generation pipeline and public record", () => {
  const request: EvaluationRequest = { evaluationId: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9", network: "testnet",
    asset: "sbtc", contract: next.sbtcContract, jobId: "1",
    job: { client: policy.deployer, provider: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", evaluator: policy.evaluator,
      status: "submitted", reviewDeadlineBurn: "100", description: "Return a JSON report." },
    acceptanceCriteria: [{ id: "json", requirement: "Return JSON", verification: "Parse JSON" }],
    evidence: [{ id: "report", uri: "https://example.com/report", sha256: "11".repeat(32), mediaType: "application/json", sizeBytes: 10 }],
  };

  async function evaluate(contracts: typeof current | typeof withNext) {
    const complete = vi.fn().mockResolvedValueOnce({ schemaVersion: "1", decision: "approve", confidence: 1,
      reasonCodes: ["all_criteria_met"], criteria: [{ criterionId: "json", outcome: "pass", evidenceIds: ["report"], summary: "Valid" }],
      publicExplanation: "Report is valid." }).mockResolvedValueOnce({ schemaVersion: "1", agrees: true,
      decision: "approve", confidence: 1, reasonCodes: ["all_criteria_met"], summary: "Verified" });
    const engine = new EvaluationEngine({ contracts, evaluatorPrincipal: policy.evaluator, inference: { complete },
      primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
    return { artifact: await engine.evaluate(request), complete };
  }

  it("runs the existing two-model pipeline for a configured next escrow", async () => {
    const { artifact, complete } = await evaluate(withNext);
    expect(artifact).toMatchObject({ contract: next.sbtcContract, decision: "approve" });
    expect(complete).toHaveBeenCalledTimes(2);
    const record: StoredEvaluation = { id: request.evaluationId, status: "broadcast", request, artifact,
      txid: "0x01", updatedAt: "2026-11-17T00:00:00.000Z" };
    expect(publicEvaluation(record)).toMatchObject({ evidenceHash: artifact.evidenceHash,
      explanationHash: artifact.explanationHash, onChainEvidenceHash: nextDecisionEvidenceHash(artifact) });
  });

  it("refuses next escrows before inference when the generation is off", async () => {
    await expect(evaluate(current)).rejects.toThrow("asset_contract_mismatch");
  });

  it("keeps the current public record unchanged", () => {
    const artifact = { ...input(policy.stxContract), asset: "stx" } as unknown as EvaluationArtifact;
    const record: StoredEvaluation = { id: request.evaluationId, status: "broadcast",
      request: { ...request, asset: "stx", contract: policy.stxContract }, artifact, updatedAt: "2026-11-17T00:00:00.000Z" };
    expect(publicEvaluation(record)).not.toHaveProperty("onChainEvidenceHash");
  });
});
