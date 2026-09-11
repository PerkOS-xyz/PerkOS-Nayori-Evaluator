import { describe, expect, it, vi } from "vitest";
import { evaluationLeaseSeconds, loadConfig, safeConfig } from "../src/config.js";
import { commerceContractsSchema, isTestnetApiUrl, matchesTarget } from "../src/contracts.js";
import { EvaluationEngine } from "../src/evaluator.js";
import type { EvaluationRequest } from "../src/domain.js";

export const DEPLOYER = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5";
export const EVALUATOR = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4";
export const CLIENT = DEPLOYER;
export const PROVIDER = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
export const TREASURY = "ST1E7E64H8VSSSGE0RPWF90RRC91MQG7CRQRM1BFX";
export const AUTHORITY = "ST256E5DAXM7RDFZ76ECCTPTBYHRXXJQ29H16DN69";
export function contracts(fees = false) {
  return { stxContract: `${DEPLOYER}.agentic-commerce-v${fees ? 6 : 5}`,
    sbtcContract: `${DEPLOYER}.sbtc-commerce-v${fees ? 5 : 4}` };
}
export function input(asset: "stx" | "sbtc" = "stx", fees = false): EvaluationRequest {
  return {
    evaluationId: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9", network: "testnet", asset,
    contract: asset === "stx" ? contracts(fees).stxContract : contracts(fees).sbtcContract, jobId: "1",
    job: { client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, status: "submitted",
      reviewDeadlineBurn: "100", description: "Return a JSON report." },
    acceptanceCriteria: [{ id: "json", requirement: "Return JSON", verification: "Parse JSON" }],
    evidence: [{ id: "report", uri: "https://example.com/report", sha256: "11".repeat(32),
      mediaType: "application/json", sizeBytes: 10 }],
  };
}
const env = {
  STACKS_NETWORK: "testnet", STX_COMMERCE_CONTRACT: contracts().stxContract,
  SBTC_COMMERCE_CONTRACT: contracts().sbtcContract, EVALUATOR_PRINCIPAL: EVALUATOR,
  EVALUATOR_PRIVATE_KEY: "test-placeholder-".repeat(5), EVALUATOR_API_KEY: "test-api-placeholder-".repeat(3),
  HERMES_API_BASE_URL: "https://example.com", HERMES_API_KEY: "test-hermes-placeholder-".repeat(3),
  PRIMARY_MODEL: "primary", VERIFIER_MODEL: "verifier", DATABASE_URL: "postgresql://localhost/test",
};

describe("Explicit generation selection", () => {
  it("sizes the single-worker lease for two models and both schema repairs", () => {
    expect(evaluationLeaseSeconds({ INFERENCE_TIMEOUT_MS: 240000 })).toBe(1338);
    expect(evaluationLeaseSeconds({ INFERENCE_TIMEOUT_MS: 600000 })).toBe(2778);
  });
  it.each([false, true])("accepts the complete reviewed pair; fees=%s", fees => {
    const pair = contracts(fees);
    const config = loadConfig({ ...env, STX_COMMERCE_CONTRACT: pair.stxContract, SBTC_COMMERCE_CONTRACT: pair.sbtcContract });
    expect(safeConfig(config).earnedServiceFeeBps).toBe(fees ? 200 : 0);
    expect(JSON.stringify(safeConfig(config))).not.toContain(env.EVALUATOR_PRIVATE_KEY);
    expect(JSON.stringify(safeConfig(config))).not.toContain(env.HERMES_API_KEY);
  });
  it.each([
    { ...contracts(), sbtcContract: contracts(true).sbtcContract },
    { ...contracts(true), stxContract: contracts().stxContract },
    { ...contracts(), stxContract: `${DEPLOYER}.agentic-commerce-v99` },
    { ...contracts(), sbtcContract: `${PROVIDER}.sbtc-commerce-v4` },
    { ...contracts(), stxContract: "ST1INVALID.agentic-commerce-v5" },
    { ...contracts(), stxContract: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.agentic-commerce-v5" },
  ])("rejects unreviewed/mixed pairs %j", pair => {
    expect(() => commerceContractsSchema.parse(pair)).toThrow();
    expect(() => loadConfig({ ...env, STX_COMMERCE_CONTRACT: pair.stxContract, SBTC_COMMERCE_CONTRACT: pair.sbtcContract })).toThrow();
  });
  it("rejects mainnet and invalid signer principals", () => {
    expect(() => loadConfig({ ...env, STACKS_NETWORK: "mainnet" })).toThrow();
    expect(() => loadConfig({ ...env, EVALUATOR_PRINCIPAL: "ST1INVALID" })).toThrow();
  });
  it.each(["https://api.hiro.so", "https://api.testnet.hiro.so.evil.test", "http://api.testnet.hiro.so",
    "https://user:pass@api.testnet.hiro.so", "https://api.testnet.hiro.so/path", "https://api.testnet.hiro.so?x=1"])("rejects non-testnet API %s", url => {
    expect(isTestnetApiUrl(url)).toBe(false);
    expect(() => loadConfig({ ...env, STACKS_API_URL: url })).toThrow();
  });
  it("accepts canonical origin with optional trailing slash", () => {
    expect(isTestnetApiUrl("https://api.testnet.hiro.so")).toBe(true);
    expect(isTestnetApiUrl("https://api.testnet.hiro.so/")).toBe(true);
  });
});

describe("Engine exact target before inference", () => {
  it.each([false, true])("supports STX and sBTC of selected generation; fees=%s", async fees => {
    for (const asset of ["stx", "sbtc"] as const) {
      const complete = vi.fn().mockResolvedValueOnce({ schemaVersion: "1", decision: "approve", confidence: 1,
        reasonCodes: ["all_criteria_met"], criteria: [{ criterionId: "json", outcome: "pass", evidenceIds: ["report"], summary: "Valid" }],
        publicExplanation: "Report is valid." }).mockResolvedValueOnce({ schemaVersion: "1", agrees: true,
        decision: "approve", confidence: 1, reasonCodes: ["all_criteria_met"], summary: "Verified" });
      const engine = new EvaluationEngine({ contracts: contracts(fees), evaluatorPrincipal: EVALUATOR,
        inference: { complete }, primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
      expect((await engine.evaluate(input(asset, fees))).contract).toBe(input(asset, fees).contract);
      expect(complete).toHaveBeenCalledTimes(2);
    }
  });
  it.each(["foreign-deployer", "wrong-generation", "wrong-asset", "wrong-evaluator"])("rejects %s before spending on inference", async kind => {
    const req = input("stx", true);
    const target = { ...req, ...(kind === "foreign-deployer" ? { contract: `${PROVIDER}.agentic-commerce-v6` } : {}),
      ...(kind === "wrong-generation" ? { contract: contracts().stxContract } : {}),
      ...(kind === "wrong-asset" ? { asset: "sbtc" } : {}),
      ...(kind === "wrong-evaluator" ? { job: { ...req.job, evaluator: AUTHORITY } } : {}) };
    const complete = vi.fn();
    const engine = new EvaluationEngine({ contracts: contracts(true), evaluatorPrincipal: EVALUATOR,
      inference: { complete }, primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
    await expect(engine.evaluate(target)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
  it("does not match an unknown asset or mainnet even with the configured contract", () => {
    expect(matchesTarget(contracts(), { ...input(), asset: "usdcx" })).toBe(false);
    expect(matchesTarget(contracts(), { ...input(), network: "mainnet" })).toBe(false);
  });
});
