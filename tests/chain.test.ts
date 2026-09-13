import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cl, PostConditionMode, broadcastTransaction, fetchNonce, getAddressFromPrivateKey, makeContractCall } from "@stacks/transactions";
import { AllowlistedDecisionRecorder, StacksDecisionAdapter } from "../src/chain.js";
import { EVALUATOR_NETWORK_POLICIES, type StacksNetworkName } from "../src/contracts.js";
import type { EvaluationArtifact } from "../src/domain.js";

vi.mock("@stacks/transactions", async importOriginal => ({
  ...await importOriginal<typeof import("@stacks/transactions")>(),
  fetchNonce: vi.fn(), makeContractCall: vi.fn(), broadcastTransaction: vi.fn(),
}));

const KEY = "11".repeat(32) + "01"; // Synthetic unit-test signer; never funded or used against a network.
function contracts(network: StacksNetworkName) {
  const policy = EVALUATOR_NETWORK_POLICIES[network];
  return { network, stxContract: policy.stxContract, sbtcContract: policy.sbtcContract };
}
function opts(network: StacksNetworkName) {
  return { contracts: contracts(network), apiUrl: EVALUATOR_NETWORK_POLICIES[network].apiUrl, privateKey: KEY,
    evaluatorPrincipal: getAddressFromPrivateKey(KEY, network), fee: 5000 };
}
function input(network: StacksNetworkName, asset: "stx" | "sbtc" = "stx") {
  const pair = contracts(network);
  return { network, contract: asset === "stx" ? pair.stxContract : pair.sbtcContract,
    functionName: "record-decision" as const, jobId: "7", decision: "approve" as const,
    evidenceHash: "22".repeat(32), explanationHash: "33".repeat(32) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchNonce).mockResolvedValue(0n);
  vi.mocked(makeContractCall).mockResolvedValue({} as Awaited<ReturnType<typeof makeContractCall>>);
  vi.mocked(broadcastTransaction).mockResolvedValue({ txid: "ab".repeat(32) });
});

describe("Signing adapter independently enforces the network matrix", () => {
  it.each(["testnet", "mainnet"] as const)("permits only deny-mode decisions on %s", async network => {
    for (const asset of ["stx", "sbtc"] as const) {
      const adapter = new StacksDecisionAdapter(opts(network));
      const request = input(network, asset);
      const result = await adapter.execute(request);
      expect(result).toMatchObject({ network, contract: request.contract, jobId: "7", txid: `0x${"ab".repeat(32)}` });
      expect(makeContractCall).toHaveBeenLastCalledWith(expect.objectContaining({
        functionName: "record-decision", nonce: 0n, fee: 5000n,
        functionArgs: [Cl.uint(7), Cl.uint(1), Cl.bufferFromHex(request.evidenceHash), Cl.bufferFromHex(request.explanationHash)],
        postConditionMode: PostConditionMode.Deny, postConditions: [],
        network: expect.objectContaining({ chainId: EVALUATOR_NETWORK_POLICIES[network].networkId }),
      }));
    }
    expect(broadcastTransaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    { network: "mainnet" }, { functionName: "finalize-decision" }, { functionName: "waive-service-fee" },
    { functionName: "refund-service-fee" }, { contract: `${EVALUATOR_NETWORK_POLICIES.testnet.deployer}.unreviewed` },
    { contract: EVALUATOR_NETWORK_POLICIES.mainnet.stxContract },
    { jobId: "0" }, { jobId: "-1" }, { jobId: (2n ** 128n).toString() },
    { decision: "manual_review" }, { evidenceHash: "00".repeat(32) }, { explanationHash: "bad" },
  ])("denies malformed/out-of-scope input before nonce/sign/broadcast %j", async change => {
    const adapter = new StacksDecisionAdapter(opts("testnet"));
    await expect(adapter.execute({ ...input("testnet"), ...change } as Parameters<typeof adapter.execute>[0])).rejects.toThrow();
    expect(fetchNonce).not.toHaveBeenCalled();
    expect(makeContractCall).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it("rejects crossed API, pair and signer configurations", () => {
    expect(() => new StacksDecisionAdapter({ ...opts("testnet"), apiUrl: EVALUATOR_NETWORK_POLICIES.mainnet.apiUrl })).toThrow();
    expect(() => new StacksDecisionAdapter({ ...opts("testnet"), contracts: contracts("mainnet") })).toThrow();
    expect(() => new StacksDecisionAdapter({ ...opts("mainnet"), evaluatorPrincipal: getAddressFromPrivateKey(KEY, "testnet") })).toThrow();
  });

  it.each([{ fee: 100001 }, { fee: 999 }, { fee: 1000.5 }])("rejects unsafe fee %j", change => {
    expect(() => new StacksDecisionAdapter({ ...opts("testnet"), ...change })).toThrow();
  });

  it("does not rebroadcast on an ambiguous network failure", async () => {
    vi.mocked(broadcastTransaction).mockRejectedValue(new Error("timeout"));
    await expect(new StacksDecisionAdapter(opts("mainnet")).execute(input("mainnet"))).rejects.toThrow("timeout");
    expect(broadcastTransaction).toHaveBeenCalledOnce();
  });

  it("recorder rejects asset or network substitution", async () => {
    const execute = vi.fn();
    const recorder = new AllowlistedDecisionRecorder({ ...contracts("mainnet"), adapter: { execute } });
    const artifact = { ...input("mainnet"), asset: "sbtc" } as unknown as EvaluationArtifact;
    await expect(recorder.recordDecision(artifact)).rejects.toThrow("not allowlisted");
    await expect(recorder.recordDecision({ ...artifact, network: "testnet" })).rejects.toThrow("not allowlisted");
    expect(execute).not.toHaveBeenCalled();
  });
});
