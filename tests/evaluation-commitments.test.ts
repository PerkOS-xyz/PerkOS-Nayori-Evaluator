import { describe, expect, it } from "vitest";
import { prepareEvaluationJob, prepareEvaluationSubmission, parseEvaluationDescription, evaluationJobId } from "../src/evaluation-commitments.js";

const input = {
  network: "testnet" as const, asset: "sbtc" as const,
  contract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5",
  client: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5",
  evaluator: "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4",
  provider: "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9",
  description: "Return the verified count", jobId: "7",
  acceptanceCriteria: [{ id: "count", requirement: "Count is 3", verification: "Parse JSON and compare count" }],
  evidence: [{ id: "result", uri: "https://example.com/result.json", sha256: "11".repeat(32), mediaType: "application/json", sizeBytes: 11 }],
};
describe("Nayori v1 wire commitments", () => {
  it("round-trips and fits the existing description and buff64 ABIs", async () => {
    const result = await prepareEvaluationSubmission(input);
    expect(parseEvaluationDescription(result.description)).toEqual({ description: input.description, criteriaHash: result.criteriaHash });
    expect(result.deliverable.length).toBe(36);
    expect(new TextDecoder().decode(result.deliverable.slice(0, 4))).toBe("ny1:");
    expect(Buffer.from(result.deliverable.slice(4)).toString("hex")).toBe(result.evidenceHash);
    expect(result.description.length).toBeLessThanOrEqual(512);
  });
  it("has a stable cross-repository fixture", async () => {
    const result = await prepareEvaluationSubmission(input);
    expect(result.criteriaHash).toBe("0c76162899c8a456c0f3031703124f84a44e229acd38b0854d39c9eca02f44da");
    expect(result.evidenceHash).toBe("877a7ae17c19e3fecdbf95e3b044650e35d0ae2220bbecff0783648476290c33");
    expect(await prepareEvaluationSubmission({ ...input })).toEqual(result);
  });
  it.each(["description", "client", "evaluator", "contract", "asset"] as const)("binds criteria to %s", async field => {
    const result = await prepareEvaluationJob(input);
    const replacement = field === "asset" ? "stx" : field === "description" ? "Other task" :
      field === "contract" ? input.contract.replace("v5", "v4") : input.provider;
    const changed = await prepareEvaluationJob({ ...input, [field]: replacement });
    expect(changed.criteriaHash).not.toBe(result.criteriaHash);
  });
  it("binds evidence to job id and provider", async () => {
    const base = await prepareEvaluationSubmission(input);
    expect((await prepareEvaluationSubmission({ ...input, jobId: "8" })).evidenceHash).not.toBe(base.evidenceHash);
    expect((await prepareEvaluationSubmission({ ...input, provider: "ST1E7E64H8VSSSGE0RPWF90RRC91MQG7CRQRM1BFX" })).evidenceHash).not.toBe(base.evidenceHash);
  });
  it("binds every evidence field", async () => {
    const base = await prepareEvaluationSubmission(input);
    for (const changed of [{ uri: "https://example.com/other" }, { sha256: "22".repeat(32) },
      { sizeBytes: 12 }, { mediaType: "text/plain" }, { id: "other" }]) {
      expect((await prepareEvaluationSubmission({ ...input, evidence: [{ ...input.evidence[0]!, ...changed }] })).evidenceHash).not.toBe(base.evidenceHash);
    }
  });
  it("rejects duplicate IDs, spoofed markers, oversized descriptions and invalid Unicode", async () => {
    for (const change of [
      { acceptanceCriteria: [...input.acceptanceCriteria, ...input.acceptanceCriteria] },
      { description: "Spoof nayori-criteria-v1:" }, { description: "a".repeat(512) },
      { description: "a\ud800" },
    ]) await expect(prepareEvaluationJob({ ...input, ...change })).rejects.toThrow();
    await expect(prepareEvaluationSubmission({ ...input, evidence: [...input.evidence, ...input.evidence] })).rejects.toThrow();
  });
  it.each(["http://example.com/a", "https://user:password@example.com/a", "file:///tmp/evidence", "https://example.com/a#b"])("rejects unsafe evidence URI %s", async uri => {
    await expect(prepareEvaluationSubmission({ ...input, evidence: [{ ...input.evidence[0]!, uri }] })).rejects.toThrow();
  });
  it("rejects mainnet and oversized/non-canonical job IDs", async () => {
    await expect(prepareEvaluationJob({ ...input, network: "mainnet" as "testnet" })).rejects.toThrow();
    for (const jobId of ["0", "01", "-1", (2n ** 128n).toString()]) {
      await expect(prepareEvaluationSubmission({ ...input, jobId })).rejects.toThrow();
    }
  });
  it("assigns stable unique job-scoped identifiers", async () => {
    const key = { network: input.network, contract: input.contract, jobId: input.jobId };
    expect(await evaluationJobId(key)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await evaluationJobId(key)).not.toBe(await evaluationJobId({ ...key, jobId: "8" }));
  });
});
