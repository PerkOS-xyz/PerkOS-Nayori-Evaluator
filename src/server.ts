import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { evaluationLeaseSeconds, loadConfig, safeConfig } from "./config.js";
import { AdmissionLimitError, EvaluationConflictError, PostgresEvaluationStore } from "./store.js";
import { InvalidCommitmentRequest, admitEvaluation, drainCommitted } from "./admission.js";
import { EvaluationBlockedError } from "./evaluator.js";
import { publicEvaluation } from "./public.js";
import { HermesInference } from "./inference.js";
import { EvaluationEngine } from "./evaluator.js";
import { AllowlistedDecisionRecorder, StacksDecisionAdapter } from "./chain.js";
import { EvaluationCoordinator } from "./coordinator.js";
import { StacksEligibility } from "./eligibility.js";
import { AllowlistedEvidenceLoader } from "./evidence.js";
import { loadPrivateEvidenceCredentials, privateEvidenceToken } from "./private-evidence.js";
import { commerceContractsSchema, policyForNetwork } from "./contracts.js";
import { loadMigrations, verifyAppliedMigrations } from "./migrations.js";

export function serviceErrorResponse(error: unknown): {
  readonly status: number;
  readonly body: { readonly error: string };
} {
  if (error instanceof EvaluationConflictError) {
    return { status: 409, body: { error: error.reason } };
  }
  if (error instanceof InvalidCommitmentRequest || error instanceof SyntaxError) {
    return { status: 400, body: { error: "invalid_committed_request" } };
  }
  if (error instanceof AdmissionLimitError) {
    return { status: 429, body: { error: "evaluation_admission_limit" } };
  }
  if (error instanceof EvaluationBlockedError) {
    return { status: 422, body: { error: error.reason } };
  }
  return { status: 503, body: { error: "service_unavailable" } };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const contracts = commerceContractsSchema.parse({ network: config.STACKS_NETWORK,
    stxContract: config.STX_COMMERCE_CONTRACT, sbtcContract: config.SBTC_COMMERCE_CONTRACT });
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
  await verifyAppliedMigrations(pool, await loadMigrations());
  const store = new PostgresEvaluationStore(pool);
  const publicEnabled = config.PUBLIC_COMMITTED_EVALUATIONS === "true";
  const stop = new AbortController();
  // One signing service across replicas. Connection loss stops new work.
  const lock = publicEnabled ? await pool.connect() : undefined;
  if (lock) {
    const result = await lock.query<{ acquired: boolean }>("select pg_try_advisory_lock(7240192) as acquired");
    if (!result.rows[0]?.acquired) {
      lock.release(); await pool.end();
      throw new Error("evaluator_worker_already_running");
    }
    lock.on("error", () => stop.abort());
  }
  const inference = new HermesInference({
    baseUrl: config.HERMES_API_BASE_URL,
    apiKey: config.HERMES_API_KEY,
    timeoutMs: config.INFERENCE_TIMEOUT_MS,
  });
  const networkPolicy = policyForNetwork(config.STACKS_NETWORK);
  const privateEvidence = config.PRIVATE_EVIDENCE_ENABLED === "true" ? {
    origin: config.PRIVATE_EVIDENCE_ORIGIN,
    objectHost: networkPolicy.privateEvidenceObjectHost,
    accessToken: privateEvidenceToken(loadPrivateEvidenceCredentials(config.PRIVATE_EVIDENCE_OAUTH_CLIENT_FILE,
      config.EVALUATOR_PRINCIPAL, networkPolicy.privateEvidenceTokenEndpoint)),
  } : undefined;
  const engine = new EvaluationEngine({
    contracts, evaluatorPrincipal: config.EVALUATOR_PRINCIPAL,
    inference,
    primaryModel: config.PRIMARY_MODEL,
    verifierModel: config.VERIFIER_MODEL,
    minimumConfidence: config.MIN_DECISION_CONFIDENCE,
    evidenceLoader: new AllowlistedEvidenceLoader(config.EVIDENCE_ALLOWED_ORIGINS.split(",").map(item => item.trim()).filter(Boolean),
      fetch, privateEvidence),
  });
  const adapter = new StacksDecisionAdapter({
    contracts,
    apiUrl: config.STACKS_API_URL,
    privateKey: config.EVALUATOR_PRIVATE_KEY,
    evaluatorPrincipal: config.EVALUATOR_PRINCIPAL,
    fee: config.TRANSACTION_FEE_USTX,
    mainnetActivationConfirmation: config.CONFIRM_MAINNET_EVALUATOR,
  });
  const recorder = new AllowlistedDecisionRecorder({
    network: config.STACKS_NETWORK,
    stxContract: config.STX_COMMERCE_CONTRACT,
    sbtcContract: config.SBTC_COMMERCE_CONTRACT,
    adapter,
  });
  const eligibility = new StacksEligibility({ contracts,
    evaluatorPrincipal: config.EVALUATOR_PRINCIPAL, apiUrl: config.STACKS_API_URL,
    committedMinimumBudget: {
      stx: BigInt(config.PUBLIC_EVALUATIONS_MIN_STX), sbtc: BigInt(config.PUBLIC_EVALUATIONS_MIN_SBTC),
    },
  });
  const coordinator = new EvaluationCoordinator({
    engine,
    store,
    recorder,
    eligibility,
    workerId: `nayori-evaluator-${process.pid}`,
    leaseSeconds: evaluationLeaseSeconds(config),
  });
  let admitting = false;
  let worker: Promise<void> | undefined;
  let workerFailed = false;
  const tick = () => {
    if (!publicEnabled || stop.signal.aborted || worker) return;
    worker = drainCommitted(store, coordinator, stop.signal)
      .then(() => { workerFailed = false; }, () => { workerFailed = true; })
      .finally(() => { worker = undefined; });
  };
  const timer = publicEnabled ? setInterval(tick, 5000) : undefined;
  tick(); // Recover queued jobs after restart without a new HTTP request.
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        send(response, 200, { ok: true, service: "nayori-evaluator", version: "0.2.0" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        if (stop.signal.aborted || workerFailed) {
          send(response, 503, { error: "worker_unavailable" }); return;
        }
        await pool.query("select 1");
        send(response, 200, { ok: true, ...safeConfig(config) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/internal/v1/evaluations") {
        // Prevent bypassing committed admission/caps through the old processing route.
        if (publicEnabled) { send(response, 404, { error: "not_found" }); return; }
        if (!authorized(request, config.EVALUATOR_API_KEY)) {
          send(response, 401, { error: "unauthorized" });
          return;
        }
        const record = await coordinator.process(await readJson(request));
        send(response, 200, publicEvaluation(record));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/evaluations" && publicEnabled) {
        if (stop.signal.aborted || workerFailed) { send(response, 503, { error: "worker_unavailable" }); return; }
        // Bounded preflight concurrency; no IP trust and no unbounded RPC queue.
        if (admitting) { send(response, 429, { error: "admission_busy" }); return; }
        admitting = true;
        try {
          const record = await admitEvaluation(await readJson(request), store, eligibility, {
            daily: config.PUBLIC_EVALUATIONS_DAILY_LIMIT, pending: config.PUBLIC_EVALUATIONS_QUEUE_LIMIT,
          });
          send(response, 202, publicEvaluation(record));
        } finally { admitting = false; }
        return;
      }
      const match = url.pathname.match(
        /^\/v1\/evaluations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
      );
      if (request.method === "GET" && match?.[1]) {
        const record = await store.get(match[1]);
        if (!record) {
          send(response, 404, { error: "evaluation_not_found" });
          return;
        }
        send(response, 200, publicEvaluation(record));
        return;
      }
      send(response, 404, { error: "not_found" });
    } catch (error) {
      const failure = serviceErrorResponse(error);
      send(response, failure.status, failure.body);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  server.listen(config.PORT, "0.0.0.0");
  const shutdown = async () => {
    stop.abort();
    if (timer) clearInterval(timer);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await worker;
    lock?.release();
    await pool.end();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
