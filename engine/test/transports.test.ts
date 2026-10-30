import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgyMapper, AgyTransport } from "../src/transports/agy.js";
import { CodexMapper, CodexTransport } from "../src/transports/codex.js";
import { GeminiMapper, GeminiTransport } from "../src/transports/gemini.js";
import { OpencodeMapper, OpencodeTransport } from "../src/transports/opencode.js";
import type { LineMapper } from "../src/transports/subprocess.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);

const run = (m: LineMapper, lines: string[]) => [...lines.flatMap((l) => m.push(l)), ...m.end()];
const textOf = (evs: ReturnType<typeof run>) => evs.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");

describe("CodexMapper (real capture)", () => {
  const evs = run(new CodexMapper(), fixture("codex-simple.ndjson"));
  it("keeps only the final answer, not the narration before tool calls", () => {
    const text = textOf(evs);
    expect(text).toContain("login(userId)");
    expect(text).not.toContain("I’ll read");
  });
  it("reports tool use, usage and the thread id for resume", () => {
    expect(evs.some((e) => e.type === "tool" && e.name === "shell")).toBe(true);
    expect(evs.some((e) => e.type === "usage" && (e.inputTokens ?? 0) > 0)).toBe(true);
    expect(evs.at(-1)).toEqual({ type: "done", sessionId: "SESSION" });
  });
  it("ignores config-warning items but surfaces failures", () => {
    const m = new CodexMapper();
    expect(m.push('{"type":"item.completed","item":{"type":"error","message":"ignoring setting"}}')).toEqual([]);
    expect(m.push('{"type":"turn.failed","error":{"message":"quota exceeded"}}')).toEqual([
      { type: "error", message: "quota exceeded" },
    ]);
  });
});

