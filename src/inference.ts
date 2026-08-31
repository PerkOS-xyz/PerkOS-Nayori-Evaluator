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
    readonly signal?: AbortSignal;
  }): Promise<T>;
}

export interface PerkOSLlmOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class PerkOSLlmInference implements StructuredInference {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: PerkOSLlmOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async complete<T>(input: {
    readonly model: string;
    readonly messages: readonly InferenceMessage[];
    readonly schema: ZodType<T>;
    readonly signal?: AbortSignal;
  }): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "x-perkos-workload-class": "nayori_evaluator_qa",
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        stream: false,
        response_format: { type: "json_object" },
        messages: input.messages,
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`PerkOS LLM returned HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("PerkOS LLM returned no structured content.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch {
      throw new Error("PerkOS LLM returned invalid JSON.");
    }
    return input.schema.parse(decoded);
  }
}
