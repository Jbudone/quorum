import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { QuorumTracing, langfuseConfigured } from "../src/tracing.js";

// Create a mock observation factory
function createMockObservation(id: string, traceId: string) {
  return {
    id,
    traceId,
    update: vi.fn().mockReturnThis(),
    end: vi.fn(),
    otelSpan: { setAttributes: vi.fn() },
    startObservation: vi.fn().mockImplementation((name: string, attrs: any, opts: any) => {
      return createMockObservation(`child-${id}`, traceId);
    }),
  };
}

const mockAgent = createMockObservation("agent-123", "trace-123");
const mockSpan = createMockObservation("span-123", "trace-123");

// The real span processor and provider would try to reach Langfuse.
vi.mock("@langfuse/otel", () => ({ LangfuseSpanProcessor: vi.fn() }));
vi.mock("@opentelemetry/sdk-trace-node", () => ({ NodeTracerProvider: vi.fn() }));

// Mock the @langfuse/tracing module
vi.mock("@langfuse/tracing", () => {
  return {
    LangfuseSpan: vi.fn(),
    LangfuseAgent: vi.fn(),
    LangfuseGeneration: vi.fn(),
    LangfuseTool: vi.fn(),
    startObservation: vi.fn().mockImplementation((name: string, attrs: any, opts: any) => {
      if (opts?.asType === "agent") return mockAgent;
      if (opts?.asType === "generation") return createMockObservation(`gen-${name}`, "trace-123");
      return mockSpan;
    }),
    getLangfuseTracerProvider: vi.fn().mockReturnValue({
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }),
    setLangfuseTracerProvider: vi.fn(),
  };
});

describe("QuorumTracing", () => {
  let tracing: QuorumTracing;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.NODE_ENV = "test";
    tracing = new QuorumTracing();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it("is enabled when credentials are provided", () => {
    expect(tracing.isEnabled()).toBe(true);
  });

  it("is disabled when credentials are missing", () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const disabledTracing = new QuorumTracing();
    expect(disabledTracing.isEnabled()).toBe(false);
  });

  it("starts a session trace", () => {
    tracing.startSession("session-123", "user-456", "Test topic", { protocol: "round-robin" });
    expect(tracing.isEnabled()).toBe(true);
  });

  it("starts a round span", () => {
    tracing.startSession("session-123");
    const roundSpan = tracing.startRound(1, ["agent-1", "agent-2"], "Plan content");
    expect(roundSpan).toBeDefined();
    expect(roundSpan?.update).toBeDefined();
    expect(roundSpan?.end).toBeDefined();
  });

  it("starts a turn generation", () => {
    tracing.startSession("session-123");
    tracing.startRound(1, ["agent-1"]);
    const turnSpan = tracing.startTurn(1, "agent-1", "Test prompt");
    expect(turnSpan).toBeDefined();
    expect(turnSpan?.update).toBeDefined();
    expect(turnSpan?.end).toBeDefined();
  });

  it("ends a turn with response", () => {
    tracing.startSession("session-123");
    tracing.startRound(1, ["agent-1"]);
    const turnSpan = tracing.startTurn(1, "agent-1", "Test prompt");
    tracing.endTurn(turnSpan, "Test response", { headline: "Test" }, { inputTokens: 10, outputTokens: 20 });
    expect(turnSpan?.update).toHaveBeenCalled();
    expect(turnSpan?.end).toHaveBeenCalled();
  });

  it("records tool calls", () => {
    tracing.startSession("session-123");
    tracing.startRound(1, ["agent-1"]);
    const turnSpan = tracing.startTurn(1, "agent-1", "Test prompt");
    tracing.recordToolCall(turnSpan, "search", { query: "test" }, { results: [] });
    expect(turnSpan?.startObservation).toHaveBeenCalled();
  });

  it("records errors", () => {
    tracing.startSession("session-123");
    tracing.startRound(1, ["agent-1"]);
    const turnSpan = tracing.startTurn(1, "agent-1", "Test prompt");
    tracing.recordError(turnSpan, new Error("Test error"));
    expect(turnSpan?.update).toHaveBeenCalledWith(
      expect.objectContaining({ level: "ERROR", statusMessage: "Test error" })
    );
  });

  it("flushes and shuts down", async () => {
    await tracing.flush();
    await tracing.shutdown();
    expect(tracing.isEnabled()).toBe(false);
  });

  it("registers a Langfuse tracer provider, so spans aren't dropped", () => {
    expect(setLangfuseTracerProvider).toHaveBeenCalled();
  });

  it("registers nothing and traces nothing without keys", () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    vi.clearAllMocks();
    const off = new QuorumTracing();
    expect(langfuseConfigured()).toBe(false);
    expect(setLangfuseTracerProvider).not.toHaveBeenCalled();
    const call = off.call({ channel: "c1", agent: "pm-lead", role: "member", cli: "claude", prompt: "hi" });
    call.usage({ inputTokens: 1 });
    call.end("reply");
    expect(startObservation).not.toHaveBeenCalled();
  });

  it("traces a channel call grouped by channel, with usage and errors", () => {
    const call = tracing.call({ channel: "room-1", channelName: "loom", agent: "pm-lead", role: "member", cli: "claude", model: "opus", prompt: "p".repeat(5000) });
    const gen = vi.mocked(startObservation).mock.results.at(-1)!.value;
    const [, attrs] = vi.mocked(startObservation).mock.calls.at(-1)!;
    expect((attrs as any).input[0].content).toHaveLength(2000);
    expect(gen.otelSpan.setAttributes).toHaveBeenCalledWith(expect.objectContaining({ "session.id": "room-1", "langfuse.trace.name": "channel:loom" }));
    call.usage({ inputTokens: 10, outputTokens: 5 });
    call.end("", "aborted");
    // The error lands before the span ends; an ended span ignores updates.
    const order = gen.update.mock.invocationCallOrder;
    expect(gen.update).toHaveBeenCalledWith(expect.objectContaining({ level: "ERROR", statusMessage: "aborted" }));
    expect(Math.max(...order)).toBeLessThan(gen.end.mock.invocationCallOrder[0]);
  });
});