describe("CodexTransport args", () => {
  const t = new CodexTransport();
  const inv = (o = {}) => (t as any).invocation("hello", o);
  it("sets a read-only sandbox through config so resume honors it", () => {
    expect(inv().args).toContain('sandbox_mode="read-only"');
    expect(inv({ readOnly: false }).args).toContain('sandbox_mode="workspace-write"');
  });
  it("uses `exec resume <id>` and omits the persona when resuming", () => {
    const a = inv({ sessionId: "abc", systemPrompt: "skeptic" });
    expect(a.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(a.args).toContain("abc");
    expect(a.stdin).not.toContain("skeptic");
    expect(inv({ systemPrompt: "skeptic" }).stdin).toContain("<role>\nskeptic");
  });
});

describe("OpencodeMapper (real capture)", () => {
  const evs = run(new OpencodeMapper(), fixture("opencode-simple.ndjson"));
  it("returns the answer and the session id", () => {
    expect(textOf(evs).length).toBeGreaterThan(20);
    expect(evs.some((e) => e.type === "tool")).toBe(true);
    expect(evs.at(-1)).toEqual({ type: "done", sessionId: "SESSION" });
  });
  it("drops text from steps that ended in tool calls", () => {
    const m = new OpencodeMapper();
    const lines = [
      '{"type":"text","sessionID":"s","part":{"text":"let me look"}}',
      '{"type":"tool_use","sessionID":"s","part":{"tool":"read"}}',
      '{"type":"step_finish","sessionID":"s","part":{"reason":"tool-calls","tokens":{"input":1,"output":1}}}',
      '{"type":"text","sessionID":"s","part":{"text":"the answer"}}',
      '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{"input":1,"output":1}}}',
    ];
    expect(textOf(run(m, lines))).toBe("the answer");
  });
});

describe("OpencodeTransport invocation", () => {
  const inv = (o = {}) => (new OpencodeTransport() as any).invocation("hello", o);
  it("denies edits and shell, and disables Claude-compat instruction loading", () => {
    const i = inv({ systemPrompt: "be a skeptic", cwd: "/repo" });
    const cfg = JSON.parse(i.env.OPENCODE_CONFIG_CONTENT).agent.quorum;
    expect(cfg.permission).toMatchObject({ edit: "deny", bash: "deny" });
    expect(cfg.prompt).toBe("be a skeptic");
    expect(i.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(i.cwd).toBe("/repo");
    expect(i.args).toContain("--standalone");
  });
  it("resumes with -s", () => {
    expect(inv({ sessionId: "ses_1" }).args).toEqual(expect.arrayContaining(["-s", "ses_1"]));
  });
});

// Gemini CLI sign-in is rejected for the dev account, so these use the documented event shape, not a capture.
describe("GeminiMapper (documented shape, not a live capture)", () => {
  it("collects assistant message chunks and ignores user echo", () => {
    const evs = run(new GeminiMapper(), [
      '{"type":"init","session_id":"g1","model":"gemini"}',
      '{"type":"message","role":"user","content":"hi"}',
      '{"type":"message","role":"assistant","content":"Hello ","delta":true}',
      '{"type":"message","role":"assistant","content":"there","delta":true}',
      '{"type":"result","status":"success","stats":{"input_tokens":5,"output_tokens":2}}',
    ]);
    expect(textOf(evs)).toBe("Hello there");
    expect(evs.at(-1)).toEqual({ type: "done", sessionId: "g1" });
  });
  it("runs in plan mode and surfaces failed results", () => {
    expect((new GeminiTransport() as any).invocation("x", {}).args).toEqual(expect.arrayContaining(["--approval-mode", "plan"]));
    expect(new GeminiMapper().push('{"type":"result","status":"error","error":{"message":"nope"}}')).toEqual([
      { type: "error", message: "nope" },
    ]);
  });
});

describe("AgyMapper (real capture)", () => {
  const evs = run(new AgyMapper(), fixture("agy-simple.ndjson"));
  it("keeps only the answer after the last tool call, not the narration", () => {
    const text = textOf(evs);
    expect(text).toContain("auth.ts");
    expect(text).not.toContain("I will start by reading");
    expect(text).not.toContain("I will now create the implementation plan");
  });
  it("reports tools, usage and the conversation id for resume", () => {
    expect(evs.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name)).toEqual(["read_file", "write_file"]);
    expect(evs.some((e) => e.type === "usage" && (e.inputTokens ?? 0) > 0)).toBe(true);
    expect(evs.at(-1)).toEqual({ type: "done", sessionId: "SESSION" });
  });
  it("surfaces failed results as errors and emits no done", () => {
    const m = new AgyMapper();
    const evs2 = run(m, ['{"event":"result","result":{"status":"ERROR","error":"unknown model"}}']);
    expect(evs2).toEqual([{ type: "error", message: "unknown model" }]);
  });
});

describe("AgyTransport invocation", () => {
  const inv = (o = {}) => (new AgyTransport("a", { model: "gemini-4-argon-medium" }) as any).invocation("hello", o);
  it("is read-only via plan mode and never disables slash commands (that would silently disable plan mode)", () => {
    const i = inv({ cwd: "/repo" });
    expect(i.args.slice(i.args.indexOf("--mode"), i.args.indexOf("--mode") + 2)).toEqual(["--mode", "plan"]);
    expect(i.args).not.toContain("--disable-slash-commands");
    expect(i.args).toEqual(expect.arrayContaining(["--add-dir", "/repo", "--model", "gemini-4-argon-medium"]));
    expect(inv({ readOnly: false }).args).toContain("accept-edits");
  });
  it("sends the prompt as a stream-json user event on stdin, with the persona only on a fresh conversation", () => {
    const fresh = JSON.parse(inv({ systemPrompt: "skeptic" }).stdin);
    expect(fresh).toMatchObject({ event: "user" });
    expect(fresh.message.content).toContain("<role>\nskeptic");
    const resumed = inv({ systemPrompt: "skeptic", sessionId: "c1" });
    expect(resumed.args).toEqual(expect.arrayContaining(["--conversation", "c1"]));
    expect(JSON.parse(resumed.stdin).message.content).not.toContain("skeptic");
  });
});
