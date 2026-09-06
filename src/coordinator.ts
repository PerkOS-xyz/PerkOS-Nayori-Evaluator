import { evaluationRequestSchema, type EvaluationRequest } from "./domain.js";
import { EvaluationBlockedError, type EvaluationEngine } from "./evaluator.js";
import type { DecisionRecorder } from "./chain.js";
import type { EvaluationStore, StoredEvaluation } from "./store.js";
import type { EvaluationEligibility } from "./eligibility.js";

export interface EvaluationCoordinatorOptions {
  readonly engine: EvaluationEngine;
  readonly store: EvaluationStore;
  readonly recorder: DecisionRecorder;
  readonly eligibility: EvaluationEligibility;
  readonly workerId: string;
  readonly leaseSeconds?: number;
}

export class EvaluationCoordinator {
  private readonly engine: EvaluationEngine;
  private readonly store: EvaluationStore;
  private readonly recorder: DecisionRecorder;
  private readonly eligibility: EvaluationEligibility;
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: EvaluationCoordinatorOptions) {
    this.engine = options.engine;
    this.store = options.store;
    this.recorder = options.recorder;
    this.eligibility = options.eligibility;
    this.workerId = options.workerId;
    this.leaseSeconds = options.leaseSeconds ?? 300;
  }

  process(rawRequest: unknown, signal?: AbortSignal): Promise<StoredEvaluation> {
    // One configured QA signer: serialize jobs before claiming a database lease or fetching a nonce.
    // Multiple service replicas still require an external signer/nonce coordinator.
    const task = this.queue.then(() => this.processOne(rawRequest, signal));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async processOne(rawRequest: unknown, signal?: AbortSignal): Promise<StoredEvaluation> {
    signal?.throwIfAborted();
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

    let artifactSaved = false;
    try {
      await this.eligibility.assertEligible(request);
      const artifact = await this.engine.evaluate(request, signal);
      await this.eligibility.assertEligible(request);
      signal?.throwIfAborted();
      await this.store.saveArtifact(artifact);
      artifactSaved = true;
      const receipt = await this.recorder.recordDecision(artifact);
      await this.store.saveBroadcast(request.evaluationId, receipt.txid);
    } catch (error) {
      if (artifactSaved) {
        await this.store.saveBroadcastFailed(
          request.evaluationId,
          "decision_broadcast_failed"
        );
      } else if (error instanceof EvaluationBlockedError) {
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
