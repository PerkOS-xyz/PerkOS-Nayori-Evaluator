import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

const credentials = z.object({ clientId: z.string().regex(/^ny_oc_[A-Za-z0-9_-]{24}$/),
  clientSecret: z.string().min(32).max(512), tokenEndpoint: z.url(),
  walletAddress: z.string(), scopes: z.tuple([z.literal("evidence:read")]) }).strict();

export type PrivateEvidenceCredentials = z.infer<typeof credentials>;

export function loadPrivateEvidenceCredentials(path: string, evaluator: string, tokenEndpoint: string): PrivateEvidenceCredentials {
  if (!isAbsolute(path)) throw Error("invalid_private_evidence_credentials");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0) throw Error("invalid_private_evidence_credentials");
    const value = credentials.parse(JSON.parse(readFileSync(fd, "utf8")));
    if (value.walletAddress !== evaluator || value.tokenEndpoint !== tokenEndpoint) throw Error("invalid_private_evidence_credentials");
    return value;
  } catch { throw Error("invalid_private_evidence_credentials"); }
  finally { closeSync(fd); }
}

export function privateEvidenceToken(input: PrivateEvidenceCredentials, transport: typeof fetch = fetch) {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const body = new URLSearchParams({ grant_type: "client_credentials", scope: "evidence:read" });
    const response = await transport(input.tokenEndpoint, { method: "POST", redirect: "error", credentials: "omit",
      signal: AbortSignal.timeout(15_000), headers: { accept: "application/json",
        authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (!response.ok) { await response.body?.cancel(); throw Error("private_evidence_token_failed"); }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("private_evidence_token_failed");
    const token = value as Record<string, unknown>;
    if (token.token_type !== "Bearer" || typeof token.access_token !== "string" || token.access_token.length > 8192 ||
      typeof token.expires_in !== "number" || !Number.isSafeInteger(token.expires_in) || token.expires_in < 60 || token.expires_in > 900 ||
      token.scope !== "evidence:read") throw Error("private_evidence_token_failed");
    cached = { token: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return cached.token;
  };
}
