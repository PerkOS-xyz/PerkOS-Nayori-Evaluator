import { describe, expect, it, vi } from "vitest";
import { evaluationLeaseSeconds, loadConfig, safeConfig } from "../src/config.js";
import {
  EVALUATOR_NETWORK_POLICIES,
  MAINNET_EVALUATOR_CONFIRMATION,
  commerceContractsSchema,
  isCanonicalApiUrl,
  matchesTarget,
  type StacksNetworkName,
} from "../src/contracts.js";
import { EvaluationEngine } from "../src/evaluator.js";
import type { EvaluationRequest } from "../src/domain.js";

export const DEPLOYER = EVALUATOR_NETWORK_POLICIES.testnet.deployer;
export const EVALUATOR = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4";
export const CLIENT = DEPLOYER;
export const PROVIDER = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
export const TREASURY = "ST1E7E64H8VSSSGE0RPWF90RRC91MQG7CRQRM1BFX";
export const AUTHORITY = "ST256E5DAXM7RDFZ76ECCTPTBYHRXXJQ29H16DN69";

export function contracts(network: StacksNetworkName = "testnet") {
  const policy = EVALUATOR_NETWORK_POLICIES[network];
  return { network, stxContract: policy.stxContract, sbtcContract: policy.sbtcContract };
}

function roles(network: StacksNetworkName) {
  return network === "testnet"
    ? { client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR }
    : { client: EVALUATOR_NETWORK_POLICIES.mainnet.deployer,
        provider: EVALUATOR_NETWORK_POLICIES.mainnet.treasury,
        evaluator: EVALUATOR_NETWORK_POLICIES.mainnet.appealAuthority };
}

export function input(network: StacksNetworkName = "testnet", asset: "stx" | "sbtc" = "stx"): EvaluationRequest {
  const pair = contracts(network);
  const actor = roles(network);
  return {
    evaluationId: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9", network, asset,
    contract: asset === "stx" ? pair.stxContract : pair.sbtcContract, jobId: "1",
    job: { ...actor, status: "submitted", reviewDeadlineBurn: "100", description: "Return a JSON report." },
    acceptanceCriteria: [{ id: "json", requirement: "Return JSON", verification: "Parse JSON" }],
    evidence: [{ id: "report", uri: "https://example.com/report", sha256: "11".repeat(32),
      mediaType: "application/json", sizeBytes: 10 }],
  };
}

function env(network: StacksNetworkName) {
  const policy = EVALUATOR_NETWORK_POLICIES[network];
  return {
    EVALUATOR_ENV: policy.environment,
    STACKS_NETWORK: network,
    STX_COMMERCE_CONTRACT: policy.stxContract,
    SBTC_COMMERCE_CONTRACT: policy.sbtcContract,
    EVALUATOR_PRINCIPAL: roles(network).evaluator,
    EVALUATOR_PRIVATE_KEY: "test-placeholder-".repeat(5),
    EVALUATOR_API_KEY: "test-api-placeholder-".repeat(3),
    HERMES_API_BASE_URL: "https://example.com",
    HERMES_API_KEY: "test-hermes-placeholder-".repeat(3),
    PRIMARY_MODEL: "primary",
    VERIFIER_MODEL: "verifier",
    DATABASE_URL: "postgresql://localhost/test",
    STACKS_API_URL: policy.apiUrl,
    CONFIRM_MAINNET_EVALUATOR: network === "mainnet" ? MAINNET_EVALUATOR_CONFIRMATION : "",
  };
}

