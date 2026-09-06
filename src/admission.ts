import { evaluationRequestSchema, type EvaluationRequest } from "./domain.js";
import { evaluationJobId, parseEvaluationDescription, prepareEvaluationSubmission } from "./evaluation-commitments.js";
import { canonicalJson } from "./canonical.js";
import { EvaluationConflictError, type StoredEvaluation } from "./store.js";
import type { EvaluationEligibility } from "./eligibility.js";

export interface CommittedStore {
  get(id: string): Promise<StoredEvaluation | null>;
  admitCommitted(request: EvaluationRequest, limits: { daily: number; pending: number }): Promise<void>;
}

export class InvalidCommitmentRequest extends Error {
  constructor() { super("invalid_committed_request"); }
}

export async function parseCommittedRequest(raw: unknown): Promise<EvaluationRequest> {
  try {
    const request = evaluationRequestSchema.extend({ commitmentVersion: evaluationRequestSchema.shape.commitmentVersion.unwrap() }).strict().parse(raw);
    const id = await evaluationJobId({ network: request.network, contract: request.contract, jobId: request.jobId });
    if (id !== request.evaluationId) throw new InvalidCommitmentRequest();
    const description = parseEvaluationDescription(request.job.description);
    const committed = await prepareEvaluationSubmission({
      network: request.network, asset: request.asset, contract: request.contract, jobId: request.jobId,
      client: request.job.client, provider: request.job.provider, evaluator: request.job.evaluator,
      description: description.description, acceptanceCriteria: request.acceptanceCriteria, evidence: request.evidence,
    });
    if (committed.criteriaHash !== description.criteriaHash) throw new InvalidCommitmentRequest();
    return request;
  } catch {
    // Never echo input, schema details, credentials embedded in URLs or raw errors.
    throw new InvalidCommitmentRequest();
  }
}

export async function admitEvaluation(raw: unknown, store: CommittedStore,
  eligibility: EvaluationEligibility, limits: { daily: number; pending: number }): Promise<StoredEvaluation> {
  const request = await parseCommittedRequest(raw);
  const existing = await store.get(request.evaluationId);
  if (existing) {
    if (canonicalJson(existing.request) !== canonicalJson(request)) {
      throw new EvaluationConflictError("evaluation_request_mismatch");
    }
    return existing; // No repeat chain reads, inference, or automatic retry, including terminal jobs.
  }
  await eligibility.assertEligible(request);
  await store.admitCommitted(request, limits);
  const record = await store.get(request.evaluationId);
  if (!record) throw new Error("admitted_record_unavailable");
  return record;
}

/** Serial durable drain. Only queued, never interrupted/ambiguous attempts, are resumed. */
export async function drainCommitted(
  store: { nextCommitted(): Promise<StoredEvaluation | null> },
  coordinator: { process(raw: unknown, signal?: AbortSignal): Promise<StoredEvaluation> },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const record = await store.nextCommitted();
    if (!record) return;
    await coordinator.process(record.request, signal);
  }
}
