import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HermesInference } from "../src/inference.js";

const schema = z.object({ decision: z.literal("approve") });

describe("HermesInference", () => {
  it("uses isolated authenticated Responses sessions and validates JSON", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ content: [{ type: "output_text", text: '{"decision":"approve"}' }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const inference = new HermesInference({
      baseUrl: "https://api.llm.perkos.xyz/nayori-agent-qa/",
      apiKey: "h".repeat(32),
      fetch: fetchMock,
    });

    await expect(
      inference.complete({
        model: "test-model",
        messages: [
          { role: "system", content: "System policy" },
          { role: "user", content: "Untrusted evidence" },
        ],
        schema,
        sessionId: "nayori:evaluation:primary",
        idempotencyKey: "evaluation:primary",
      })
    ).resolves.toEqual({ decision: "approve" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.llm.perkos.xyz/nayori-agent-qa/v1/responses");
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${"h".repeat(32)}`,
      "idempotency-key": "evaluation:primary",
      "x-hermes-session-id": "nayori:evaluation:primary",
      "x-hermes-session-key": "nayori:evaluation:primary",
    });
  });

  it("fails closed on incomplete or non-JSON output", async () => {
    const incomplete = new HermesInference({
      baseUrl: "https://example.com",
      apiKey: "h".repeat(32),
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ status: "incomplete", output: [] }), { status: 200 })
      ),
    });
    const input = {
      model: "test",
      messages: [
        { role: "system" as const, content: "policy" },
        { role: "user" as const, content: "evidence" },
      ],
      schema,
      sessionId: "session",
      idempotencyKey: "request",
    };
    await expect(incomplete.complete(input)).rejects.toThrow("did not complete");

    const malformed = new HermesInference({
      baseUrl: "https://example.com",
      apiKey: "h".repeat(32),
      fetch: vi.fn(async () =>
        new Response(
          JSON.stringify({ status: "completed", output: [{ content: [{ text: "not json" }] }] }),
          { status: 200 }
        )
      ),
    });
    await expect(malformed.complete(input)).rejects.toThrow("invalid JSON");
  });
});
