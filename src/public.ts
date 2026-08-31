import type { StoredEvaluation } from "./store.js";

export function publicEvaluation(record: StoredEvaluation) {
  return {
    id: record.id,
    status: record.status,
    network: record.request.network,
    asset: record.request.asset,
    contract: record.request.contract,
    jobId: record.request.jobId,
    ...(record.artifact
      ? {
          decision: record.artifact.decision,
          confidence: record.artifact.confidence,
          reasonCodes: record.artifact.reasonCodes,
          publicExplanation: record.artifact.publicExplanation,
          evidenceHash: record.artifact.evidenceHash,
          explanationHash: record.artifact.explanationHash,
          policyVersion: record.artifact.policyVersion,
          promptVersion: record.artifact.promptVersion,
        }
      : {}),
    ...(record.txid ? { txid: record.txid } : {}),
    ...(record.blockedReason ? { reason: record.blockedReason } : {}),
    updatedAt: record.updatedAt,
  };
}
