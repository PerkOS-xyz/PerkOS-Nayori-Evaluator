import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AllowlistedEvidenceLoader } from "../src/evidence.js";
import type { EvaluationRequest } from "../src/domain.js";

const body = '{"count":3}';
const hash = createHash("sha256").update(body).digest("hex");
const item = { id: "result", uri: "https://evidence.example/result.json",
  sha256: hash, sizeBytes: Buffer.byteLength(body), mediaType: "application/json" };
const request = { evidence: [item] } as EvaluationRequest;
describe("Bounded verified evidence loader", () => {
  it("checks actual bytes and supplies text, not executable instructions", async () => {
    const transport = vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } }));
    const loader = new AllowlistedEvidenceLoader(["https://evidence.example"], transport);
    expect(await loader.load(request)).toEqual([{ id: "result", sha256: hash, text: body }]);
    expect(transport).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      redirect: "error", credentials: "omit", signal: expect.any(AbortSignal),
    }));
  });
  it("rejects non-allowlisted origins before network access", async () => {
    const transport = vi.fn();
    await expect(new AllowlistedEvidenceLoader([], transport).load(request)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["https://127.0.0.1", "https://localhost", "https://host.local", "http://evidence.example",
    "https://user:password@evidence.example", "https://evidence.example/path", "https://[::1]"])("rejects unsafe configured origin %s", origin => {
    expect(() => new AllowlistedEvidenceLoader([origin])).toThrow();
  });
  it.each([{ sha256: "22".repeat(32) }, { sizeBytes: 1 }, { mediaType: "text/html" }, { sizeBytes: 8193 }])("rejects altered or unsupported evidence %j", change => {
    const loader = new AllowlistedEvidenceLoader(["https://evidence.example"],
      async () => new Response(body, { headers: { "content-type": "application/json" } }));
    return expect(loader.load({ ...request, evidence: [{ ...item, ...change }] })).rejects.toThrow();
  });
  it("rejects redirects, invalid JSON and MIME mismatch", async () => {
    for (const response of [new Response(null, { status: 302 }), new Response(body, { headers: { "content-type": "text/html" } })]) {
      await expect(new AllowlistedEvidenceLoader(["https://evidence.example"], async () => response).load(request)).rejects.toThrow();
    }
    const invalid = "not json";
    await expect(new AllowlistedEvidenceLoader(["https://evidence.example"], async () => new Response(invalid,
      { headers: { "content-type": "application/json" } })).load({ ...request, evidence: [{
        ...item, sizeBytes: invalid.length, sha256: createHash("sha256").update(invalid).digest("hex"),
      }] })).rejects.toThrow();
  });
  it("caps manifest count before any fetch", async () => {
    const transport = vi.fn();
    await expect(new AllowlistedEvidenceLoader(["https://evidence.example"], transport)
      .load({ ...request, evidence: Array.from({ length: 6 }, () => item) })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
