import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/domain.js";
import {
  EvaluationConflictError,
  PostgresEvaluationStore,
} from "../src/store.js";
import { serviceErrorResponse } from "../src/server.js";

const input: EvaluationRequest = {
  evaluationId: "eddcb56f-ad16-4377-ad6d-5ccf62bf4191",
  network: "testnet",
  asset: "stx",
  contract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.agentic-commerce-v5",
  jobId: "1",
  job: {
    client: "ST1CLIENT",
    provider: "ST1PROVIDER",
    evaluator: "ST1EVALUATOR",
    status: "submitted",
    reviewDeadlineBurn: "11792",
    description: "Controlled retry",
  },
  acceptanceCriteria: [
    { id: "criterion", requirement: "Match", verification: "Compare" },
  ],
  evidence: [
    {
      id: "evidence",
      uri: "https://example.com/evidence.txt",
      sha256: "11".repeat(32),
      mediaType: "text/plain",
      sizeBytes: 5,
    },
  ],
};

function storeWith(query: ReturnType<typeof vi.fn>) {
  return new PostgresEvaluationStore({ query } as unknown as Pool);
}

describe("PostgresEvaluationStore retry semantics", () => {
  it("requeues a guarded dependency-blocked evaluation in one statement", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rowCount: 1,
      rows: [{ id: input.evaluationId }],
    }));

    await expect(storeWith(query).putQueued(input)).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("evaluation_dependency_failure");
    expect(query.mock.calls[0]?.[0]).toContain("evaluations.request_json = excluded.request_json");
  });

  it("keeps an identical same-ID terminal request idempotent", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: input.evaluationId, request_matches: true }],
      });

    await expect(storeWith(query).putQueued(input)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects a different evaluation ID for an existing job as HTTP 409", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "9f49cc54-0cba-4cf3-98d2-5e5c6965fab9", request_matches: false }],
      });
    const store = storeWith(query);

    await expect(store.putQueued(input)).rejects.toEqual(
      new EvaluationConflictError("job_evaluation_id_conflict")
    );
    expect(
      serviceErrorResponse(new EvaluationConflictError("job_evaluation_id_conflict"))
    ).toEqual({ status: 409, body: { error: "job_evaluation_id_conflict" } });
  });

  it("rejects mutation under an existing evaluation ID", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: input.evaluationId, request_matches: false }],
      });

    await expect(storeWith(query).putQueued(input)).rejects.toEqual(
      new EvaluationConflictError("evaluation_request_mismatch")
    );
  });
});
