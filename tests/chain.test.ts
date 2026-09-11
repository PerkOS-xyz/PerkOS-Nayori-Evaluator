import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cl, PostConditionMode, broadcastTransaction, fetchNonce, getAddressFromPrivateKey, makeContractCall } from "@stacks/transactions";
import { AllowlistedDecisionRecorder, StacksTestnetDecisionAdapter } from "../src/chain.js";
import type { EvaluationArtifact } from "../src/domain.js";

vi.mock("@stacks/transactions", async importOriginal => ({
  ...await importOriginal<typeof import("@stacks/transactions")>(),
  fetchNonce: vi.fn(), makeContractCall: vi.fn(), broadcastTransaction: vi.fn(),
}));
const DEPLOYER = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5";
const KEY = "11".repeat(32) + "01"; // Synthetic unit-test signer; never funded or used against a network.
const contracts = (fees = true) => ({ stxContract: `${DEPLOYER}.agentic-commerce-v${fees ? 6 : 5}`,
  sbtcContract: `${DEPLOYER}.sbtc-commerce-v${fees ? 5 : 4}` });
const opts = () => ({ contracts: contracts(), apiUrl: "https://api.testnet.hiro.so", privateKey: KEY,
  evaluatorPrincipal: getAddressFromPrivateKey(KEY, "testnet"), fee: 5000 });
const input = () => ({ network: "testnet" as const, contract: contracts().stxContract,
  functionName: "record-decision" as const, jobId: "7", decision: "approve" as const,
  evidenceHash: "22".repeat(32), explanationHash: "33".repeat(32) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchNonce).mockResolvedValue(0n);
  vi.mocked(makeContractCall).mockResolvedValue({} as Awaited<ReturnType<typeof makeContractCall>>);
  vi.mocked(broadcastTransaction).mockResolvedValue({ txid: "ab".repeat(32) });
});
describe("Signing adapter independently enforces the generation boundary", () => {
  it.each([[false, "stx"], [false, "sbtc"], [true, "stx"], [true, "sbtc"]] as const)(
    "permits only a deny-mode decision for fees=%s asset=%s", async (fees, asset) => {
      const pair = contracts(fees);
      const adapter = new StacksTestnetDecisionAdapter({ ...opts(), contracts: pair });
      const contract = asset === "stx" ? pair.stxContract : pair.sbtcContract;
      const result = await adapter.execute({ ...input(), contract });
      expect(result).toMatchObject({ network: "testnet", contract, jobId: "7", txid: `0x${"ab".repeat(32)}` });
      expect(makeContractCall).toHaveBeenCalledWith(expect.objectContaining({
        functionName: "record-decision", nonce: 0n, fee: 5000n,
        functionArgs: [Cl.uint(7), Cl.uint(1), Cl.bufferFromHex(input().evidenceHash), Cl.bufferFromHex(input().explanationHash)],
        postConditionMode: PostConditionMode.Deny, postConditions: [],
        network: expect.objectContaining({ chainId: 2147483648 }),
      }));
      expect(broadcastTransaction).toHaveBeenCalledOnce();
    });
  it.each([
    { network: "mainnet" }, { functionName: "finalize-decision" }, { functionName: "waive-service-fee" },
    { functionName: "refund-service-fee" }, { contract: `${DEPLOYER}.unreviewed` },
    { contract: contracts(false).stxContract }, { contract: `ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9.agentic-commerce-v6` },
    { jobId: "0" }, { jobId: "-1" }, { jobId: (2n ** 128n).toString() },
    { decision: "manual_review" }, { evidenceHash: "00".repeat(32) }, { explanationHash: "bad" },
  ])("denies malformed/out-of-scope input before nonce/sign/broadcast %j", async change => {
    const adapter = new StacksTestnetDecisionAdapter(opts());
    await expect(adapter.execute({ ...input(), ...change } as Parameters<typeof adapter.execute>[0])).rejects.toThrow();
    expect(fetchNonce).not.toHaveBeenCalled(); expect(makeContractCall).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });
  it.each([{ apiUrl: "https://api.hiro.so" }, { fee: 100001 }, { fee: 999 }, { fee: 1000.5 },
    { evaluatorPrincipal: DEPLOYER }])("rejects unsafe adapter configuration %j", change => {
    expect(() => new StacksTestnetDecisionAdapter({ ...opts(), ...change })).toThrow();
  });
  it("does not rebroadcast on an ambiguous network failure", async () => {
    vi.mocked(broadcastTransaction).mockRejectedValue(new Error("timeout"));
    await expect(new StacksTestnetDecisionAdapter(opts()).execute(input())).rejects.toThrow("timeout");
    expect(broadcastTransaction).toHaveBeenCalledOnce();
  });
  it("recorder rejects an asset/contract substitution even when both contracts are configured", async () => {
    const execute = vi.fn();
    const recorder = new AllowlistedDecisionRecorder({ ...contracts(), adapter: { execute } });
    const artifact = { ...input(), asset: "sbtc" } as unknown as EvaluationArtifact;
    await expect(recorder.recordDecision(artifact)).rejects.toThrow("not allowlisted");
    expect(execute).not.toHaveBeenCalled();
  });
});