describe("Fail-closed network matrix", () => {
  it("sizes the single-worker lease for two models and both schema repairs", () => {
    expect(evaluationLeaseSeconds({ INFERENCE_TIMEOUT_MS: 240000 })).toBe(1338);
    expect(evaluationLeaseSeconds({ INFERENCE_TIMEOUT_MS: 600000 })).toBe(2778);
  });

  it.each(["testnet", "mainnet"] as const)("accepts only the exact %s release tuple", network => {
    const config = loadConfig(env(network));
    expect(safeConfig(config).earnedServiceFeeBps).toBe(200);
    expect(safeConfig(config).commerceGeneration).toBe("service-fee-v6-v5");
    expect(safeConfig(config).mainnetBroadcastEnabled).toBe(network === "mainnet");
    expect(JSON.stringify(safeConfig(config))).not.toContain(env(network).EVALUATOR_PRIVATE_KEY);
    expect(JSON.stringify(safeConfig(config))).not.toContain(env(network).HERMES_API_KEY);
  });

  it.each([
    { network: "testnet", stxContract: EVALUATOR_NETWORK_POLICIES.mainnet.stxContract,
      sbtcContract: EVALUATOR_NETWORK_POLICIES.mainnet.sbtcContract },
    { network: "mainnet", stxContract: EVALUATOR_NETWORK_POLICIES.testnet.stxContract,
      sbtcContract: EVALUATOR_NETWORK_POLICIES.testnet.sbtcContract },
    { ...contracts("testnet"), stxContract: `${DEPLOYER}.agentic-commerce-v5` },
    { ...contracts("mainnet"), sbtcContract: `${EVALUATOR_NETWORK_POLICIES.mainnet.deployer}.sbtc-commerce-v4` },
  ])("rejects crossed, mixed or unreviewed contract tuple %j", pair => {
    expect(() => commerceContractsSchema.parse(pair)).toThrow();
  });

  it("rejects environment, API and principal combinations from the other network", () => {
    expect(() => loadConfig({ ...env("testnet"), EVALUATOR_ENV: "production" })).toThrow();
    expect(() => loadConfig({ ...env("mainnet"), EVALUATOR_ENV: "qa" })).toThrow();
    expect(() => loadConfig({ ...env("testnet"), STACKS_API_URL: EVALUATOR_NETWORK_POLICIES.mainnet.apiUrl })).toThrow();
    expect(() => loadConfig({ ...env("mainnet"), EVALUATOR_PRINCIPAL: EVALUATOR })).toThrow();
  });

  it("requires the exact explicit activation only for mainnet", () => {
    expect(() => loadConfig({ ...env("mainnet"), CONFIRM_MAINNET_EVALUATOR: "" })).toThrow();
    expect(() => loadConfig({ ...env("mainnet"), CONFIRM_MAINNET_EVALUATOR: "yes" })).toThrow();
    expect(() => loadConfig({ ...env("testnet"), CONFIRM_MAINNET_EVALUATOR: "" })).not.toThrow();
  });

  it.each([
    "https://api.testnet.hiro.so.evil.test",
    "http://api.testnet.hiro.so",
    "https://user:pass@api.testnet.hiro.so",
    "https://api.testnet.hiro.so/path",
    "https://api.hiro.so?x=1",
  ])("rejects noncanonical API %s", url => {
    expect(isCanonicalApiUrl("testnet", url)).toBe(false);
    expect(isCanonicalApiUrl("mainnet", url)).toBe(false);
  });

  it("accepts canonical origins with an optional trailing slash", () => {
    expect(isCanonicalApiUrl("testnet", "https://api.testnet.hiro.so/")).toBe(true);
    expect(isCanonicalApiUrl("mainnet", "https://api.hiro.so/")).toBe(true);
  });

  it("pins private evidence to the matching Nayori environment", () => {
    expect(() => loadConfig({ ...env("testnet"), PRIVATE_EVIDENCE_ENABLED: "true",
      PRIVATE_EVIDENCE_ORIGIN: "https://api.qa.nayori.ai", PRIVATE_EVIDENCE_OAUTH_CLIENT_FILE: "/run/secrets/oauth.json" })).not.toThrow();
    expect(() => loadConfig({ ...env("mainnet"), PRIVATE_EVIDENCE_ENABLED: "true",
      PRIVATE_EVIDENCE_ORIGIN: "https://api.qa.nayori.ai", PRIVATE_EVIDENCE_OAUTH_CLIENT_FILE: "/run/secrets/oauth.json" })).toThrow();
    expect(() => loadConfig({ ...env("mainnet"), PRIVATE_EVIDENCE_ENABLED: "true",
      PRIVATE_EVIDENCE_ORIGIN: "https://api.nayori.ai", PRIVATE_EVIDENCE_OAUTH_CLIENT_FILE: "/run/secrets/oauth.json" })).toThrow();
  });
});

describe("Engine exact target before inference", () => {
  it.each(["testnet", "mainnet"] as const)("supports STX and sBTC on %s", async network => {
    for (const asset of ["stx", "sbtc"] as const) {
      const complete = vi.fn().mockResolvedValueOnce({ schemaVersion: "1", decision: "approve", confidence: 1,
        reasonCodes: ["all_criteria_met"], criteria: [{ criterionId: "json", outcome: "pass", evidenceIds: ["report"], summary: "Valid" }],
        publicExplanation: "Report is valid." }).mockResolvedValueOnce({ schemaVersion: "1", agrees: true,
        decision: "approve", confidence: 1, reasonCodes: ["all_criteria_met"], summary: "Verified" });
      const actor = roles(network);
      const engine = new EvaluationEngine({ contracts: contracts(network), evaluatorPrincipal: actor.evaluator,
        inference: { complete }, primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
      expect((await engine.evaluate(input(network, asset))).contract).toBe(input(network, asset).contract);
      expect(complete).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects cross-network and asset substitution before inference", async () => {
    const complete = vi.fn();
    const engine = new EvaluationEngine({ contracts: contracts("mainnet"), evaluatorPrincipal: roles("mainnet").evaluator,
      inference: { complete }, primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
    await expect(engine.evaluate(input("testnet"))).rejects.toThrow();
    await expect(engine.evaluate({ ...input("mainnet"), asset: "sbtc" })).rejects.toThrow("asset_contract_mismatch");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not match unknown assets or a crossed network", () => {
    expect(matchesTarget(contracts("testnet"), { ...input("testnet"), asset: "usdcx" })).toBe(false);
    expect(matchesTarget(contracts("testnet"), { ...input("testnet"), network: "mainnet" })).toBe(false);
  });
});
