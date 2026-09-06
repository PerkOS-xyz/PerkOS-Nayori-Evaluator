import { describe, expect, it, vi } from "vitest";
import {
  evaluationRequestSchema,
  type EvaluationArtifact,
  type EvaluationRequest,
} from "../src/domain.js";
import { EvaluationBlockedError, EvaluationEngine } from "../src/evaluator.js";
import type { StructuredInference } from "../src/inference.js";
import { AllowlistedDecisionRecorder } from "../src/chain.js";
import { EvaluationCoordinator } from "../src/coordinator.js";
import type { EvaluationStore, StoredEvaluation } from "../src/store.js";

const STX_CONTRACT = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.agentic-commerce-v5";
const SBTC_CONTRACT = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v4";
const targetOptions = { contracts: { stxContract: STX_CONTRACT, sbtcContract: SBTC_CONTRACT }, evaluatorPrincipal: "ST1EVALUATOR" };

function request(overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    evaluationId: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9",
    network: "testnet",
    asset: "sbtc",
    contract: SBTC_CONTRACT,
    jobId: "7",
    job: {
      client: "ST1CLIENT",
      provider: "ST1PROVIDER",
      evaluator: "ST1EVALUATOR",
      status: "submitted",
      reviewDeadlineBurn: "12000",
      description: "Return a signed JSON market report.",
    },
    acceptanceCriteria: [
      {
        id: "valid-json",
        requirement: "The deliverable is valid JSON.",
        verification: "Parse the submitted document.",
      },
    ],
    evidence: [
      {
        id: "deliverable",
        uri: "https://evidence.example/report.json",
        sha256: "11".repeat(32),
        mediaType: "application/json",
        sizeBytes: 512,
      },
    ],
    ...overrides,
  };
}

const primary = {
  schemaVersion: "1" as const,
  decision: "approve" as const,
  confidence: 0.94,
  reasonCodes: ["all_criteria_met" as const],
  criteria: [
    {
      criterionId: "valid-json",
      outcome: "pass" as const,
      evidenceIds: ["deliverable"],
      summary: "The document parsed successfully.",
    },
  ],
  publicExplanation: "The submitted report satisfies the stated JSON requirement.",
};

const verifier = {
  schemaVersion: "1" as const,
  agrees: true,
  decision: "approve" as const,
  confidence: 0.91,
  reasonCodes: ["all_criteria_met" as const],
  summary: "The candidate decision is supported by the referenced evidence.",
};

function inferenceWith(...values: unknown[]): StructuredInference {
  let index = 0;
  return {
    complete: async ({ schema }) => schema.parse(values[index++]),
  };
}

