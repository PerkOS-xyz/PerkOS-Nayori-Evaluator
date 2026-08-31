import { createServer, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { loadConfig, safeConfig } from "./config.js";
import { PostgresEvaluationStore } from "./store.js";
import { publicEvaluation } from "./public.js";

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
  const store = new PostgresEvaluationStore(pool);
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
