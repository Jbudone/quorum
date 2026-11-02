import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFile, ARG_LIMIT, KimiMapper, KimiTransport, promptArg } from "../src/transports/kimi.js";
import { ZCODE_WRITE_TOOLS, ZCODE_WEB_TOOLS, ZcodeMapper, ZcodeTransport } from "../src/transports/zcode.js";
import type { AgentEvent } from "../src/transports/types.js";

const feed = (m: { push(l: string): AgentEvent[]; end(): AgentEvent[] }, lines: string[]) => [...lines.flatMap((l) => m.push(l)), ...m.end()];

// Captured from kimi 2.4.0 `-p … --output-format stream-json`.
const KIMI = [
  `{"role":"meta","type":"system.version","version":"2.4.0"}`,
  `{"role":"assistant","content":"Let me look."}`,
  `{"role":"assistant","tool_calls":[{"type":"function","id":"call_0","function":{"name":"Glob","arguments":"{\\"pattern\\":\\"*\\"}"}}]}`,
  `{"role":"tool","tool_call_id":"call_0","content":"/repo/docs/room-design.md"}`,
  `{"role":"assistant","content":"1"}`,
  `{"role":"meta","type":"session.resume_hint","session_id":"session_b4e3879f","command":"kimi -r session_b4e3879f","content":"To resume…"}`,
];

describe("KimiMapper (real capture)", () => {
  it("keeps the answer after the last tool call, reports tools and the session id", () => {
    const ev = feed(new KimiMapper(), KIMI);
    expect(ev.filter((e) => e.type === "text")).toEqual([{ type: "text", delta: "1" }]);
    expect(ev).toContainEqual({ type: "tool", name: "Glob" });
    expect(ev.at(-1)).toEqual({ type: "done", sessionId: "session_b4e3879f" });
  });
});

describe("KimiTransport invocation", () => {
  const args = (opts: any) => (new KimiTransport("k", { model: "openrouter/x" }) as any).invocation("hi", opts).args as string[];

  it("binds a read-only agent file with the persona on a fresh session", () => {
    const a = args({ cwd: "/repo", systemPrompt: "You are the Skeptic." });
    expect(a).toEqual(expect.arrayContaining(["-m", "openrouter/x", "--add-dir", "/repo", "--output-format", "stream-json"]));
    const file = readFileSync(a[a.indexOf("--agent-file") + 1], "utf8");
    expect(file).toContain("tools: [Read, Glob, Grep]");
    expect(file).toContain("You are the Skeptic.");
    expect(a.at(-1)).toContain("The project under discussion is at /repo");
  });
  it("gives a call that needs no tools an agent file with none", () => {
    const a = args({ cwd: "/repo", systemPrompt: "You run the floor.", noTools: true });
    expect(readFileSync(a[a.indexOf("--agent-file") + 1], "utf8")).toContain("tools: []");
  });

  it("resumes with -S and no agent file (Kimi refuses both together)", () => {
    const a = args({ cwd: "/repo", systemPrompt: "p", sessionId: "session_1" });
    expect(a).toEqual(expect.arrayContaining(["-S", "session_1"]));
    expect(a).not.toContain("--agent-file");
    expect(a.at(-1)).toBe("hi");
  });

  it("gives every tool when not read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-"));
    expect(readFileSync(agentFile("p", false, dir), "utf8")).not.toContain("tools:");
  });
});

describe("promptArg", () => {
  it("passes short prompts through and spills long ones to a file", () => {
    expect(promptArg("short")).toBe("short");
    const dir = mkdtempSync(join(tmpdir(), "prompt-"));
    const long = "x".repeat(ARG_LIMIT + 1);
    const arg = promptArg(long, dir);
    const file = /in (\S+\.md)\./.exec(arg)![1];
    expect(readFileSync(file, "utf8")).toBe(long);
  });
});

// Captured from zcode 0.16.9 `-p … --json`: warning lines, then one pretty-printed object.
const ZCODE = [
  "AI SDK Warning (anthropic.messages / GLM-5.3): The feature \"cacheControl breakpoint limit\" is not supported.",
  "{",
  `  "sessionId": "sess_09fcadce",`,
  `  "response": "Cannot create file, no tools.",`,
  `  "usage": { "inputTokens": 18954, "outputTokens": 3 }`,
  "}",
];

describe("ZcodeMapper (real capture)", () => {
  it("parses the final object past warning lines", () => {
    expect(feed(new ZcodeMapper(), ZCODE)).toEqual([
      { type: "text", delta: "Cannot create file, no tools." },
      { type: "usage", inputTokens: 18954, outputTokens: 3 },
      { type: "done", sessionId: "sess_09fcadce" },
    ]);
  });

  it("reports output it can't parse as an error", () => {
    expect(feed(new ZcodeMapper(), ["Error: no such model"])[0]).toEqual({ type: "error", message: "Error: no such model" });
  });
});

describe("ZcodeTransport invocation", () => {
  const args = (opts: any) => (new ZcodeTransport("z", { model: "account:zai/GLM-5.3" }) as any).invocation("hi", opts).args as string[];

  it("removes write tools and the subagent tool on every read-only turn, resumed or not", () => {
    for (const a of [args({}), args({ sessionId: "sess_1" })]) {
      const dis = a[a.indexOf("--disallowed-tools") + 1].split(" ");
      expect(dis).toEqual([...ZCODE_WRITE_TOOLS, ...ZCODE_WEB_TOOLS]); // offline unless granted the web
      expect(dis).toContain("Agent");
    }
    expect(args({ readOnly: false })).not.toContain("--disallowed-tools");
    const web = args({ web: true });
    expect(web[web.indexOf("--disallowed-tools") + 1].split(" ")).not.toContain("WebSearch");
    const none = args({ noTools: true });
    expect(none[none.indexOf("--disallowed-tools") + 1].split(" ")).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Agent"]));
  });

  it("leads a fresh prompt with the persona and resumes without it", () => {
    expect(args({ systemPrompt: "You are the Skeptic." }).at(-1)).toContain("<role>\nYou are the Skeptic.\n</role>");
    const r = args({ systemPrompt: "You are the Skeptic.", sessionId: "sess_1" });
    expect(r).toEqual(expect.arrayContaining(["--resume", "sess_1", "--model", "account:zai/GLM-5.3"]));
    expect(r.at(-1)).toBe("hi");
  });
});
