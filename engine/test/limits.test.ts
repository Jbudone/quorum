import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentTransport } from "../src/transports/index.js";
import { claudeLimit } from "../src/transports/claude.js";
import { markCredits } from "../src/catalog.js";
import { readCreditRoutes } from "../src/providers.js";
import { AGENTS, rig } from "./roomRig.js";

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
});
const setup = (o: Parameters<typeof rig>[0] = {}) => {
  const r = rig(o);
  cleanup.push(r.closeAll);
  return r;
};

describe("reading Claude's limits", () => {
  it("reads both windows from an allowed event, and no limit", () => {
    const e = claudeLimit({
      status: "allowed",
      resetsAt: 1793656800,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
      unifiedWindows: { five_hour: { utilization: 0.23, resetsAt: 1793656800, status: "allowed" }, seven_day: { utilization: 0.1, resetsAt: 1794150000, status: "allowed" } },
    });
    expect(e).toEqual({
      type: "usage",
      quotaUtilization: 0.23,
      windows: [
        { label: "5h", used: 0.23, resetsAt: new Date(1793656800 * 1000).toISOString() },
        { label: "7d", used: 0.1, resetsAt: new Date(1794150000 * 1000).toISOString() },
      ],
    });
  });

  it("tells a model out of usage credits from a used-up window, and a warning from either", () => {
    // What Claude Code sent for Fable on a subscription whose usage credits ran out.
    expect(claudeLimit({ status: "rejected", resetsAt: 1796083200, overageDisabledReason: "out_of_credits", errorCode: "credits_required" })).toMatchObject({
      rateLimited: true,
      limit: { kind: "credits" },
    });
    expect(claudeLimit({ status: "rejected", resetsAt: 1793656800, rateLimitType: "five_hour" })).toMatchObject({
      rateLimited: true,
      limit: { kind: "window", window: "five_hour", resetsAt: new Date(1793656800 * 1000).toISOString() },
    });
    const warn = claudeLimit({ status: "allowed_warning", rateLimitType: "seven_day" });
    expect(warn).toMatchObject({ limit: { kind: "warning", window: "seven_day" } });
    expect(warn).not.toHaveProperty("rateLimited");
  });
});

/** Members on a model whose credits ran out; everyone else answers normally. */
function creditsTransports(out: string[]) {
  return (spec: { id: string }): AgentTransport => ({
    id: spec.id,
    async *send(): AsyncIterable<AgentEvent> {
      if (spec.id === "arch" && out.includes("arch")) {
        yield { type: "usage", rateLimited: true, limit: { kind: "credits" } };
        yield { type: "error", message: "You're out of usage credits." };
        return;
      }
      if (["chair", "scribe", "assistant"].includes(spec.id)) {
        yield { type: "text", delta: spec.id === "chair" ? "PASS" : "NOTHING" };
        return;
      }
      yield { type: "text", delta: `${spec.id} has a thought` };
      yield { type: "done", sessionId: `${spec.id}-s` };
    },
  });
}

