import { createHash } from "node:crypto";
import type { EvaluationRequest } from "./domain.js";
import { EvaluationBlockedError } from "./evaluator.js";

export interface VerifiedEvidence { readonly id: string; readonly sha256: string; readonly text: string }
export interface EvidenceLoader { load(request: EvaluationRequest, signal?: AbortSignal): Promise<readonly VerifiedEvidence[]> }
export interface PrivateEvidenceOptions {
  readonly origin: string;
  readonly objectHost: string;
  readonly accessToken: () => Promise<string>;
}

/** Explicit operator origins only. No redirects, tools, HTML execution, private network default or ambient credentials. */
export class AllowlistedEvidenceLoader implements EvidenceLoader {
  private readonly origins: Set<string>;
  private readonly privateOrigin?: string;
  private readonly privateObjectHost?: string;
  constructor(origins: readonly string[], private readonly transport: typeof fetch = fetch,
    private readonly privateEvidence?: PrivateEvidenceOptions) {
    this.origins = new Set(origins.map(value => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash || url.port || url.hostname === "localhost" ||
        url.hostname.endsWith(".local") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) {
        throw new Error("invalid_evidence_origin");
      }
      return url.origin;
    }));
    if (privateEvidence) {
      const url = new URL(privateEvidence.origin);
      if (!["https://api.qa.nayori.ai/", "https://api.nayori.ai/"].includes(url.href) ||
          !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3\.us-east-1\.amazonaws\.com$/.test(privateEvidence.objectHost)) {
        throw new Error("invalid_private_evidence_origin");
      }
      this.privateOrigin = url.origin;
      this.privateObjectHost = privateEvidence.objectHost;
    }
  }
  async load(request: EvaluationRequest, signal?: AbortSignal): Promise<readonly VerifiedEvidence[]> {
    const fail = () => { throw new EvaluationBlockedError("evidence_unavailable_or_invalid"); };
    if (request.evidence.length > 5) fail();
    let total = 0;
    const verified: VerifiedEvidence[] = [];
    for (const item of request.evidence) {
      const url = new URL(item.uri);
      const privateId = this.privateOrigin === url.origin && url.pathname.match(/^\/v1\/private-evidence\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)?.[1];
      if ((!this.origins.has(url.origin) && !privateId) || url.username || url.password || url.hash || url.search ||
        !["text/plain", "application/json"].includes(item.mediaType) || item.sizeBytes > 8192) fail();
      total += item.sizeBytes;
      if (total > 16000) fail();
      const timeout = AbortSignal.timeout(15000);
      let target: URL = url;
      if (privateId) {
        const token = await this.privateEvidence!.accessToken();
        if (!token || token.length > 8192 || /[\r\n]/.test(token)) fail();
        const authorized = await this.transport(`${this.privateOrigin}/v1/private-evidence/download`, {
          method: "POST", redirect: "error", credentials: "omit", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
          headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ id: privateId }),
        });
        if (!authorized.ok) { await authorized.body?.cancel(); fail(); }
        const value: unknown = await authorized.json();
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).url !== "string") fail();
        target = new URL((value as { url: string }).url);
        if (target.protocol !== "https:" || target.username || target.password || target.hash ||
          target.hostname !== this.privateObjectHost ||
          (target.port !== "" && target.port !== "443")) fail();
      }
      const response = await this.transport(target, { redirect: "error", credentials: "omit",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: item.mediaType } });
      if (!response.ok || !response.body ||
        (!privateId && response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== item.mediaType)) {
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
