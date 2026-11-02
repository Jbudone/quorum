import {
  LangfuseSpan,
  LangfuseAgent,
  LangfuseGeneration,
  LangfuseTool,
  startObservation,
  getLangfuseTracerProvider,
  setLangfuseTracerProvider,
} from "@langfuse/tracing";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/**
 * Configuration for Langfuse tracing.
 */
interface LangfuseConfig {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment?: string;
  release?: string;
}

/**
 * Registers a tracer provider that exports to Langfuse. Without one, spans go to OpenTelemetry's
 * global no-op provider and are dropped. The provider is isolated (set only for Langfuse), so it
 * doesn't take over the global OpenTelemetry provider other libraries may use.
 */
function initLangfuse(config: LangfuseConfig): boolean {
  const { publicKey, secretKey, baseUrl, environment, release } = config;
  if (!publicKey || !secretKey) return false;
  try {
    const provider = new NodeTracerProvider({
      spanProcessors: [new LangfuseSpanProcessor({ publicKey, secretKey, ...(baseUrl ? { baseUrl } : {}), ...(environment ? { environment } : {}), ...(release ? { release } : {}) })],
    });
    setLangfuseTracerProvider(provider);
    return true;
  } catch {
    // A tracing setup problem must never stop a session.
    return false;
  }
}

/** Langfuse is on only when both keys are set; nothing is sent otherwise. */
export function langfuseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

/** One traced CLI call in a channel: a member's turn or a support role's one-shot. */
export interface TracedCall {
  usage(u: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void;
  end(text: string, failed?: string): void;
}

const NO_CALL: TracedCall = { usage() {}, end() {} };

/**
 * Type for observations that can be created.
 */
type ObservationType =
  | LangfuseSpan
  | LangfuseAgent
  | LangfuseGeneration
  | LangfuseTool
  | { end: () => void; update: (attrs: any) => void; startObservation: (name: string, attrs?: any, opts?: any) => any };

/**
 * Quorum-specific tracing wrapper for council sessions, rounds, and turns.
 */
export class QuorumTracing {
  private sessionTrace: LangfuseAgent | undefined;
  private currentRoundSpan: ObservationType | undefined;
  private enabled: boolean;

  constructor(config?: LangfuseConfig) {
    this.enabled = initLangfuse(config ?? {
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL,
      environment: process.env.NODE_ENV,
      release: process.env.GIT_COMMIT,
    });
  }

  /** Check if tracing is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Initialize a new trace for a council session.
   * Uses an agent-type observation for the overall session.
   */
  startSession(sessionId: string, userId?: string, topic?: string, config?: any): void {
    if (!this.enabled) return;

    this.sessionTrace = startObservation("council-session", {
      input: { topic, config },
      metadata: {
        sessionId,
        userId,
        environment: process.env.NODE_ENV,
        version: process.env.GIT_COMMIT,
        tags: ["quorum", "council"],
      },
    }, { asType: "agent" });
  }

  /** Start a trace for a single round. */
  startRound(round: number, agents: string[], plan?: string): ObservationType | undefined {
    if (!this.enabled || !this.sessionTrace) return undefined;

    this.currentRoundSpan = this.sessionTrace.startObservation(`round-${round}`, {
      input: { agents, plan: plan?.slice(0, 500) },
      metadata: { round, tags: ["round", "council"] },
    }, { asType: "span" });

    return this.currentRoundSpan;
  }

  /** Start a trace for a single agent turn. */
  startTurn(round: number, agent: string, prompt: string, model?: string): ObservationType | undefined {
    if (!this.enabled) return undefined;

    // Create a generation for the LLM call, nested under the round span if available
    const parent = this.currentRoundSpan;
    const turnSpan = (parent ?? this.sessionTrace ?? { startObservation: startObservation } as any).startObservation(
      `turn-${agent}`,
      {
        model: model ?? "quorum-cli",
        input: [{ role: "user", content: prompt.slice(0, 2000) }],
        metadata: { round, agent, tags: ["turn", "agent", agent, ...(model ? [`model:${model}`] : [])] },
      },
      { asType: "generation" }
    );

    return turnSpan;
  }

