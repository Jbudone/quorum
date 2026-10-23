import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { AgentEvent, AgentTransport, SendOptions } from "../transports/types.js";

/** Splits an AI SDK prompt into the pieces a CLI transport takes. */
export function flattenPrompt(prompt: LanguageModelV4Prompt): { system: string; full: string; last: string } {
  const system: string[] = [];
  const turns: { role: string; text: string }[] = [];
  for (const m of prompt) {
    if (m.role === "system") {
      system.push(m.content);
      continue;
    }
    if (m.role === "tool") continue; // council agents have no AI-SDK tools; the CLIs run their own
    const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    if (text) turns.push({ role: m.role, text });
  }
  const last = [...turns].reverse().find((t) => t.role === "user")?.text ?? "";
  const full =
    turns.length <= 1 ? last : turns.map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`).join("\n\n");
  return { system: system.join("\n\n"), full, last };
}

function usage(inputTokens?: number, outputTokens?: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "end_turn" };

/**
 * A Mastra/AI-SDK language model backed by a subscription CLI transport, so Mastra Agents run
 * without API keys. Vendor sessions are resumed across calls, so after the first call only the
 * newest user message is sent (the CLI already holds the history).
 */
export class CliModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly supportedUrls = {};
  private vendorSession: string | undefined;

  constructor(
    readonly transport: AgentTransport,
    private readonly defaults: SendOptions = {},
    /** Observes every normalized event (quota meter, tool activity) alongside the AI-SDK stream. */
    private readonly onEvent?: (e: AgentEvent) => void,
  ) {}

  get provider(): string {
    return "quorum-cli";
  }
  get modelId(): string {
    return this.transport.id;
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<{ stream: ReadableStream<LanguageModelV4StreamPart> }> {
    const source = this.run(options);
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        let open = false;
        let inTok: number | undefined;
        let outTok: number | undefined;
        let finish = STOP;
        try {
          for await (const e of source) {
            if (e.type === "text") {
              if (!open) {
                controller.enqueue({ type: "text-start", id: "t0" });
                open = true;
              }
              controller.enqueue({ type: "text-delta", id: "t0", delta: e.delta });
            } else if (e.type === "usage" && e.inputTokens !== undefined) {
              inTok = e.inputTokens;
              outTok = e.outputTokens;
            } else if (e.type === "error") {
              finish = { unified: "error", raw: e.message };
              controller.enqueue({ type: "error", error: new Error(e.message) });
            }
          }
        } catch (err) {
          finish = { unified: "error", raw: String(err) };
          controller.enqueue({ type: "error", error: err });
        }
        if (open) controller.enqueue({ type: "text-end", id: "t0" });
        controller.enqueue({ type: "finish", usage: usage(inTok, outTok), finishReason: finish });
        controller.close();
      },
    });
    return { stream };
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    let text = "";
    let inTok: number | undefined;
    let outTok: number | undefined;
    let finish = STOP;
    for await (const e of this.run(options)) {
      if (e.type === "text") text += e.delta;
      else if (e.type === "usage" && e.inputTokens !== undefined) [inTok, outTok] = [e.inputTokens, e.outputTokens];
      else if (e.type === "error") finish = { unified: "error", raw: e.message };
    }
    return {
      content: text ? [{ type: "text" as const, text }] : [],
      finishReason: finish,
      usage: usage(inTok, outTok),
      warnings: [],
    };
  }

  /** Runs the transport once, tracking the vendor session and forwarding raw events. */
  private async *run(options: LanguageModelV4CallOptions): AsyncGenerator<AgentEvent> {
    const { system, full, last } = flattenPrompt(options.prompt);
    const resumed = this.vendorSession !== undefined;
    const systemPrompt = [this.defaults.systemPrompt, system].filter(Boolean).join("\n\n") || undefined;
    for await (const e of this.transport.send(resumed ? last : full, {
      ...this.defaults,
      systemPrompt,
      sessionId: this.vendorSession,
      signal: options.abortSignal,
    })) {
      if (e.type === "done" && e.sessionId) this.vendorSession = e.sessionId;
      this.onEvent?.(e);
      yield e;
    }
  }
}
