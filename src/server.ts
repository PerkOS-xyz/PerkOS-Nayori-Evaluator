import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { loadConfig, safeConfig } from "./config.js";
import { PostgresEvaluationStore } from "./store.js";
import { publicEvaluation } from "./public.js";
import { HermesInference } from "./inference.js";
import { EvaluationEngine } from "./evaluator.js";
import { AllowlistedDecisionRecorder, StacksTestnetDecisionAdapter } from "./chain.js";
import { EvaluationCoordinator } from "./coordinator.js";

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
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
  const store = new PostgresEvaluationStore(pool);
  const inference = new HermesInference({
    baseUrl: config.HERMES_API_BASE_URL,
    apiKey: config.HERMES_API_KEY,
    timeoutMs: config.INFERENCE_TIMEOUT_MS,
  });
  const engine = new EvaluationEngine({
    inference,
    primaryModel: config.PRIMARY_MODEL,
    verifierModel: config.VERIFIER_MODEL,
    minimumConfidence: config.MIN_DECISION_CONFIDENCE,
  });
  const adapter = new StacksTestnetDecisionAdapter({
    apiUrl: config.STACKS_API_URL,
    privateKey: config.EVALUATOR_PRIVATE_KEY,
    evaluatorPrincipal: config.EVALUATOR_PRINCIPAL,
    fee: config.TRANSACTION_FEE_USTX,
  });
  const recorder = new AllowlistedDecisionRecorder({
    stxContract: config.STX_COMMERCE_CONTRACT,
    sbtcContract: config.SBTC_COMMERCE_CONTRACT,
    adapter,
  });
  const coordinator = new EvaluationCoordinator({
    engine,
    store,
    recorder,
    workerId: `nayori-evaluator-${process.pid}`,
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        send(response, 200, { ok: true, service: "nayori-evaluator", version: "0.1.0" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        await pool.query("select 1");
        send(response, 200, { ok: true, ...safeConfig(config) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/internal/v1/evaluations") {
        if (!authorized(request, config.EVALUATOR_API_KEY)) {
          send(response, 401, { error: "unauthorized" });
          return;
        }
        const record = await coordinator.process(await readJson(request));
        send(response, 200, publicEvaluation(record));
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
    } catch {
      send(response, 503, { error: "service_unavailable" });
    }
  });

  server.listen(config.PORT, "0.0.0.0");
  const shutdown = async () => {
    server.close();
    await pool.end();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