  /** Record the completion of a turn with the response. */
  endTurn(span: ObservationType | undefined, response: string, tldr?: any, usage?: any): void {
    if (!span) return;

    span.update({
      output: { content: response.slice(0, 4000), tldr },
      usageDetails: usage
        ? {
            promptTokens: usage.inputTokens,
            completionTokens: usage.outputTokens,
            totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          }
        : undefined,
      costDetails: usage?.costUsd ? { totalCost: usage.costUsd } : undefined,
    });
    span.end();
  }

  /** Record a tool call during a turn. */
  recordToolCall(parentSpan: ObservationType | undefined, toolName: string, input?: any, output?: any): void {
    if (!parentSpan) return;

    const toolSpan = parentSpan.startObservation(`tool-${toolName}`, {
      input,
      output,
      metadata: { tool: toolName, tags: ["tool", toolName] },
    }, { asType: "tool" });

    toolSpan.end();
  }

  /** Record an error. */
  recordError(span: ObservationType | undefined, error: Error | string): void {
    if (!span) return;

    const err = error instanceof Error ? error : new Error(String(error));
    span.update({
      level: "ERROR",
      statusMessage: err.message,
      metadata: { error: err.stack },
    });
  }

  /** Record usage/cost information. */
  recordUsage(span: ObservationType | undefined, usage: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
    if (!span) return;

    span.update({
      usageDetails: {
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
      costDetails: usage.costUsd ? { totalCost: usage.costUsd } : undefined,
    });
  }

  /**
   * Traces one CLI call in a channel. Each call is its own trace, grouped in Langfuse by the
   * channel id as the session, so a long-lived channel doesn't hold one span open for weeks.
   */
  call(o: { channel: string; channelName?: string; agent: string; role: "member" | "support"; cli: string; model?: string; prompt: string }): TracedCall {
    if (!this.enabled) return NO_CALL;
    try {
      const gen = startObservation(
        `${o.role}-${o.agent}`,
        {
          model: o.model ?? o.cli,
          input: [{ role: "user", content: o.prompt.slice(0, 2000) }],
          metadata: { channel: o.channel, channelName: o.channelName, agent: o.agent, role: o.role, cli: o.cli },
        },
        { asType: "generation" },
      );
      // Trace-level fields, set on the root span: the channel groups its calls as one Langfuse session.
      gen.otelSpan?.setAttributes({
        "langfuse.trace.name": `channel:${o.channelName ?? o.channel}`,
        "session.id": o.channel,
        "langfuse.trace.tags": ["quorum", "channel", o.role, o.agent],
      });
      let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
      return {
        usage: (u) => {
          usage = u;
        },
        end: (text, failed) => {
          try {
            if (failed) this.recordError(gen, failed); // before end: a span ignores updates once ended
            this.endTurn(gen, text, undefined, usage);
          } catch {
            // Tracing never breaks a turn.
          }
        },
      };
    } catch {
      return NO_CALL;
    }
  }

  /** End the current session trace. */
  endSession(output?: any): void {
    if (!this.enabled || !this.sessionTrace) return;

    this.sessionTrace.update({ output });
    this.sessionTrace.end();
    this.sessionTrace = undefined;
    this.currentRoundSpan = undefined;
  }

  /** Flush pending traces to Langfuse. */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    const provider = getLangfuseTracerProvider();
    // The Langfuse provider extends OTel TracerProvider with forceFlush
    const langfuseProvider = provider as any;
    if (langfuseProvider && typeof langfuseProvider.forceFlush === "function") {
      await langfuseProvider.forceFlush();
    }
  }

  /** Shutdown the Langfuse client. */
  async shutdown(): Promise<void> {
    if (!this.enabled) return;
    const provider = getLangfuseTracerProvider();
    const langfuseProvider = provider as any;
    if (langfuseProvider && typeof langfuseProvider.shutdown === "function") {
      await langfuseProvider.shutdown();
    }
    this.enabled = false;
  }
}

/** Singleton instance for global access. */
export const quorumTracing = new QuorumTracing();

/**
 * Helper to trace a turn execution with automatic span management.
 */
export async function traceTurn<T>(
  tracing: QuorumTracing,
  round: number,
  agent: string,
  prompt: string,
  execute: () => Promise<{ text: string; tldr?: any; usage?: any }>
): Promise<{ text: string; tldr?: any; usage?: any }> {
  const span = tracing.startTurn(round, agent, prompt);
  try {
    const result = await execute();
    tracing.endTurn(span, result.text, result.tldr, result.usage);
    return result;
  } catch (err) {
    tracing.recordError(span, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}