describe("EvaluationEngine", () => {
  it("never sends a committed request to the model without verified content", async () => {
    const complete = vi.fn();
    const engine = new EvaluationEngine({ ...targetOptions, inference: { complete },
      primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
    await expect(engine.evaluate(request({ commitmentVersion: "1" }))).rejects.toThrow("verified_evidence_loader_required");
    expect(complete).not.toHaveBeenCalled();
  });
  it("blocks an approval whose criteria fail or cite unknown evidence", async () => {
    for (const change of [{ outcome: "fail" }, { evidenceIds: ["invented"] }, { evidenceIds: [] }]) {
      const engine = new EvaluationEngine({ ...targetOptions,
        inference: inferenceWith({ ...primary, criteria: [{ ...primary.criteria[0], ...change }] }),
        primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
      await expect(engine.evaluate(request())).rejects.toThrow("criterion_evidence_inconsistent");
    }
  });
  it("requires isolated testnet inputs and non-zero evidence digests", () => {
    expect(() =>
      evaluationRequestSchema.parse({ ...request(), network: "mainnet" })
    ).toThrow();
    expect(() =>
      evaluationRequestSchema.parse({
        ...request(),
        evidence: [{ ...request().evidence[0]!, sha256: "00".repeat(32) }],
      })
    ).toThrow("digest must be non-zero");
  });

  it("produces a public, deterministic artifact only after independent agreement", async () => {
    const engine = new EvaluationEngine({
      ...targetOptions,
      inference: inferenceWith(primary, verifier),
      primaryModel: "primary-model",
      verifierModel: "verifier-model",
      minimumConfidence: 0.85,
      now: () => new Date("2026-08-31T16:00:00.000Z"),
    });

    const artifact = await engine.evaluate(request());

    expect(artifact).toMatchObject({
      decision: "approve",
      confidence: 0.91,
      network: "testnet",
      contract: SBTC_CONTRACT,
      jobId: "7",
      createdAt: "2026-08-31T16:00:00.000Z",
    });
    expect(artifact.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.explanationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on verifier disagreement or low confidence", async () => {
    const disagreement = new EvaluationEngine({
      ...targetOptions,
      inference: inferenceWith(primary, { ...verifier, agrees: false }),
      primaryModel: "primary",
      verifierModel: "verifier",
      minimumConfidence: 0.85,
    });
    await expect(disagreement.evaluate(request())).rejects.toEqual(
      new EvaluationBlockedError("independent_verification_failed")
    );

    const lowConfidence = new EvaluationEngine({
      ...targetOptions,
      inference: inferenceWith({ ...primary, confidence: 0.5 }),
      primaryModel: "primary",
      verifierModel: "verifier",
      minimumConfidence: 0.85,
    });
    await expect(lowConfidence.evaluate(request())).rejects.toEqual(
      new EvaluationBlockedError("primary_confidence_below_policy")
    );
  });

  it("blocks missing criterion coverage before any chain action", async () => {
    const engine = new EvaluationEngine({
      ...targetOptions,
      inference: inferenceWith({ ...primary, criteria: [] }),
      primaryModel: "primary",
      verifierModel: "verifier",
      minimumConfidence: 0.85,
    });
    await expect(engine.evaluate(request())).rejects.toThrow();
  });
});

describe("AllowlistedDecisionRecorder", () => {
  it("exposes only record-decision on allowlisted Stacks testnet contracts", async () => {
    const execute = vi.fn(async (input) => ({
      txid: `0x${"ab".repeat(32)}`,
      network: input.network,
      contract: input.contract,
      jobId: input.jobId,
    }));
    const recorder = new AllowlistedDecisionRecorder({
      stxContract: STX_CONTRACT,
      sbtcContract: SBTC_CONTRACT,
      adapter: { execute },
    });
    const artifact: EvaluationArtifact = {
      evaluationId: request().evaluationId,
      network: "testnet",
      asset: "sbtc",
      contract: SBTC_CONTRACT,
      jobId: "7",
      decision: "approve",
      confidence: 0.91,
      reasonCodes: ["all_criteria_met"],
      publicExplanation: primary.publicExplanation,
      evidenceHash: "11".repeat(32),
      explanationHash: "22".repeat(32),
      schemaVersion: "1",
      policyVersion: "policy/1",
      promptVersion: "prompt/1",
      primaryModel: "primary",
      verifierModel: "verifier",
      createdAt: "2026-08-31T16:00:00.000Z",
    };

    await recorder.recordDecision(artifact);

    expect(execute).toHaveBeenCalledWith({
      network: "testnet",
      contract: SBTC_CONTRACT,
      functionName: "record-decision",
      jobId: "7",
      decision: "approve",
      evidenceHash: "11".repeat(32),
      explanationHash: "22".repeat(32),
    });
    await expect(
      recorder.recordDecision({ ...artifact, contract: "ST1EVIL.transfer" })
    ).rejects.toThrow("not allowlisted");
  });
});

describe("EvaluationCoordinator", () => {
  it("serializes claims and recovers the queue after a rejected task", async () => {
    const first = request();
    const second = request({ evaluationId: "af49cc54-0cba-4cf3-98d2-5e5c6965fab9", jobId: "8" });
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const engine = new EvaluationEngine({ ...targetOptions,
      inference: inferenceWith(), primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
    const stored: StoredEvaluation = { id: second.evaluationId, status: "blocked", request: second, updatedAt: "2026-09-06T00:00:00Z" };
    const store: EvaluationStore = {
      putQueued: vi.fn(async input => {
        if (input.evaluationId === first.evaluationId) { started(); await held; throw new Error("store unavailable"); }
      }),
      claim: vi.fn(async () => true), get: vi.fn(async () => stored),
      saveArtifact: vi.fn(), saveBroadcast: vi.fn(), saveBroadcastFailed: vi.fn(), saveBlocked: vi.fn(),
    };
    const recorder = { recordDecision: vi.fn() };
    const eligibility = { assertEligible: vi.fn(async () => { throw new EvaluationBlockedError("review_window_closed"); }) };
    const coordinator = new EvaluationCoordinator({ engine, store, recorder, eligibility, workerId: "test", leaseSeconds: 1338 });
    const failed = coordinator.process(first).catch(error => error as Error);
    await entered;
    const queued = coordinator.process(second);
    await Promise.resolve();
    expect(store.putQueued).toHaveBeenCalledTimes(1);
    expect(store.claim).not.toHaveBeenCalled();
    release();
    expect(await failed).toMatchObject({ message: "store unavailable" });
    expect((await queued).id).toBe(second.evaluationId);
    expect(store.claim).toHaveBeenCalledExactlyOnceWith(second.evaluationId, "test", 1338);
    expect(recorder.recordDecision).not.toHaveBeenCalled();
  });
  it.each(["before", "after"])("does not record a decision if eligibility fails %s inference", async phase => {
    const input = request();
    const engine = new EvaluationEngine({ ...targetOptions,
      inference: inferenceWith(primary, verifier), primaryModel: "primary", verifierModel: "verifier", minimumConfidence: 0.85 });
    const evaluate = vi.spyOn(engine, "evaluate");
    let stored: StoredEvaluation = { id: input.evaluationId, status: "queued", request: input, updatedAt: "2026-09-06T00:00:00Z" };
    const store: EvaluationStore = {
      putQueued: vi.fn(async () => undefined), claim: vi.fn(async () => true), get: vi.fn(async () => stored),
      saveArtifact: vi.fn(async () => undefined), saveBroadcast: vi.fn(async () => undefined),
      saveBroadcastFailed: vi.fn(async () => undefined),
      saveBlocked: vi.fn(async (_id, reason) => { stored = { ...stored, status: "blocked", blockedReason: reason }; }),
    };
    let calls = 0;
    const eligibility = { assertEligible: vi.fn(async () => {
      calls += 1;
      if (calls === (phase === "before" ? 1 : 2)) throw new EvaluationBlockedError("review_window_closed");
    }) };
    const recorder = { recordDecision: vi.fn() };
    const result = await new EvaluationCoordinator({ engine, store, recorder, eligibility, workerId: "test" }).process(input);
    expect(result.status).toBe("blocked"); expect(result.blockedReason).toBe("review_window_closed");
    expect(evaluate).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    expect(store.saveArtifact).not.toHaveBeenCalled(); expect(recorder.recordDecision).not.toHaveBeenCalled();
    expect(store.saveBroadcast).not.toHaveBeenCalled();
  });
  it("records a truthful terminal state when decision broadcast fails", async () => {
    const input = request();
    const engine = new EvaluationEngine({
      ...targetOptions,
      inference: inferenceWith(primary, verifier),
      primaryModel: "primary-model",
      verifierModel: "verifier-model",
      minimumConfidence: 0.85,
    });
    let stored: StoredEvaluation = {
      id: input.evaluationId,
      status: "queued",
      request: input,
      updatedAt: "2026-08-31T16:00:00.000Z",
    };
    const store: EvaluationStore = {
      putQueued: vi.fn(async () => undefined),
      get: vi.fn(async () => stored),
      claim: vi.fn(async () => true),
      saveArtifact: vi.fn(async (artifact) => {
        stored = { ...stored, status: "decision_ready", artifact };
      }),
      saveBroadcastFailed: vi.fn(async (_id, reason) => {
        stored = { ...stored, status: "broadcast_failed", blockedReason: reason };
      }),
      saveBlocked: vi.fn(async (_id, reason) => {
        stored = { ...stored, status: "blocked", blockedReason: reason };
      }),
      saveBroadcast: vi.fn(async (_id, txid) => {
        stored = { ...stored, status: "broadcast", txid };
      }),
    };
    const recorder = {
      recordDecision: vi.fn(async () => {
        throw new Error("testnet endpoint unavailable");
      }),
    };
    const coordinator = new EvaluationCoordinator({
      engine,
      store,
      recorder,
      eligibility: { assertEligible: vi.fn(async () => undefined) },
      workerId: "qa-worker-1",
    });

    const result = await coordinator.process(input);

    expect(result.status).toBe("broadcast_failed");
    expect(result.blockedReason).toBe("decision_broadcast_failed");
    expect(result.artifact?.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.saveBlocked).not.toHaveBeenCalled();
    expect(store.saveBroadcast).not.toHaveBeenCalled();
  });
});
