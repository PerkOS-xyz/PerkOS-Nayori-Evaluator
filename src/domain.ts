import { z } from "zod";

const hash32 = z
  .string()
  .regex(/^(?:0x)?[0-9a-fA-F]{64}$/)
  .refine((value) => !/^(?:0x)?0{64}$/i.test(value), "digest must be non-zero")
  .transform((value) => value.replace(/^0x/, "").toLowerCase());

export const acceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  requirement: z.string().min(1).max(1_024),
  verification: z.string().min(1).max(1_024),
});

export const evidenceItemSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  uri: z.string().url().max(2_048),
  sha256: hash32,
  mediaType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative().max(25_000_000),
});

export const evaluationRequestSchema = z.object({
  evaluationId: z.string().uuid(),
  network: z.literal("testnet"),
  asset: z.enum(["stx", "sbtc"]),
  contract: z.string().regex(/^ST[A-Z0-9]+\.[a-z][a-z0-9-]{0,39}$/),
  jobId: z.string().regex(/^[1-9][0-9]*$/),
  job: z.object({
    client: z.string().startsWith("ST"),
    provider: z.string().startsWith("ST"),
    evaluator: z.string().startsWith("ST"),
    status: z.literal("submitted"),
    reviewDeadlineBurn: z.string().regex(/^[1-9][0-9]*$/),
    description: z.string().min(1).max(512),
  }),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(20),
  evidence: z.array(evidenceItemSchema).min(1).max(50),
});

export const reasonCodeSchema = z.enum([
  "all_criteria_met",
  "criterion_failed",
  "evidence_missing",
  "evidence_invalid",
  "execution_failed",
  "unsafe_output",
]);

export const criterionResultSchema = z.object({
  criterionId: z.string().min(1).max(64),
  outcome: z.enum(["pass", "fail", "insufficient"]),
  evidenceIds: z.array(z.string().min(1).max(64)).max(50),
  summary: z.string().min(1).max(280),
});

export const modelDecisionSchema = z.object({
  schemaVersion: z.literal("1"),
  decision: z.enum(["approve", "reject", "manual_review"]),
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(reasonCodeSchema).min(1).max(8),
  criteria: z.array(criterionResultSchema).min(1).max(20),
  publicExplanation: z.string().min(1).max(1_024),
});

export const verificationSchema = z.object({
  schemaVersion: z.literal("1"),
  agrees: z.boolean(),
  decision: z.enum(["approve", "reject", "manual_review"]),
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(reasonCodeSchema).min(1).max(8),
  summary: z.string().min(1).max(512),
});

export type EvaluationRequest = z.infer<typeof evaluationRequestSchema>;
export type ModelDecision = z.infer<typeof modelDecisionSchema>;
export type Verification = z.infer<typeof verificationSchema>;

export interface EvaluationArtifact {
  readonly evaluationId: string;
  readonly network: "testnet";
  readonly asset: "stx" | "sbtc";
  readonly contract: string;
  readonly jobId: string;
  readonly decision: "approve" | "reject";
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly publicExplanation: string;
  readonly evidenceHash: string;
  readonly explanationHash: string;
  readonly schemaVersion: "1";
  readonly policyVersion: string;
  readonly promptVersion: string;
  readonly primaryModel: string;
  readonly verifierModel: string;
  readonly createdAt: string;
}
