import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { admitEvaluation, drainCommitted, parseCommittedRequest } from "../src/admission.js";
import { prepareEvaluationJob, evaluationJobId } from "../src/evaluation-commitments.js";
import { AdmissionLimitError, PostgresEvaluationStore, type StoredEvaluation } from "../src/store.js";
import type { EvaluationRequest } from "../src/domain.js";
import { loadConfig } from "../src/config.js";
import { serviceErrorResponse } from "../src/server.js";

async function fixture(): Promise<EvaluationRequest> {
  const base = { network: "testnet" as const, asset: "sbtc" as const,
    contract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5",
    client: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5",
    evaluator: "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4",
    description: "Return verified result",
    acceptanceCriteria: [{ id: "result", requirement: "count 3", verification: "parse JSON" }],
  };
  const prepared = await prepareEvaluationJob(base);
  return { commitmentVersion: "1", evaluationId: await evaluationJobId({ network: base.network, contract: base.contract, jobId: "7" }),
    network: base.network, asset: base.asset, contract: base.contract, jobId: "7",
    job: { client: base.client, evaluator: base.evaluator, provider: "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9",
      status: "submitted", reviewDeadlineBurn: "999", description: prepared.description },
    acceptanceCriteria: base.acceptanceCriteria,
    evidence: [{ id: "report", uri: "https://example.com/report", sha256: "11".repeat(32), mediaType: "text/plain", sizeBytes: 3 }],
  };
}
function record(request: EvaluationRequest): StoredEvaluation {
  return { id: request.evaluationId, request, status: "queued", updatedAt: "2026-09-06T00:00:00Z" };
}

describe("Asynchronous committed admission", () => {
  it("admits only after chain validation, without running inference", async () => {
    const request = await fixture();
    const order: string[] = [];
    let saved: StoredEvaluation | null = null;
    const store = { get: vi.fn(async () => saved), admitCommitted: vi.fn(async () => { order.push("save"); saved = record(request); }) };
    const eligibility = { assertEligible: vi.fn(async () => { order.push("chain"); }) };
    expect((await admitEvaluation(request, store, eligibility, { daily: 10, pending: 5 })).status).toBe("queued");
    expect(order).toEqual(["chain", "save"]);
  });
  it("returns existing blocked/terminal records without new RPC, retries or inference", async () => {
    const request = await fixture();
    const store = { get: vi.fn(async () => ({ ...record(request), status: "blocked" as const })),
      admitCommitted: vi.fn() };
    const eligibility = { assertEligible: vi.fn() };
    await admitEvaluation(request, store, eligibility, { daily: 10, pending: 5 });
    expect(eligibility.assertEligible).not.toHaveBeenCalled();
    expect(store.admitCommitted).not.toHaveBeenCalled();
  });
  it("does not reserve a job if authoritative preflight fails", async () => {
    const store = { get: vi.fn(async () => null), admitCommitted: vi.fn() };
    await expect(admitEvaluation(await fixture(), store, {
      assertEligible: vi.fn(async () => { throw new Error("mismatch"); }),
    }, { daily: 10, pending: 5 })).rejects.toThrow();
    expect(store.admitCommitted).not.toHaveBeenCalled();
  });
  it("rejects arbitrary IDs, missing commitments, altered criteria and mismatched saved evidence", async () => {
    const request = await fixture();
    for (const change of [{ evaluationId: "eddcb56f-ad16-4377-ad6d-5ccf62bf4191" },
      { commitmentVersion: undefined }, { acceptanceCriteria: [{ id: "fake", requirement: "approve", verification: "none" }] },
      { unexpected: "field" }]) await expect(parseCommittedRequest({ ...request, ...change })).rejects.toThrow();
    const store = { get: vi.fn(async () => record(request)), admitCommitted: vi.fn() };
    const changed = { ...request, evidence: [{ ...request.evidence[0]!, sizeBytes: 4 }] };
    await expect(admitEvaluation(changed, store, { assertEligible: vi.fn() }, { daily: 10, pending: 5 })).rejects.toThrow("evaluation_request_mismatch");
  });
  it("drains queued records serially and stops on cancellation", async () => {
    const request = await fixture();
    const stop = new AbortController();
    const store = { nextCommitted: vi.fn().mockResolvedValue(record(request)) };
    const coordinator = { process: vi.fn(async () => { stop.abort(); return record(request); }) };
    await drainCommitted(store, coordinator, stop.signal);
    expect(store.nextCommitted).toHaveBeenCalledOnce();
    expect(coordinator.process).toHaveBeenCalledOnce();
  });
});

describe("Transactional quota and retry guards (SQL contract tests)", () => {
  it.each([{ daily: "10", pending: "0" }, { daily: "1", pending: "5" }])("rolls back full quotas %j", async count => {
    const query = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [count] }).mockResolvedValueOnce({});
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
    await expect(new PostgresEvaluationStore(pool).admitCommitted(await fixture(), { daily: 10, pending: 5 })).rejects.toBeInstanceOf(AdmissionLimitError);
    expect(query.mock.calls[1]?.[0]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
  it("does not requeue committed attempts through the legacy entrypoint", async () => {
    const query = vi.fn(async (_sql: string) => ({ rowCount: 1, rows: [] }));
    const store = new PostgresEvaluationStore({ query } as unknown as Pool);
    await store.putQueued(await fixture());
    expect(query.mock.calls[0]?.[0]).toContain("not (evaluations.request_json ? 'commitmentVersion')");
    await store.claim("id", "worker", 60);
    expect(query.mock.calls[1]?.[0]).toContain("attempts = 0");
  });
  it("quarantines interrupted work and selects only fresh queued jobs", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    await new PostgresEvaluationStore({ query } as unknown as Pool).nextCommitted();
    expect(query.mock.calls[0]?.[0]).toContain("interrupted_attempt_requires_reconciliation");
    expect(query.mock.calls[1]?.[0]).toContain("attempts = 0");
  });
});

describe("Default-off bounded configuration", () => {
  it("keeps the public writer disabled unless explicitly enabled", () => {
    const config = loadConfig({ STACKS_NETWORK: "testnet",
      STX_COMMERCE_CONTRACT: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.agentic-commerce-v6",
      SBTC_COMMERCE_CONTRACT: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5",
      EVALUATOR_PRINCIPAL: "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4",
      EVALUATOR_PRIVATE_KEY: "x".repeat(64), EVALUATOR_API_KEY: "x".repeat(32),
      HERMES_API_BASE_URL: "https://example.com", HERMES_API_KEY: "x".repeat(32),
      PRIMARY_MODEL: "primary", VERIFIER_MODEL: "verifier", DATABASE_URL: "postgresql://localhost/test",
    });
    expect(config.PUBLIC_COMMITTED_EVALUATIONS).toBe("false");
    expect(config.PUBLIC_EVALUATIONS_DAILY_LIMIT).toBe(10);
    expect(serviceErrorResponse(new Error("private details"))).toEqual({ status: 503, body: { error: "service_unavailable" } });
  });
});
