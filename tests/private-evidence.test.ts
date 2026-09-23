import { describe, expect, it, vi } from "vitest";
import { AllowlistedEvidenceLoader } from "../src/evidence.js";
import type { EvaluationRequest } from "../src/domain.js";

const bytes = '{"answer":12}';
const item = { id: "result", uri: "https://api.qa.nayori.ai/v1/private-evidence/59e377ce-9ee3-46bd-9ecf-95bd54dc068f",
  sha256: "97c95e55e3387da4d7b531a24ac32d27e3d1d5ab6c9a177a1f25620427c15590", mediaType: "application/json", sizeBytes: 13 };
const request = { evidence: [item] } as unknown as EvaluationRequest;
const qaObjectHost = "perkos-nayori-qa-evidence-089332276762.s3.us-east-1.amazonaws.com";

describe("private evidence evaluator loader", () => {
  it("uses OAuth only with Nayori, then verifies exact signed-S3 bytes", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/download")) return Response.json({ url: `https://${qaObjectHost}/object?signature=short` });
      return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
    });
    const loader = new AllowlistedEvidenceLoader([], transport, { origin: "https://api.qa.nayori.ai",
      objectHost: qaObjectHost,
      accessToken: async () => "t".repeat(32) });
    const result = await loader.load(request);
    expect(result).toEqual([{ id: "result", sha256: item.sha256, text: bytes }]);
    expect(calls[0]!.authorization).toBe(`Bearer ${"t".repeat(32)}`); expect(calls[1]!.authorization).toBeNull();
  });
  it("rejects arbitrary private locators and signed-URL redirects", async () => {
    const transport = vi.fn();
    const loader = new AllowlistedEvidenceLoader([], transport, { origin: "https://api.qa.nayori.ai",
      objectHost: qaObjectHost,
      accessToken: async () => "t".repeat(32) });
    await expect(loader.load({ ...request, evidence: [{ ...item, uri: "https://api.qa.nayori.ai/other/id" }] } as EvaluationRequest)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects a non-Nayori S3 capability before fetching it", async () => {
    const transport = vi.fn(async () => Response.json({ url: "https://127.0.0.1/private" }));
    const loader = new AllowlistedEvidenceLoader([], transport, { origin: "https://api.qa.nayori.ai",
      objectHost: qaObjectHost,
      accessToken: async () => "t".repeat(32) });
    await expect(loader.load(request)).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
  });
  it("accepts the pinned production tuple and rejects a QA object host", async () => {
    const productionItem = { ...item, uri: item.uri.replace("api.qa.nayori.ai", "api.nayori.ai") };
    const productionHost = "perkos-nayori-prod-evidence-089332276762.s3.us-east-1.amazonaws.com";
    const good = new AllowlistedEvidenceLoader([], async (input) => String(input).endsWith("/download")
      ? Response.json({ url: `https://${productionHost}/object?signature=short` })
      : new Response(bytes), { origin: "https://api.nayori.ai", objectHost: productionHost,
      accessToken: async () => "t".repeat(32) });
    await expect(good.load({ ...request, evidence: [productionItem] } as EvaluationRequest)).resolves.toHaveLength(1);
    const crossed = new AllowlistedEvidenceLoader([], async () => Response.json({
      url: `https://${qaObjectHost}/object?signature=short` }), { origin: "https://api.nayori.ai",
      objectHost: productionHost, accessToken: async () => "t".repeat(32) });
    await expect(crossed.load({ ...request, evidence: [productionItem] } as EvaluationRequest)).rejects.toThrow();
  });
});
