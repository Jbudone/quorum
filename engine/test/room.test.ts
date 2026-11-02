import { afterEach, describe, expect, it } from "vitest";
import type { RoomEmit } from "../src/room/room.js";
import { RoomStore, type RoomEvent } from "../src/room/store.js";
import type { AgentEvent, AgentTransport } from "../src/transports/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOCK_SUPPORT } from "../src/room/setup.js";
import { SetupChat } from "../src/room/setupchat.js";
import { parseSetup } from "../src/room/prompts.js";
import { personaFor, Workspace } from "../src/room/workspace.js";
import { AGENTS, messages, rig, types } from "./roomRig.js";

/** Who wrote the newest message the floor is deciding on. */
const lastFrom = (c: { fresh: readonly RoomEvent[] }) => {
  const e = c.fresh.at(-1);
  return e?.type === "message" ? e.from : undefined;
};

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

  it("stays quiet when the floor picks nobody after members talk; an @mention still gets an answer", async () => {
    const r = setup({ floor: () => [], member: () => "PASS" });
    const room = r.create();
    room.resume();
    await room.settled();
    // The human's opening never goes unanswered: with no pick, the least recent speaker takes it.
    expect(r.memberCalls().map((c) => c.agent)).toEqual(["arch"]);
    expect(r.memberCalls()[0].prompt).toContain("the human asked and nobody else picked it up");
    expect(room.state).toBe("idle");
    expect(r.decisions).toHaveLength(1);
    r.calls.length = 0;

    room.post("@skeptic what would break?");
    await room.settled();
    expect(r.memberCalls().map((c) => c.agent)).toEqual(["skeptic"]);
    expect(r.memberCalls()[0].prompt).toMatch(/You have the floor to answer #\d+: human asked you directly\./);
  });

  it("lets only the human and the Chair summon a member with @; between members it's a hint", async () => {
    const r = setup({ floor: () => [], member: (a, n) => (a === "skeptic" && n === 1 ? "@arch you're wrong" : "PASS") });
    const room = r.create({ topic: undefined });
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
    const r = setup({ floor: () => [], member: (_a, _n, prompt) => (/wrote to you privately/.test(prompt) ? "noted" : "PASS") });
    const room = r.create();
    room.resume();
    await room.settled();
    r.calls.length = 0;
    room.post("just between us", "skeptic");
    await room.settled();
    expect(r.memberCalls().map((c) => c.agent)).toEqual(["skeptic"]);
    expect(r.memberCalls()[0].prompt).toContain("human → skeptic (private)");
    expect(r.memberCalls()[0].prompt).toContain("Your reply goes privately to human");
    // The answer goes back privately, so the floor isn't asked about it either.
    expect(messages(room).at(-1)).toMatchObject({ from: "skeptic", to: "human", replyTo: messages(room).at(-2)!.seq });
    expect(r.decisions).toHaveLength(1);
    expect(() => room.post("hi", "nobody")).toThrow(/unknown member/);
  });

  it("records a failed turn, drops the vendor session, and doesn't retry in a loop", async () => {
    const r = setup();
    const transports = (spec: { id: string }): AgentTransport => ({
      id: spec.id,
      async *send(): AsyncIterable<AgentEvent> {
        yield { type: "error", message: "connection reset" };
      },
    });
    const room = r.create({ transports, agents: AGENTS.slice(0, 1) });
    room.store.saveAgentState("arch", { sessionId: "stale", lastRead: 0, turns: 0 });
    room.resume();
    await room.settled();
    expect(room.state).toBe("idle");
    expect(room.store.events().find((e) => e.type === "turn.failed")).toMatchObject({ agent: "arch", message: "connection reset" });
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

describe("Threads", () => {
  it("keeps a side question out of the channel, answers it in the thread, and posts the outcome back", async () => {
    const r = setup({
      floor: (c) => (c.thread ? (lastFrom(c) === "human" ? [{ agent: "skeptic", why: "knows" }] : []) : []),
      member: (a, _n, prompt) => (/side thread/.test(prompt) ? "Thirty seconds." : /the human asked/.test(prompt) ? "PASS" : `${a} on the main topic`),
      scribe: ["They settled on a 30 s TTL."],
    });
    const room = r.create();
    room.resume();
    await room.settled();
    r.calls.length = 0;
    const q = room.post("How long can a price be stale?", "room", "new");
    expect(q).toMatchObject({ thread: q.seq });
    await room.settled();

    expect(r.memberCalls().map((c) => c.agent)).toEqual(["skeptic"]);
    const prompt = r.memberCalls()[0].prompt;
    expect(prompt).toContain("You're in a side thread");
    expect(prompt).toContain("How long can a price be stale?");
    expect(room.thread(q.seq).messages).toMatchObject([{ from: "skeptic", text: "Thirty seconds.", thread: q.seq }]);
    expect(room.store.events().find((e) => e.type === "thread.summary")).toMatchObject({ thread: q.seq, text: "They settled on a 30 s TTL." });

    // Back in the channel, members see the thread's outcome but not the thread itself.
    room.post("@arch anything else?");
    await room.settled();
    const main = r.memberCalls().at(-1)!.prompt;
    expect(main).toContain(`side thread #${q.seq} settled: They settled on a 30 s TTL.`);
    expect(main).not.toContain("Thirty seconds.");
    // Each thread keeps its own vendor session.
    expect(room.store.agentState(`skeptic@t${q.seq}`)).toMatchObject({ sessionId: "skeptic-session" });
    expect(() => room.post("x", "room", 2)).toThrow(/no message #2/);
  });
});

describe("Floor tags", () => {
  it("logs what each message did, for the stats panel, without showing it to members", async () => {
    const r = setup({ member: (a) => (a === "arch" ? "Use an LRU." : "PASS") });
    const floor = {
      decide: async (c: any) => ({
        picks: c.fresh.at(-1).from === "human" ? [{ agent: "arch", why: "" }] : [],
        tags: c.fresh.map((e: any) => ({ seq: e.seq, from: e.from, kind: e.from === "arch" ? "idea" : "question", headline: "x" })),
      }),
    };
    const room = r.create({ floor });
    room.resume();
    await room.settled();
    const tags = room.store.events().flatMap((e) => (e.type === "tags" ? e.items : []));
    expect(tags.map((t) => [t.from, t.kind])).toEqual([
      ["human", "question"],
      ["arch", "idea"],
    ]);
    expect(r.memberCalls().every((c) => !c.prompt.includes('"tags"'))).toBe(true);
  });
});

describe("Reading list", () => {
  it("has members read it first, then only what changed", async () => {
    const r = setup({ floor: (c) => (lastFrom(c) === "human" ? [{ agent: "arch", why: "" }] : []), member: () => "PASS" });
    mkdirSync(join(r.repo, "docs"));
    writeFileSync(join(r.repo, "docs", "past.md"), "# earlier");
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    expect(room.setReading(["docs"])).toEqual(["docs"]);
    expect(() => room.setReading(["../etc"])).toThrow(/outside the project/);
    room.resume();
    await room.settled();
    expect(r.memberCalls()[0].prompt).toContain("This channel's reading list: docs. You haven't read it yet");

    await new Promise((res) => setTimeout(res, 20));
    writeFileSync(join(r.repo, "docs", "new.md"), "# later");
    room.post("next");
    await room.settled();
    expect(r.memberCalls()[1].prompt).toContain("Changed in the reading list since you last read it: docs/new.md.");
  });
});

describe("Independent takes", () => {
  it("lets members draft without seeing each other, then revise once they have", async () => {
    const r = setup({ member: (a, n, prompt) => (/While you were thinking/.test(prompt) ? `${a} revised` : `${a} draft ${n}`), delayMs: 5 });
    const floor = { decide: async (c: any) => ({ picks: c.fresh.at(-1).from === "human" ? [{ agent: "arch", why: "" }, { agent: "skeptic", why: "" }] : [], tags: [] }) };
    const room = r.create({ floor, independent: true, parallel: 1 });
    room.resume();
    await room.settled();
    // skeptic ran second: it drafted from the snapshot without arch's answer, then revised after reading it.
    const sk = r.memberCalls().filter((c) => c.agent === "skeptic");
    expect(sk[0].prompt).not.toContain("arch draft");
    expect(sk[1].prompt).toContain("While you were thinking");
    expect(messages(room).map((e) => e.type === "message" && e.text)).toEqual(["pick a cache", "arch draft 1", "skeptic revised"]);
  });
});

describe("Workspace members", () => {
  it("hires an invented member into the workspace; members carry their notebook and see their other channels", async () => {
    const r = setup({ assistant: ["Nobody covers tenants.\n>> hire: tenant-expert | mock | multi-tenancy researcher | Studies isolation between tenants. | nobody covers tenants", "DIGEST:\nLRU agreed."], member: () => "PASS" });
    const first = r.create({ name: "cache" });
    await first.ask("who's missing?");
    expect(first.pending()).toMatchObject([{ action: "hire", args: ["tenant-expert", "mock", "", "multi-tenancy researcher", "Studies isolation between tenants."] }]);
    await first.resolve(first.pending()[0].id, true);
    expect(new Workspace(r.repo).members().map((m) => m.id)).toContain("tenant-expert");
    expect(personaFor(r.repo, "tenant-expert").role).toBe("multi-tenancy researcher");
    await first.watch("check-in");
    first.store.writeNotebook("tenant-expert", "remember: keys need tenant ids");

    // In another channel the same member brings its notebook and sees where the first channel stands.
    const second = r.create({ name: "imports", topic: "bulk imports", agents: [{ id: "tenant-expert", cli: "mock", persona: "tenant-expert" }] });
    second.resume();
    await second.settled();
    const prompt = r.memberCalls().filter((c) => c.agent === "tenant-expert").at(-1)!.prompt;
    expect(prompt).toContain("remember: keys need tenant ids");
    expect(prompt).toContain("You're also in #cache, where things stand like this:\nLRU agreed.");
  });
});

describe("Joining", () => {
  it("onboards a new member with a brief, its own reading, and the human's first question", async () => {
    const r = setup({
      floor: () => [],
      member: () => "PASS",
      scribe: ["The room picked an LRU (#3). Open: tenant keys."],
      assistant: ["ID: tenancy-auditor\nROLE: multi-tenancy auditor\nPERSONA: Audits caches for leaks between tenants."],
    });
    mkdirSync(join(r.repo, "notes"));
    writeFileSync(join(r.repo, "notes", "keys.md"), "x");
    const room = r.create({ reading: [] });
    room.resume();
    await room.settled();
    r.calls.length = 0;

    expect(await room.draftPersona("someone who checks tenant isolation")).toEqual({ id: "tenancy-auditor", role: "multi-tenancy auditor", persona: "Audits caches for leaks between tenants." });
    const id = await room.join({ id: "tenancy-auditor", cli: "mock", role: "multi-tenancy auditor", persona: "Audits caches for leaks between tenants.", brief: true, reading: ["notes"], question: "Are cache keys tenant-scoped?" });
    expect(id).toBe("tenancy-auditor");
    await room.settled();
    const prompt = r.memberCalls().find((c) => c.agent === "tenancy-auditor")!.prompt;
    expect(prompt).toContain("A catch-up brief written for you:\nThe room picked an LRU (#3). Open: tenant keys.");
    expect(prompt).toContain("This channel's reading list: notes.");
    expect(prompt).toContain("the human asks you to start with: Are cache keys tenant-scoped?");
    expect(r.calls.find((c) => c.agent === "scribe")!.prompt).toContain("tenancy-auditor is joining as: multi-tenancy auditor");
    // Onboarding is for the first turn only.
    expect(room.store.agentState("tenancy-auditor").onboarding).toBeUndefined();
    expect(new Workspace(r.repo).members().map((m) => m.id)).toContain("tenancy-auditor");
    await expect(room.join({ id: "tenancy-auditor", cli: "mock" })).rejects.toThrow(/already in this channel/);
    await expect(room.join({ id: "nobody", cli: "mock" })).rejects.toThrow(/needs a persona/);

    // A channel only runs members on its own CLIs.
    const mockOnly = r.create({ clis: ["mock"] });
    await expect(mockOnly.join({ id: "x", cli: "claude", persona: "p" })).rejects.toThrow(/claude isn't available here; use mock/);
  });

  it("approves the assistant's suggestion it was opened from", async () => {
    const r = setup({ member: () => "PASS", assistant: ["x\n>> hire: qa | mock | QA lead | Breaks things. | nobody tests"] });
    const room = r.create();
    await room.ask("who's missing?");
    const sug = room.pending()[0];
    await room.join({ id: "qa", cli: "mock", role: "QA lead", persona: "Breaks things, on purpose.", suggestion: sug.id });
    expect(room.pending()).toEqual([]);
    expect(personaFor(r.repo, "qa").body).toBe("Breaks things, on purpose.");
  });
});

describe("Planning", () => {
  it("reads choice-card questions and a full plan", () => {
    const q = parseSetup("Two questions.\n>> question: Goal | What matters most? | multi\n>> option: Speed (recommended) | ship soon\n>> option: Rigor | get it right\n>> question: Lonely | no options here");
    expect(q).toEqual({ prose: "Two questions.", questions: [{ header: "Goal", text: "What matters most?", multi: true, options: [{ label: "Speed (recommended)", description: "ship soon" }, { label: "Rigor", description: "get it right" }] }] });
    const p = parseSetup(
      "Plan.\n>> vision: Levels made by AI\n>> vision: that designers trust.\n>> consider: playability\n>> member: pcg | claude opus | PCG researcher | Knows PCG.\n>> topic: Edge cases | a ranked list | pcg, @ux\n>> steer: Start with the vision.",
    ).proposal!;
    expect(p).toMatchObject({ vision: "Levels made by AI that designers trust.", considerations: ["playability"], topics: [{ title: "Edge cases", done: "a ranked list", members: ["pcg", "ux"] }], steer: "Start with the vision." });
  });

  it("a note between members in a thread is posted in the thread, not privately", async () => {
    const r = setup({
      floor: (c) => (c.thread && lastFrom(c) === "human" ? [{ agent: "skeptic", why: "knows" }] : []),
      member: (_a, _n, prompt) => (/side thread/.test(prompt) ? { tools: [["dm", { to: "arch", text: "the TTL evidence is in cache.ts:40" }]], say: "Thirty seconds." } : "PASS"),
    });
    const room = r.create();
    room.resume();
    await room.settled();
    const q = room.post("How long can a price be stale?", "room", "new");
    await room.settled();
    expect(r.results.skeptic[0].text).toMatch(/Posted in thread/);
    expect(room.thread(q.seq).messages).toMatchObject([
      { from: "skeptic", to: "room", text: "@arch the TTL evidence is in cache.ts:40", thread: q.seq },
      { from: "skeptic", text: "Thirty seconds.", thread: q.seq },
    ]);
  });

  it("opens a channel with pinned vision and workstreams its owners start on", async () => {
    const r = setup({ member: (a, _n, prompt) => (/You're in a side thread/.test(prompt) ? `${a} on edge cases` : `${a}: first take`), floor: () => [] });
    const plan = ">> channel: levels | AI level design\n>> vision: Levels designers trust.\n>> consider: playability\n>> member: pcg | mock | PCG researcher | Knows PCG.\n>> member: ux | mock | UX researcher | Studies players.\n>> topic: Edge cases | a ranked list | ux";
    const transports = (spec: any) => (spec.id === "assistant" ? { id: "assistant", async *send() { yield { type: "text" as const, delta: plan }; } } : r.transports(spec));
    const chat = new SetupChat({ repo: r.repo, transports, clis: ["mock"], support: MOCK_SUPPORT, floor: r.floor, head: () => "abc" });
    await chat.say("levels please");
    const { room } = chat.create();
    room.resume();
    await room.settled();
    const ws = room.workstreams();
    expect(ws).toMatchObject([{ title: "Edge cases", done: "a ranked list", members: ["ux"] }]);
    // pcg had no workstream, so it gave a first take; ux started on its workstream instead.
    const calls = r.memberCalls();
    expect(calls.find((c) => c.agent === "pcg")!.prompt).toContain("the channel just opened");
    expect(calls.find((c) => c.agent === "ux")!.prompt).toContain("You're in a side thread");
    expect(calls.find((c) => c.agent === "pcg")!.prompt).toContain("Vision: Levels designers trust.");
    expect(calls.find((c) => c.agent === "pcg")!.prompt).toContain("Keep in mind: playability");
    await room.close();
  });

  it("plans the next steps of an existing channel and applies them", async () => {
    const r = setup({ member: () => "PASS", floor: () => [], scribe: ["Brief for the newcomer."] });
    const room = r.create();
    const plan = ">> vision: Pick a cache that never shows a wrong price.\n>> consider: tenants\n>> member: tenancy | mock | tenancy auditor | Audits isolation.\n>> topic: Tenant keys | a decision on key shape | tenancy, arch\n>> steer: Settle staleness first.";
    const transports = (spec: any) => (spec.id === "assistant" ? { id: "assistant", async *send(prompt: string) { yield { type: "text" as const, delta: /existing channel/.test(prompt) ? plan : "?" }; } } : r.transports(spec));
    const chat = new SetupChat({ repo: r.repo, transports, clis: ["mock"], support: MOCK_SUPPORT, room });
    await chat.say("what next?");
    await chat.apply();
    expect(room.store.config()).toMatchObject({ vision: "Pick a cache that never shows a wrong price.", considerations: ["tenants"] });
    expect(room.view().members).toContain("tenancy");
    expect(room.store.agentState("tenancy").onboarding?.brief).toBe("Brief for the newcomer.");
    expect(room.workstreams()).toMatchObject([{ title: "Tenant keys", members: ["tenancy", "arch"] }]);
    const said = messages(room).map((e) => e.type === "message" && e.text);
    expect(said).toContain("Settle staleness first.");
    expect(said.some((t) => typeof t === "string" && t.startsWith("Workstream: Tenant keys. Done when: a decision on key shape. @tenancy @arch"))).toBe(true);
  });
});

describe("Setup chat", () => {
  it("has no channel until the human approves a lineup, then every member gives a first take", async () => {
    const r = setup({ member: (a) => `${a}: first take`, floor: () => [] });
    mkdirSync(join(r.repo, "notes"));
    writeFileSync(join(r.repo, "notes", "a.md"), "x");
    const replies = [
      "Got it. Any docs they should read?",
      ">> channel: Level Gen! | AI-generated 2D levels\n>> read: notes\n>> read: missing\n>> member: pcg-researcher | mock | PCG researcher | Knows generative methods.\n>> member: ux-researcher | mock | UX researcher | Studies players.\nHere's who I'd bring in.",
    ];
    const transports = (spec: any) => (spec.id === "assistant" ? { id: "assistant", async *send() { yield { type: "text" as const, delta: replies.shift()! }; } } : r.transports(spec));
    const chat = new SetupChat({ repo: r.repo, transports, clis: ["mock"], support: MOCK_SUPPORT, floor: r.floor, head: () => "abc" });
    expect(() => chat.create()).toThrow(/no plan yet/);
    expect(await chat.say("I want help with level generation")).toEqual({ text: "Got it. Any docs they should read?", questions: [] });
    const second = await chat.say("docs are in notes/");
    expect(second.text).toBe("Here's who I'd bring in.");
    expect(second.proposal).toMatchObject({ name: "level-gen", topic: "AI-generated 2D levels", reading: ["notes", "missing"], members: [{ id: "pcg-researcher", role: "PCG researcher" }, { id: "ux-researcher" }] });
    expect(RoomStore.list(r.repo)).toEqual([]);

    const { room, skipped } = chat.create();
    expect(skipped).toEqual(["missing"]);
    expect(room.store.config()).toMatchObject({ name: "level-gen", reading: ["notes"], topic: "AI-generated 2D levels" });
    room.resume();
    await room.settled();
    expect(r.memberCalls().map((c) => c.agent).sort()).toEqual(["pcg-researcher", "ux-researcher"]);
    expect(r.memberCalls()[0].prompt).toContain("the channel just opened: read the reading list");
    await room.close();
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
