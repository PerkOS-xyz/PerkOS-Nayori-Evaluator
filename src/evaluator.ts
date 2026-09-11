import {
  evaluationRequestSchema,
  modelDecisionSchema,
  verificationSchema,
  type EvaluationArtifact,
  type EvaluationRequest,
} from "./domain.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { StructuredInference } from "./inference.js";
import type { EvidenceLoader } from "./evidence.js";
import { commerceContractsSchema, matchesTarget, type CommerceContracts } from "./contracts.js";
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
  readonly contracts: CommerceContracts;
  readonly evaluatorPrincipal: string;
  readonly inference: StructuredInference;
  readonly primaryModel: string;
  readonly verifierModel: string;
  readonly minimumConfidence: number;
  readonly now?: () => Date;
  readonly evidenceLoader?: EvidenceLoader;
}

export class EvaluationEngine {
  private readonly contracts: CommerceContracts;
  private readonly evaluatorPrincipal: string;
  private readonly inference: StructuredInference;
  private readonly primaryModel: string;
  private readonly verifierModel: string;
  private readonly minimumConfidence: number;
  private readonly now: () => Date;
  private readonly evidenceLoader: EvidenceLoader | undefined;

  constructor(options: EvaluationEngineOptions) {
    this.contracts = commerceContractsSchema.parse(options.contracts);
    this.evaluatorPrincipal = options.evaluatorPrincipal;
    this.inference = options.inference;
    this.primaryModel = options.primaryModel;
    this.verifierModel = options.verifierModel;
    this.minimumConfidence = options.minimumConfidence;
    this.now = options.now ?? (() => new Date());
    this.evidenceLoader = options.evidenceLoader;
  }

  async evaluate(rawRequest: unknown, signal?: AbortSignal): Promise<EvaluationArtifact> {
    const request = evaluationRequestSchema.parse(rawRequest);
    this.validateDeterministically(request);
    if (request.commitmentVersion && !this.evidenceLoader) throw new EvaluationBlockedError("verified_evidence_loader_required");
    const verifiedEvidence = request.commitmentVersion ? await this.evidenceLoader!.load(request, signal) : undefined;

    const primary = await this.inference.complete({
      model: this.primaryModel,
      messages: primaryMessages(request, verifiedEvidence),
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
    const evidenceIds = new Set(request.evidence.map(item => item.id));
    if (new Set(primary.criteria.map(item => item.criterionId)).size !== primary.criteria.length ||
      primary.criteria.some(item => item.evidenceIds.some(id => !evidenceIds.has(id))) ||
      (primary.decision === "approve" && primary.criteria.some(item => item.outcome !== "pass" || !item.evidenceIds.length))) {
      throw new EvaluationBlockedError("criterion_evidence_inconsistent");
    }

    const verification = await this.inference.complete({
      model: this.verifierModel,
      messages: verifierMessages(request, primary, verifiedEvidence),
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
    if (!matchesTarget(this.contracts, request)) {
      throw new EvaluationBlockedError("asset_contract_mismatch");
    }
    if (request.job.evaluator !== this.evaluatorPrincipal) {
      throw new EvaluationBlockedError("evaluator_principal_mismatch");
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
