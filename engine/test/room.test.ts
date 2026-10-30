import { afterEach, describe, expect, it } from "vitest";
import { Room, type RoomEmit } from "../src/room/room.js";
import { RoomStore } from "../src/room/store.js";
import type { AgentEvent, AgentTransport } from "../src/transports/index.js";
import { AGENTS, messages, rig, types } from "./roomRig.js";

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

describe("Room scheduling", () => {
  it("opens with the topic in focus and wakes members until the turn cap pauses it", async () => {
    const r = setup();
    const room = r.create({ turnCap: 5 });
    const states: RoomEmit[] = [];
    room.on((e) => e.event === "room.state" && states.push(e));
    expect(types(room)).toEqual(["topic.raised", "topic.focus", "message"]);
    expect(room.focus()).toBe("pick-a-cache");
    room.resume();
    await room.settled();

    expect(r.memberCalls()).toHaveLength(5);
    expect(room.state).toBe("paused");
    expect(states.at(-1)).toMatchObject({ data: { state: "paused", reason: "turn cap reached (5 turns each for mock)" } });
    expect(messages(room)).toHaveLength(6);
    expect(r.memberCalls()[0].prompt).toContain("Room question: pick a cache");
    expect(r.memberCalls()[0].prompt).toContain("Other members: skeptic");
  });

  it("goes idle when everyone passes, and a human post wakes them again", async () => {
    const r = setup({ member: () => "PASS" });
    const room = r.create();
    room.resume();
    await room.settled();
    expect(room.state).toBe("idle");
    expect(types(room).filter((t) => t === "pass")).toHaveLength(2);

    room.post("what about caching?");
    await room.settled();
    expect(r.memberCalls()).toHaveLength(4);
    expect(r.memberCalls()[2].prompt).toContain("what about caching?");
  });

  it("never runs more members at once than the parallel cap", async () => {
    let now = 0;
    let peak = 0;
    const r = setup();
    const transports = (spec: { id: string }): AgentTransport => ({
      id: spec.id,
      async *send(): AsyncIterable<AgentEvent> {
        peak = Math.max(peak, ++now);
        await new Promise((res) => setTimeout(res, 5));
        now--;
        yield { type: "text", delta: "PASS" };
        yield { type: "done" };
      },
    });
    const room = r.create({ transports, agents: AGENTS, parallel: 2 });
    room.resume();
    await room.settled();
    expect(peak).toBe(2);
    expect(types(room).filter((t) => t === "pass")).toHaveLength(3);
  });

  it("resumes after a restart with saved vendor sessions, sending only what's new", async () => {
    const first = setup();
    const room = first.create({ turnCap: 2 });
    room.resume();
    await room.settled();
    await room.close();

    const second = setup();
    const again = Room.open(room.id, { repo: first.repo, transports: second.transports, head: () => "abc123" });
    cleanup.push(() => again.close());
    expect(again.configure({ turnCap: 3, parallel: undefined })).toMatchObject({ parallel: 2, turnCap: 3 });
    expect(() => again.configure({ parallel: 0 })).toThrow(/at least 1/);
    expect(RoomStore.list(first.repo).map((x) => x.id)).toEqual([room.id]);
    again.resume();
    await again.settled();

    const c = second.memberCalls()[0];
    expect(c.opts?.sessionId).toBe(`${c.agent}-session`);
    expect(c.prompt).toMatch(/^New in the room since your last turn/);
    expect(c.prompt).not.toContain("room resumed");
    expect(second.memberCalls()).toHaveLength(3);
  });

  it("aborts turns on pause and redoes them on resume", async () => {
    const r = setup({ member: () => "a long considered reply", delayMs: 20 });
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    room.resume();
    await new Promise((res) => setTimeout(res, 5));
    room.pause();
    await room.settled();
    expect(types(room).slice(3)).toEqual(["resumed", "paused"]);
    expect(room.store.agentState("arch").lastRead).toBe(0);

    room.resume();
    await room.settled();
    expect(r.memberCalls()).toHaveLength(2);
    expect(messages(room).at(-1)).toMatchObject({ from: "arch", text: "a long considered reply" });
  });

  it("delivers a DM only to its recipient", async () => {
    const r = setup({ member: () => "PASS" });
    const room = r.create();
    room.resume();
    await room.settled();
    room.post("just between us", "skeptic");
    await room.settled();
    expect(r.memberCalls().slice(2).map((c) => c.agent)).toEqual(["skeptic"]);
    expect(r.memberCalls()[2].prompt).toContain("human → skeptic (private)");
    expect(() => room.post("hi", "nobody")).toThrow(/unknown member/);
  });

  it("records a failed turn, drops the vendor session, and doesn't retry in a loop", async () => {
    const r = setup();
    const transports = (spec: { id: string }): AgentTransport => ({
      id: spec.id,
      async *send(): AsyncIterable<AgentEvent> {
        yield { type: "error", message: "rate limited" };
      },
    });
    const room = r.create({ transports, agents: AGENTS.slice(0, 1) });
    room.store.saveAgentState("arch", { sessionId: "stale", lastRead: 0, turns: 0 });
    room.resume();
    await room.settled();
    expect(room.state).toBe("idle");
    expect(room.store.events().find((e) => e.type === "turn.failed")).toMatchObject({ agent: "arch", message: "rate limited" });
    expect(room.store.agentState("arch")).toMatchObject({ lastRead: 4, turns: 1 });
    expect(room.store.agentState("arch").sessionId).toBeUndefined();
  });

  it("rebuilds a member's context from files once its vendor session is long", async () => {
    const r = setup({ member: () => "PASS" });
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    room.store.saveAgentState("arch", { sessionId: "old", sessionTurns: 12, lastRead: 0, turns: 12 });
    room.resume();
    await room.settled();
    expect(r.memberCalls()[0].opts?.sessionId).toBeUndefined();
    expect(r.memberCalls()[0].prompt).toContain("You are arch, a member of a Quorum room");
    expect(room.store.agentState("arch")).toMatchObject({ sessionId: "arch-session", sessionTurns: 1 });
  });
});

describe("Room budgets", () => {
  it("warns, then pauses, on reported quota; a CLI that reports quota isn't turn-capped", async () => {
    const q = [0.5, 0.8, 0.8, 0.95];
    const r = setup({ extra: (_a, n) => [{ type: "usage", quotaUtilization: q[Math.min(n - 1, 3)] }] });
    const room = r.create({ agents: AGENTS.slice(0, 1), turnCap: 1 });
    // A lone member wakes only for others' messages, so keep giving it something to answer.
    room.on((e) => {
      if (e.event === "room.event" && e.data.type === "message" && e.data.from === "arch") room.post("go on");
    });
    room.resume();
    await room.settled();
    const budget = room.store.events().filter((e) => e.type === "budget");
    expect(budget.map((e) => e.type === "budget" && e.level)).toEqual(["warn", "stop"]);
    expect(room.state).toBe("paused");
    expect(room.store.events().find((e) => e.type === "paused")).toMatchObject({ reason: "budget: mock at 95% of its quota window" });
    expect(r.memberCalls().length).toBe(4);
  });
});
