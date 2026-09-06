import { createHash } from "node:crypto";
import type { EvaluationRequest } from "./domain.js";
import { EvaluationBlockedError } from "./evaluator.js";

export interface VerifiedEvidence { readonly id: string; readonly sha256: string; readonly text: string }
export interface EvidenceLoader { load(request: EvaluationRequest, signal?: AbortSignal): Promise<readonly VerifiedEvidence[]> }

/** Explicit operator origins only. No redirects, tools, HTML execution, private network default or ambient credentials. */
export class AllowlistedEvidenceLoader implements EvidenceLoader {
  private readonly origins: Set<string>;
  constructor(origins: readonly string[], private readonly transport: typeof fetch = fetch) {
    this.origins = new Set(origins.map(value => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash || url.port || url.hostname === "localhost" ||
        url.hostname.endsWith(".local") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) {
        throw new Error("invalid_evidence_origin");
      }
      return url.origin;
    }));
  }
  async load(request: EvaluationRequest, signal?: AbortSignal): Promise<readonly VerifiedEvidence[]> {
    const fail = () => { throw new EvaluationBlockedError("evidence_unavailable_or_invalid"); };
    if (request.evidence.length > 5) fail();
    let total = 0;
    const verified: VerifiedEvidence[] = [];
    for (const item of request.evidence) {
      const url = new URL(item.uri);
      if (!this.origins.has(url.origin) || url.username || url.password || url.hash ||
        !["text/plain", "application/json"].includes(item.mediaType) || item.sizeBytes > 8192) fail();
      total += item.sizeBytes;
      if (total > 16000) fail();
      const timeout = AbortSignal.timeout(15000);
      const response = await this.transport(url, { redirect: "error", credentials: "omit",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: item.mediaType } });
      if (!response.ok || !response.body ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== item.mediaType) {
        await response.body?.cancel(); fail();
      }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > item.sizeBytes || size > 8192) fail();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      if (size !== item.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) fail();
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return fail(); }
      if (item.mediaType === "application/json") {
        try { JSON.parse(text); } catch { fail(); }
      }
      verified.push({ id: item.id, sha256: item.sha256, text });
    }
    return verified;
  }
}
