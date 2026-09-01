import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
  EVALUATOR_ENV: z.literal("qa").default("qa"),
  STACKS_NETWORK: z.literal("testnet"),
  STX_COMMERCE_CONTRACT: z.string().regex(/^ST[A-Z0-9]+\.agentic-commerce-v5$/),
  SBTC_COMMERCE_CONTRACT: z.string().regex(/^ST[A-Z0-9]+\.sbtc-commerce-v4$/),
  EVALUATOR_PRINCIPAL: z.string().startsWith("ST"),
  EVALUATOR_PRIVATE_KEY: z.string().min(64),
  EVALUATOR_API_KEY: z.string().min(32),
  HERMES_API_BASE_URL: z.string().url(),
  HERMES_API_KEY: z.string().min(32),
  PRIMARY_MODEL: z.string().min(1),
  VERIFIER_MODEL: z.string().min(1),
  MIN_DECISION_CONFIDENCE: z.coerce.number().min(0.5).max(1).default(0.85),
  STACKS_API_URL: z.string().url().default("https://api.testnet.hiro.so"),
  TRANSACTION_FEE_USTX: z.coerce.number().int().min(1_000).max(100_000).default(5_000),
  INFERENCE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(240_000),
  DATABASE_URL: z.string().url(),
});

export type EvaluatorConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EvaluatorConfig {
  return configSchema.parse(env);
}

export function safeConfig(config: EvaluatorConfig) {
  return {
    environment: config.EVALUATOR_ENV,
    network: config.STACKS_NETWORK,
    stxContract: config.STX_COMMERCE_CONTRACT,
    sbtcContract: config.SBTC_COMMERCE_CONTRACT,
    evaluatorPrincipal: config.EVALUATOR_PRINCIPAL,
    hermesOrigin: new URL(config.HERMES_API_BASE_URL).origin,
    primaryModel: config.PRIMARY_MODEL,
    verifierModel: config.VERIFIER_MODEL,
  } as const;
}
