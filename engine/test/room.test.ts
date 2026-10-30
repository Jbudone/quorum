import { afterEach, describe, expect, it } from "vitest";
import type { RoomEmit } from "../src/room/room.js";
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

describe("Room floor", () => {
  it("opens with the topic in focus; the floor picks who speaks until the turn cap pauses it", async () => {
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
    expect(r.memberCalls()[0].prompt).toContain("You have the floor to answer #3: has a view.");
    // Replies thread to the message the floor gave them.
    expect(messages(room)[1]).toMatchObject({ from: "arch", replyTo: 3 });
    expect(room.store.events().find((e) => e.type === "floor")).toMatchObject({ picks: [{ agent: "arch" }, { agent: "skeptic" }] });
  });

  it("stays quiet when the floor picks nobody; an @mention still gets an answer", async () => {
    const r = setup({ floor: () => [] });
    const room = r.create();
    room.resume();
    await room.settled();
    expect(room.state).toBe("idle");
    expect(r.memberCalls()).toHaveLength(0);
    expect(r.decisions).toHaveLength(1);

    room.post("@skeptic what would break?");
    await room.settled();
    expect(r.memberCalls().map((c) => c.agent)).toEqual(["skeptic"]);
    expect(r.memberCalls()[0].prompt).toContain("You have the floor to answer #5: human asked you directly.");
  });

  it("lets only the human and the Chair summon a member with @; between members it's a hint", async () => {
    const r = setup({ floor: () => [], member: (a, n) => (a === "skeptic" && n === 1 ? "@arch you're wrong" : "PASS") });
    const room = r.create();
    room.resume();
    room.post("@skeptic thoughts?");
    await room.settled();
    // skeptic was summoned by the human; its @arch went to the floor, which picked nobody.
    expect(r.memberCalls().map((c) => c.agent)).toEqual(["skeptic"]);
    expect(r.decisions.at(-1)!.fresh.at(-1)).toMatchObject({ from: "skeptic", text: "@arch you're wrong" });
  });

  it("never hands a member its own message, and PASS says nothing", async () => {
    const r = setup({ floor: (c) => c.members.map((m) => ({ agent: m.id, why: "" })), member: (a) => (a === "arch" ? "LRU." : "PASS") });
    const room = r.create();
    room.resume();
    await room.settled();
    // After arch's "LRU." the floor named arch again; only skeptic got a turn.
    expect(r.memberCalls().map((c) => c.agent)).toEqual(["arch", "skeptic", "skeptic"]);
    expect(messages(room).map((e) => e.type === "message" && e.from)).toEqual(["human", "arch"]);
    expect(types(room)).not.toContain("pass");
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
    expect(room.state).toBe("idle");
  });

  it("resumes after a restart with saved vendor sessions, sending only what's new", async () => {
    const first = setup();
    const room = first.create({ turnCap: 2 });
    room.resume();
    await room.settled();
    await room.close();

    const second = setup();
    const again = second.open(room.id, { repo: first.repo });
    expect(again.configure({ turnCap: 3, parallel: undefined })).toMatchObject({ parallel: 2, turnCap: 3 });
    expect(() => again.configure({ parallel: 0 })).toThrow(/at least 1/);
    expect(RoomStore.list(first.repo).map((x) => x.id)).toEqual([room.id]);
    again.post("carry on");
    again.resume();
    await again.settled();

    const c = second.memberCalls()[0];
    expect(c.opts?.sessionId).toBe(`${c.agent}-session`);
    expect(c.prompt).toMatch(/^New in the room since you last spoke/);
    expect(c.prompt).toContain("carry on");
    expect(c.prompt).not.toContain("room resumed");
  });

  it("aborts turns on pause and gives the floor back on resume, even after a restart", async () => {
    const r = setup({ member: () => "a long considered reply", delayMs: 20 });
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    room.resume();
    await new Promise((res) => setTimeout(res, 5));
    room.pause();
    await room.settled();
    expect(room.store.agentState("arch").lastRead).toBe(0);
    await room.close();

    const again = r.open(room.id);
    again.resume();
    await again.settled();
    expect(r.memberCalls()).toHaveLength(2);
    expect(messages(again).at(-1)).toMatchObject({ from: "arch", text: "a long considered reply" });
  });

  it("delivers a DM only to its recipient, without asking the floor", async () => {
    const r = setup({ floor: () => [] });
    const room = r.create();
    room.resume();
    await room.settled();
    room.post("just between us", "skeptic");
    await room.settled();
    expect(r.memberCalls().map((c) => c.agent)).toEqual(["skeptic"]);
    expect(r.memberCalls()[0].prompt).toContain("human → skeptic (private)");
    expect(r.memberCalls()[0].prompt).toContain("Your reply goes privately to human");
    // The answer goes back privately, so the floor isn't asked about it either.
    expect(messages(room).at(-1)).toMatchObject({ from: "skeptic", to: "human", replyTo: 5 });
    expect(r.decisions).toHaveLength(1);
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
    expect(room.store.agentState("arch")).toMatchObject({ turns: 1 });
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

describe("Empty rooms", () => {
  it("starts with just the human; the first message sets the topic and the assistant proposes members", async () => {
    const r = setup({
      assistant: ["For this I'd bring in two people.\n>> add: architect mock | designs it\n>> add: skeptic mock | attacks it"],
      member: (a) => `${a} here`,
    });
    const room = r.create({ topic: undefined, agents: [] });
    expect(room.store.events()).toEqual([]);
    room.resume();
    room.post("How should we cache product reads?");
    await room.settled();
    expect(room.store.config().topic).toBe("How should we cache product reads?");
    expect(room.focus()).toBe("how-should-we-cache-product");
    expect(r.calls.find((c) => c.agent === "assistant")!.prompt).toContain("The room has no members yet");
    expect(room.pending().map((p) => p.args)).toEqual([
      ["architect", "mock"],
      ["skeptic", "mock"],
    ]);

    // Approving a member brings it in, and it speaks to the question right away.
    await room.resolve(room.pending()[0].id, true);
    await room.settled();
    expect(r.memberCalls()[0]).toMatchObject({ agent: "architect" });
    expect(r.memberCalls()[0].prompt).toContain("you just joined");
    expect(messages(room).at(-1)).toMatchObject({ from: "architect", text: "architect here" });
  });
});

describe("Room budgets", () => {
  it("warns, then pauses, on reported quota; a CLI that reports quota isn't turn-capped", async () => {
    const q = [0.5, 0.8, 0.8, 0.95];
    const r = setup({ extra: (_a, n) => [{ type: "usage", quotaUtilization: q[Math.min(n - 1, 3)] }] });
    const room = r.create({ agents: AGENTS.slice(0, 1), turnCap: 1 });
    // A lone member only answers others, so keep giving it something to answer.
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
