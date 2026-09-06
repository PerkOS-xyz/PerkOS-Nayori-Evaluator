import { z } from "zod";
import { commerceContractsSchema, hasServiceFees, isTestnetApiUrl, testnetPrincipal } from "./contracts.js";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
  EVALUATOR_ENV: z.literal("qa").default("qa"),
  STACKS_NETWORK: z.literal("testnet"),
  STX_COMMERCE_CONTRACT: z.string(),
  SBTC_COMMERCE_CONTRACT: z.string(),
  EVALUATOR_PRINCIPAL: testnetPrincipal,
  EVALUATOR_PRIVATE_KEY: z.string().min(64),
  EVALUATOR_API_KEY: z.string().min(32),
  HERMES_API_BASE_URL: z.string().url(),
  HERMES_API_KEY: z.string().min(32),
  PRIMARY_MODEL: z.string().min(1),
  VERIFIER_MODEL: z.string().min(1),
  MIN_DECISION_CONFIDENCE: z.coerce.number().min(0.5).max(1).default(0.85),
  STACKS_API_URL: z.string().url().refine(isTestnetApiUrl, "Only the public Stacks testnet API is allowed.").default("https://api.testnet.hiro.so"),
  TRANSACTION_FEE_USTX: z.coerce.number().int().min(1_000).max(100_000).default(5_000),
  INFERENCE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(240_000),
  DATABASE_URL: z.string().url(),
  PUBLIC_COMMITTED_EVALUATIONS: z.enum(["true", "false"]).default("false"),
  EVIDENCE_ALLOWED_ORIGINS: z.string().default(""),
  PUBLIC_EVALUATIONS_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  PUBLIC_EVALUATIONS_QUEUE_LIMIT: z.coerce.number().int().min(1).max(20).default(5),
  PUBLIC_EVALUATIONS_MIN_STX: z.string().regex(/^[1-9][0-9]{0,20}$/).default("100000"),
  PUBLIC_EVALUATIONS_MIN_SBTC: z.string().regex(/^[1-9][0-9]{0,20}$/).default("1000"),
}).refine(config => commerceContractsSchema.safeParse({
  stxContract: config.STX_COMMERCE_CONTRACT,
  sbtcContract: config.SBTC_COMMERCE_CONTRACT,
}).success, "Invalid QA commerce contract pair.");

export type EvaluatorConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EvaluatorConfig {
  return configSchema.parse(env);
}

/** Two models, at most one repair each, two read gates, and bounded nonce/broadcast requests. */
export function evaluationLeaseSeconds(config: Pick<EvaluatorConfig, "INFERENCE_TIMEOUT_MS">): number {
  return Math.ceil((4 * config.INFERENCE_TIMEOUT_MS + 2 * 8 * 18_000 + 2 * 15_000 + 60_000) / 1000);
}

export function safeConfig(config: EvaluatorConfig) {
  const fees = hasServiceFees({ stxContract: config.STX_COMMERCE_CONTRACT, sbtcContract: config.SBTC_COMMERCE_CONTRACT });
  return {
    environment: config.EVALUATOR_ENV,
    network: config.STACKS_NETWORK,
    stxContract: config.STX_COMMERCE_CONTRACT,
    sbtcContract: config.SBTC_COMMERCE_CONTRACT,
    commerceGeneration: fees ? "service-fee-v6-v5" : "autonomous-v5-v4",
    earnedServiceFeeBps: fees ? 200 : 0,
    evaluatorPrincipal: config.EVALUATOR_PRINCIPAL,
    committedEvaluationsEnabled: config.PUBLIC_COMMITTED_EVALUATIONS === "true",
    hermesOrigin: new URL(config.HERMES_API_BASE_URL).origin,
    primaryModel: config.PRIMARY_MODEL,
    verifierModel: config.VERIFIER_MODEL,
  } as const;
}
