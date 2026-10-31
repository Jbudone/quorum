import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { kimiUsage } from "../src/transports/kimi.js";
import { turnUsage } from "../src/transports/opencode.js";
import { parseOpenUsage } from "../src/usage.js";
import { rig } from "./roomRig.js";

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
});

describe("Quota and balances from OpenUsage", () => {
  it("reads each harness's windows, shortest first, and money left on providers", () => {
    const snap = {
      schema_version: "1",
      snapshots: [
        { provider_id: "claude_code", status: "OK", metrics: { usage_seven_day: { limit: 100, used: 42, unit: "%", window: "7d" }, usage_five_hour: { limit: 100, used: 47, unit: "%", window: "5h" }, today_api_cost: { used: 17, unit: "USD" } }, resets: { usage_five_hour: "2026-10-31T21:00:00Z" } },
        { provider_id: "codex", status: "OK", metrics: { plan_percent_used: { limit: 100, used: 43, unit: "%", window: "5h" }, rate_limit_primary: { limit: 100, used: 43, unit: "%", window: "5h" } } },
        { provider_id: "openrouter", status: "OK", metrics: { credit_balance: { limit: 30, remaining: 14.7, used: 15.3, unit: "USD" }, usage_daily: { used: 1.5, unit: "USD" } } },
        { provider_id: "gemini_cli", status: "AUTH_REQUIRED", metrics: { usage_five_hour: { limit: 100, used: 90, unit: "%", window: "5h" } } },
      ],
    };
    const m = parseOpenUsage(JSON.stringify(snap), "now");
    expect(m.harnesses).toEqual([
      { cli: "claude", windows: [{ label: "5h", used: 0.47, resetsAt: "2026-10-31T21:00:00Z" }, { label: "7d", used: 0.42 }] },
      { cli: "codex", windows: [{ label: "5h", used: 0.43 }] },
    ]);
    expect(m.balances).toEqual([{ provider: "openrouter", name: "OpenRouter", remainingUsd: 14.7, limitUsd: 30 }]);
  });
});

describe("Turn usage the CLIs keep to themselves", () => {
  it("opencode: tokens and cost from its database, this turn only", () => {
    const db = join(mkdtempSync(join(tmpdir(), "oc-")), "opencode.db");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const d = new DatabaseSync(db);
    d.exec("create table session_message (id text, session_id text, type text, seq int, time_created int, time_updated int, data text)");
    const add = (t: number, data: object) => d.prepare("insert into session_message values (?, 's1', 'assistant', 0, ?, ?, ?)").run(String(t), t, t, JSON.stringify(data));
    add(1000, { cost: 9, tokens: { input: 999, output: 999 } }); // an earlier turn
    add(50_000, { cost: 0.002, tokens: { input: 100, output: 5, reasoning: 3, cache: { read: 900, write: 0 } } });
    d.close();
    expect(turnUsage(db, "s1", 50_000)).toEqual({ input: 1000, output: 8, cost: 0.002 });
    expect(turnUsage(db, "nope", 0)).toBeUndefined();
  });

  it("kimi: tokens from the session's wire log", () => {
    const sessions = mkdtempSync(join(tmpdir(), "kimi-"));
    const dir = join(sessions, "wd_x", "session_1", "agents", "main");
    mkdirSync(dir, { recursive: true });
    const rec = (time: number, inputOther: number, output: number) => JSON.stringify({ type: "usage.record", usage: { inputOther, output, inputCacheRead: 10, inputCacheCreation: 0 }, time });
    writeFileSync(join(dir, "wire.jsonl"), [rec(1, 500, 500), '{"type":"turn.ended"}', rec(9000, 200, 20)].join("\n"));
    expect(kimiUsage(sessions, "session_1", 9000)).toEqual({ input: 210, output: 20 });
  });
});

describe("What members spend in a channel", () => {
  it("adds up each member's tokens, priced when its model is paid per token", async () => {
    const r = rig({ member: () => "a reply", extra: () => [{ type: "usage", inputTokens: 1000, outputTokens: 100 }] });
    cleanup.push(r.closeAll);
    const room = r.create({ price: (cli) => (cli === "mock" ? { input: 1, output: 2 } : undefined) });
    room.post("go");
    room.resume();
    await room.settled();
    const spoke = r.memberCalls()[0].agent;
    const s = room.store.spend()[spoke];
    expect(s.input % 1000).toBe(0);
    expect(s.usd).toBeCloseTo((s.input * 1 + s.output * 2) / 1e6, 10);
  });
});
