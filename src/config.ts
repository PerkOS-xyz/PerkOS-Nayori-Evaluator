import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
  EVALUATOR_ENV: z.literal("qa").default("qa"),
  STACKS_NETWORK: z.literal("testnet"),
  STX_COMMERCE_CONTRACT: z.string().regex(/^ST[A-Z0-9]+\.agentic-commerce-v5$/),
  SBTC_COMMERCE_CONTRACT: z.string().regex(/^ST[A-Z0-9]+\.sbtc-commerce-v4$/),
  EVALUATOR_PRINCIPAL: z.string().startsWith("ST"),
  PERKOS_LLM_BASE_URL: z.string().url(),
  PERKOS_LLM_API_KEY: z.string().min(20),
  PRIMARY_MODEL: z.string().min(1),
  VERIFIER_MODEL: z.string().min(1),
  MIN_DECISION_CONFIDENCE: z.coerce.number().min(0.5).max(1).default(0.85),
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
    primaryModel: config.PRIMARY_MODEL,
    verifierModel: config.VERIFIER_MODEL,
  } as const;
}
