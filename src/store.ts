import type { Pool } from "pg";
import type { EvaluationArtifact, EvaluationRequest } from "./domain.js";

export type EvaluationStatus =
  | "queued"
  | "leased"
  | "blocked"
  | "decision_ready"
  | "broadcast_failed"
  | "broadcast"
  | "confirmed";

export interface StoredEvaluation {
  readonly id: string;
  readonly status: EvaluationStatus;
  readonly request: EvaluationRequest;
  readonly artifact?: EvaluationArtifact;
  readonly blockedReason?: string;
  readonly txid?: string;
  readonly updatedAt: string;
}

export interface EvaluationStore {
  putQueued(request: EvaluationRequest): Promise<void>;
  get(id: string): Promise<StoredEvaluation | null>;
  claim(id: string, owner: string, leaseSeconds: number): Promise<boolean>;
  saveArtifact(artifact: EvaluationArtifact): Promise<void>;
  saveBroadcastFailed(id: string, reason: string): Promise<void>;
  saveBlocked(id: string, reason: string): Promise<void>;
  saveBroadcast(id: string, txid: string): Promise<void>;
}

export class PostgresEvaluationStore implements EvaluationStore {
  constructor(private readonly pool: Pool) {}

  async putQueued(request: EvaluationRequest): Promise<void> {
    await this.pool.query(
      `insert into evaluations
         (id, network, asset, contract_id, job_id, status, request_json)
       values ($1, $2, $3, $4, $5, 'queued', $6::jsonb)
       on conflict (network, contract_id, job_id) do nothing`,
      [
        request.evaluationId,
        request.network,
        request.asset,
        request.contract,
        request.jobId,
        JSON.stringify(request),
      ]
    );
  }

  async get(id: string): Promise<StoredEvaluation | null> {
    const result = await this.pool.query<{
      id: string;
      status: EvaluationStatus;
      request_json: EvaluationRequest;
      public_artifact: EvaluationArtifact | null;
      blocked_reason: string | null;
      txid: string | null;
      updated_at: Date;
    }>(
      `select id, status, request_json, public_artifact, blocked_reason, txid, updated_at
       from evaluations where id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      request: row.request_json,
      ...(row.public_artifact ? { artifact: row.public_artifact } : {}),
      ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
      ...(row.txid ? { txid: row.txid } : {}),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async claim(id: string, owner: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `update evaluations
       set status = 'leased', lease_owner = $2,
           lease_expires_at = now() + ($3 * interval '1 second'),
           attempts = attempts + 1, updated_at = now()
       where id = $1
         and (status = 'queued' or (status = 'leased' and lease_expires_at < now()))
       returning id`,
      [id, owner, leaseSeconds]
    );
    return result.rowCount === 1;
  }

  async saveArtifact(artifact: EvaluationArtifact): Promise<void> {
    await this.pool.query(
      `update evaluations
       set status = 'decision_ready', public_artifact = $2::jsonb, updated_at = now()
       where id = $1 and status in ('queued', 'leased')`,
      [artifact.evaluationId, JSON.stringify(artifact)]
    );
  }

  async saveBroadcastFailed(id: string, reason: string): Promise<void> {
    await this.pool.query(
      `update evaluations
       set status = 'broadcast_failed', blocked_reason = $2, updated_at = now()
       where id = $1 and status = 'decision_ready'`,
      [id, reason]
    );
  }

  async saveBlocked(id: string, reason: string): Promise<void> {
    await this.pool.query(
      `update evaluations
       set status = 'blocked', blocked_reason = $2, updated_at = now()
       where id = $1 and status in ('queued', 'leased')`,
      [id, reason]
    );
  }

  async saveBroadcast(id: string, txid: string): Promise<void> {
    await this.pool.query(
      `update evaluations
       set status = 'broadcast', txid = $2, updated_at = now()
       where id = $1 and status = 'decision_ready'`,
      [id, txid]
    );
  }
}
