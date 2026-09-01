import {
  evaluationRequestSchema,
  modelDecisionSchema,
  verificationSchema,
  type EvaluationArtifact,
  type EvaluationRequest,
} from "./domain.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { StructuredInference } from "./inference.js";
import {
  POLICY_VERSION,
  PRIMARY_PROMPT_VERSION,
  VERIFIER_PROMPT_VERSION,
  primaryMessages,
  verifierMessages,
} from "./prompts.js";

export class EvaluationBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`Evaluation blocked: ${reason}`);
    this.name = "EvaluationBlockedError";
  }
}

export interface EvaluationEngineOptions {
  readonly inference: StructuredInference;
  readonly primaryModel: string;
  readonly verifierModel: string;
  readonly minimumConfidence: number;
  readonly now?: () => Date;
}

export class EvaluationEngine {
  private readonly inference: StructuredInference;
  private readonly primaryModel: string;
  private readonly verifierModel: string;
  private readonly minimumConfidence: number;
  private readonly now: () => Date;

  constructor(options: EvaluationEngineOptions) {
    this.inference = options.inference;
    this.primaryModel = options.primaryModel;
    this.verifierModel = options.verifierModel;
    this.minimumConfidence = options.minimumConfidence;
    this.now = options.now ?? (() => new Date());
  }

  async evaluate(rawRequest: unknown, signal?: AbortSignal): Promise<EvaluationArtifact> {
    const request = evaluationRequestSchema.parse(rawRequest);
    this.validateDeterministically(request);

    const primary = await this.inference.complete({
      model: this.primaryModel,
      messages: primaryMessages(request),
      schema: modelDecisionSchema,
      sessionId: `nayori:${request.evaluationId}:primary`,
      idempotencyKey: `${request.evaluationId}:primary`,
      ...(signal ? { signal } : {}),
    });
    if (primary.decision === "manual_review") {
      throw new EvaluationBlockedError("primary_manual_review");
    }
    if (primary.confidence < this.minimumConfidence) {
      throw new EvaluationBlockedError("primary_confidence_below_policy");
    }
    this.validateCriterionCoverage(request, primary.criteria.map((item) => item.criterionId));

    const verification = await this.inference.complete({
      model: this.verifierModel,
      messages: verifierMessages(request, primary),
      schema: verificationSchema,
      sessionId: `nayori:${request.evaluationId}:verifier`,
      idempotencyKey: `${request.evaluationId}:verifier`,
      ...(signal ? { signal } : {}),
    });
    if (
      !verification.agrees ||
      verification.decision === "manual_review" ||
      verification.decision !== primary.decision ||
      verification.confidence < this.minimumConfidence
    ) {
      throw new EvaluationBlockedError("independent_verification_failed");
    }

    return {
      evaluationId: request.evaluationId,
      network: request.network,
      asset: request.asset,
      contract: request.contract,
      jobId: request.jobId,
      decision: primary.decision,
      confidence: Math.min(primary.confidence, verification.confidence),
      reasonCodes: primary.reasonCodes,
      publicExplanation: primary.publicExplanation,
      evidenceHash: sha256Hex(canonicalJson(request.evidence)),
      explanationHash: sha256Hex(primary.publicExplanation),
      schemaVersion: "1",
      policyVersion: POLICY_VERSION,
      promptVersion: `${PRIMARY_PROMPT_VERSION}+${VERIFIER_PROMPT_VERSION}`,
      primaryModel: this.primaryModel,
      verifierModel: this.verifierModel,
      createdAt: this.now().toISOString(),
    };
  }

  private validateDeterministically(request: EvaluationRequest): void {
    if (request.job.client === request.job.provider) {
      throw new EvaluationBlockedError("client_provider_role_collision");
    }
    if (
      request.job.evaluator === request.job.client ||
      request.job.evaluator === request.job.provider
    ) {
      throw new EvaluationBlockedError("evaluator_role_collision");
    }
    const expectedSuffix =
      request.asset === "sbtc" ? ".sbtc-commerce-v4" : ".agentic-commerce-v5";
    if (!request.contract.endsWith(expectedSuffix)) {
      throw new EvaluationBlockedError("asset_contract_mismatch");
    }
    const criterionIds = new Set(request.acceptanceCriteria.map((item) => item.id));
    if (criterionIds.size !== request.acceptanceCriteria.length) {
      throw new EvaluationBlockedError("duplicate_criterion_id");
    }
    const evidenceIds = new Set(request.evidence.map((item) => item.id));
    if (evidenceIds.size !== request.evidence.length) {
      throw new EvaluationBlockedError("duplicate_evidence_id");
    }
  }

  private validateCriterionCoverage(
    request: EvaluationRequest,
    evaluatedCriterionIds: readonly string[]
  ): void {
    const expected = [...request.acceptanceCriteria.map((item) => item.id)].sort();
    const actual = [...new Set(evaluatedCriterionIds)].sort();
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      throw new EvaluationBlockedError("criterion_coverage_mismatch");
    }
  }
}
