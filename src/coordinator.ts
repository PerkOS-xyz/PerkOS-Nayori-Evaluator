import { evaluationRequestSchema, type EvaluationRequest } from "./domain.js";
import { EvaluationBlockedError, type EvaluationEngine } from "./evaluator.js";
import type { DecisionRecorder } from "./chain.js";
import type { EvaluationStore, StoredEvaluation } from "./store.js";

export interface EvaluationCoordinatorOptions {
  readonly engine: EvaluationEngine;
  readonly store: EvaluationStore;
  readonly recorder: DecisionRecorder;
  readonly workerId: string;
  readonly leaseSeconds?: number;
}

export class EvaluationCoordinator {
  private readonly engine: EvaluationEngine;
  private readonly store: EvaluationStore;
  private readonly recorder: DecisionRecorder;
  private readonly workerId: string;
  private readonly leaseSeconds: number;

  constructor(options: EvaluationCoordinatorOptions) {
    this.engine = options.engine;
    this.store = options.store;
    this.recorder = options.recorder;
    this.workerId = options.workerId;
    this.leaseSeconds = options.leaseSeconds ?? 300;
  }

  async process(rawRequest: unknown, signal?: AbortSignal): Promise<StoredEvaluation> {
    const request: EvaluationRequest = evaluationRequestSchema.parse(rawRequest);
    await this.store.putQueued(request);
    const claimed = await this.store.claim(
      request.evaluationId,
      this.workerId,
      this.leaseSeconds
    );
    if (!claimed) {
      const existing = await this.store.get(request.evaluationId);
      if (!existing) throw new Error("Evaluation was not claimable and no record exists.");
      return existing;
    }

    try {
      const artifact = await this.engine.evaluate(request, signal);
      await this.store.saveArtifact(artifact);
      const receipt = await this.recorder.recordDecision(artifact);
      await this.store.saveBroadcast(request.evaluationId, receipt.txid);
    } catch (error) {
      if (error instanceof EvaluationBlockedError) {
        await this.store.saveBlocked(request.evaluationId, error.reason);
      } else {
        await this.store.saveBlocked(request.evaluationId, "evaluation_dependency_failure");
      }
    }

    const result = await this.store.get(request.evaluationId);
    if (!result) throw new Error("Evaluation disappeared after processing.");
    return result;
  }
}
