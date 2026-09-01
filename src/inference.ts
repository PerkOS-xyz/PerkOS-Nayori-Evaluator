import type { ZodType } from "zod";

export interface InferenceMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface StructuredInference {
  complete<T>(input: {
    readonly model: string;
    readonly messages: readonly InferenceMessage[];
    readonly schema: ZodType<T>;
    readonly sessionId: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<T>;
}

export interface HermesInferenceOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class HermesInference implements StructuredInference {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: HermesInferenceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async complete<T>(input: {
    readonly model: string;
    readonly messages: readonly InferenceMessage[];
    readonly schema: ZodType<T>;
    readonly sessionId: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<T> {
    const system = input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const user = input.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n\n");
    if (!system || !user) throw new Error("Hermes inference requires system and user messages.");

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await this.fetch(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey,
        "x-hermes-session-id": input.sessionId,
        "x-hermes-session-key": input.sessionId,
        "x-perkos-workload-class": "nayori_evaluator_qa",
      },
      body: JSON.stringify({
        model: input.model,
        instructions: `${system}\n\nReturn exactly one JSON object. Do not use Markdown fences or commentary.`,
        input: user,
        store: true,
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Hermes returned HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as {
      status?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    if (payload.status !== "completed") throw new Error("Hermes response did not complete.");
    const content = payload.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text?.trim())
      .find(Boolean);
    if (!content) throw new Error("Hermes returned no structured content.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch {
      throw new Error("Hermes returned invalid JSON.");
    }
    return input.schema.parse(decoded);
  }
}
