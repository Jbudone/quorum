import type { AgentEvent, AgentTransport, SendOptions } from "./types.js";

/** A scripted reply; `match` is tested against the prompt, first hit wins. */
export interface MockRule {
  match?: RegExp;
  reply: string;
}

export interface MockOptions {
  rules: MockRule[];
  fallback?: string;
  /** Delay between streamed chunks, ms. 0 for tests. */
  chunkDelayMs?: number;
}

/** Deterministic, token-free transport for the playground and tests. */
export class MockTransport implements AgentTransport {
  private turn = 0;

  constructor(
    readonly id: string,
    private readonly opts: MockOptions,
  ) {}

  async *send(prompt: string, opts?: SendOptions): AsyncIterable<AgentEvent> {
    this.turn++;
    const rule = this.opts.rules.find((r) => !r.match || r.match.test(prompt));
    const reply = rule?.reply ?? this.opts.fallback ?? `[${this.id}] turn ${this.turn}`;
    for (const chunk of reply.match(/\S+\s*/g) ?? [reply]) {
      if (opts?.signal?.aborted) {
        yield { type: "error", message: "aborted" };
        return;
      }
      if (this.opts.chunkDelayMs) await new Promise((r) => setTimeout(r, this.opts.chunkDelayMs));
      yield { type: "text", delta: chunk };
    }
    yield { type: "usage", inputTokens: prompt.length >> 2, outputTokens: reply.length >> 2 };
    yield { type: "done", sessionId: `${this.id}-session` };
  }
}
