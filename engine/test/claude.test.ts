import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeTransport, mapClaudeLine } from "../src/transports/claude.js";

const fixture = readFileSync(new URL("./fixtures/claude-simple.ndjson", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean);

describe("mapClaudeLine", () => {
  it("normalizes a real stream into text, quota usage, and done", () => {
    const events = fixture.flatMap(mapClaudeLine);
    const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
    expect(text.length).toBeGreaterThan(5);
    expect(events.some((e) => e.type === "usage" && e.quotaUtilization !== undefined)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", sessionId: "SESSION" });
  });

  it("ignores malformed and unknown lines", () => {
    expect(mapClaudeLine("not json")).toEqual([]);
    expect(mapClaudeLine('{"type":"system","subtype":"init"}')).toEqual([]);
  });

  it("maps error results", () => {
    expect(mapClaudeLine('{"type":"result","is_error":true,"result":"boom"}')).toEqual([
      { type: "error", message: "boom" },
    ]);
  });
});

describe("ClaudeTransport.buildArgs", () => {
  const t = new ClaudeTransport();
  it("is read-only and isolated by default", () => {
    const a = t.buildArgs();
    expect(a).toContain("--strict-mcp-config");
    expect(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Grep,Glob"]);
  });
  it("turns every tool off for calls that need none", () => {
    const a = t.buildArgs({ noTools: true });
    expect(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  });
  it("reaches the repo via --add-dir and names it in the system prompt", () => {
    const a = t.buildArgs({ cwd: "/repo", systemPrompt: "skeptic" });
    expect(a.slice(a.indexOf("--add-dir"), a.indexOf("--add-dir") + 2)).toEqual(["--add-dir", "/repo"]);
    expect(a[a.indexOf("--append-system-prompt") + 1]).toContain("/repo");
  });
  it("passes persona and resume", () => {
    const a = t.buildArgs({ systemPrompt: "be a skeptic", sessionId: "abc" });
    expect(a).toContain("--append-system-prompt");
    expect(a.slice(a.indexOf("--resume"))).toEqual(["--resume", "abc"]);
  });
});