describe("respecting limits", () => {
  it("sits out only the member whose model is out of credits; the others carry on, and resuming retries it", async () => {
    const r = setup();
    const out = ["arch"];
    const room = r.create({ transports: creditsTransports(out), agents: [{ ...AGENTS[0], model: "fable" }, AGENTS[1]] });
    room.post("What do you both think?");
    room.resume();
    await room.settled();
    const ev = room.store.events();
    const hold = ev.find((e) => e.type === "budget" && e.level === "hold");
    expect(hold).toMatchObject({ cli: "mock", members: ["arch"] });
    expect(hold?.type === "budget" && hold.detail).toMatch(/fable is out of usage credits; arch sits out\. Move it to another model \(\/swap arch, or pick a model in alt\+o and press enter\)/);
    expect(ev.some((e) => e.type === "turn.failed")).toBe(false);
    expect(ev.some((e) => e.type === "paused" && /rate limited/.test(e.reason))).toBe(false);
    expect(ev.some((e) => e.type === "message" && e.from === "skeptic")).toBe(true);
    expect(room.status().detail).toMatch(/Sitting out a usage limit: arch \(fable is out of usage credits/);
    // Remembered for the model catalog: on this harness, fable costs credits, not quota.
    expect(readCreditRoutes().has("mock fable")).toBe(true);
    const models = [{ routes: [{ harness: "mock", id: "fable", ready: true }, { harness: "opencode", id: "x/fable", ready: true }] }] as never;
    markCredits(models);
    expect((models as { routes: { billing?: string }[] }[])[0].routes.map((r) => r.billing)).toEqual(["credits", undefined]);

    // The human adds credits and resumes: arch keeps its place and speaks.
    out.length = 0;
    room.pause();
    room.resume();
    await room.settled();
    expect(room.store.events().some((e) => e.type === "message" && e.from === "arch")).toBe(true);
  });

  it("brings a held member back as soon as its model is switched", async () => {
    const r = setup();
    const out = ["arch"];
    const room = r.create({ transports: creditsTransports(out), agents: [{ ...AGENTS[0], model: "fable" }, AGENTS[1]] });
    room.post("Thoughts?");
    room.resume();
    await room.settled();
    out.length = 0; // the new model has credits
    room.swapModel("arch", "mock", "sonnet");
    await room.settled();
    expect(room.store.events().find((e) => e.type === "budget" && e.level === "release")).toMatchObject({ members: ["arch"], detail: "arch is back on mock sonnet" });
    expect(room.status().detail).not.toMatch(/Sitting out/);
    expect(room.store.events().some((e) => e.type === "message" && e.from === "arch")).toBe(true);
  });

  it("holds a CLI whose window is used up until it resets, then brings its members back", async () => {
    const r = setup();
    let limited = true;
    const transports = (spec: { id: string }): AgentTransport => ({
      id: spec.id,
      async *send(): AsyncIterable<AgentEvent> {
        if (spec.id === "arch" && limited) {
          limited = false;
          yield { type: "usage", rateLimited: true, limit: { kind: "window", window: "five_hour", resetsAt: new Date(Date.now() + 80).toISOString() } };
          yield { type: "error", message: "limit reached" };
          return;
        }
        if (["chair", "scribe", "assistant"].includes(spec.id)) {
          yield { type: "text", delta: spec.id === "chair" ? "PASS" : "NOTHING" };
          return;
        }
        yield { type: "text", delta: `${spec.id} has a thought` };
        yield { type: "done" };
      },
    });
    const room = r.create({ transports, agents: AGENTS.slice(0, 1) });
    room.post("Go.");
    room.resume();
    await new Promise((res) => setTimeout(res, 400));
    await room.settled();
    const budget = room.store.events().flatMap((e) => (e.type === "budget" ? [e.level] : []));
    expect(budget).toEqual(["hold", "release"]);
    expect(room.store.events().find((e) => e.type === "budget")).toMatchObject({ detail: expect.stringMatching(/mock reached its 5-hour limit; arch sits out until/) });
    expect(room.store.events().some((e) => e.type === "message" && e.from === "arch")).toBe(true);
    expect(room.store.events().some((e) => e.type === "turn.failed")).toBe(false);
  });

  it("backs off a CLI that only says it's throttling in its error", async () => {
    const r = setup();
    let fails = 1;
    const transports = (spec: { id: string }): AgentTransport => ({
      id: spec.id,
      async *send(): AsyncIterable<AgentEvent> {
        if (spec.id === "arch" && fails-- > 0) {
          yield { type: "error", message: "429 Too Many Requests" };
          return;
        }
        if (["chair", "scribe", "assistant"].includes(spec.id)) {
          yield { type: "text", delta: spec.id === "chair" ? "PASS" : "NOTHING" };
          return;
        }
        yield { type: "text", delta: `${spec.id} has a thought` };
        yield { type: "done" };
      },
    });
    const room = r.create({ transports, agents: AGENTS.slice(0, 1) });
    room.post("Go.");
    room.resume();
    await new Promise((res) => setTimeout(res, 300));
    await room.settled();
    expect(room.store.events().find((e) => e.type === "budget")).toMatchObject({ level: "hold", detail: expect.stringMatching(/mock is throttling requests/) });
    expect(room.store.events().some((e) => e.type === "message" && e.from === "arch")).toBe(true);
  });
});
