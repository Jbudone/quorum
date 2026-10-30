import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSpec } from "../src/config.js";
import { Room, type RoomEmit } from "../src/room/room.js";
import { RoomStore } from "../src/room/store.js";
import type { AgentEvent, AgentTransport, SendOptions } from "../src/transports/index.js";
import { MockTransport, type MockOptions } from "../src/transports/mock.js";

const agents: AgentSpec[] = [
  { id: "arch", cli: "mock", persona: "architect" },
  { id: "skeptic", cli: "mock", persona: "skeptic" },
  { id: "prag", cli: "mock", persona: "pragmatist" },
];

interface Call {
  agent: string;
  prompt: string;
  opts?: SendOptions;
}

/** Mock transports that record every call; `mock` picks each agent's script. */
function rig(mock: (id: string) => MockOptions = (id) => ({ rules: [], fallback: `${id} has a thought` })) {
  const repo = mkdtempSync(join(tmpdir(), "quorum-room-"));
  const calls: Call[] = [];
  const transportFor = (agent: string): AgentTransport => {
    const t = new MockTransport(agent, mock(agent));
    return {
      id: agent,
      send: (prompt, opts) => (calls.push({ agent, prompt, opts }), t.send(prompt, opts)),
    };
  };
  return { repo, calls, transportFor };
}

const types = (r: Room) => r.store.events().map((e) => e.type);

describe("Room", () => {
  it("wakes agents on new messages until the turn cap pauses it", async () => {
    const { repo, calls, transportFor } = rig();
    const room = Room.create({ repo, transportFor, topic: "design X", agents: agents.slice(0, 2), turnCap: 5 });
    const states: RoomEmit[] = [];
    room.on((e) => e.event === "room.state" && states.push(e));
    room.resume();
    await room.settled();

    expect(calls).toHaveLength(5);
    expect(room.state).toBe("paused");
    expect(states.at(-1)).toMatchObject({ data: { state: "paused", reason: "turn cap reached (5 turns)" } });
    expect(types(room)).toEqual(["message", "resumed", ...Array(5).fill("message"), "paused"]);
    expect(calls[0].prompt).toContain("Topic: design X");
    expect(calls[0].prompt).toContain("Other members: skeptic");
  });

  it("goes idle when everyone passes, and a human post wakes them again", async () => {
    const { repo, calls, transportFor } = rig(() => ({ rules: [], fallback: "PASS" }));
    const room = Room.create({ repo, transportFor, topic: "t", agents: agents.slice(0, 2) });
    room.resume();
    await room.settled();
    expect(room.state).toBe("idle");
    expect(types(room).filter((t) => t === "pass")).toHaveLength(2);

    room.post("what about caching?");
    await room.settled();
    expect(calls).toHaveLength(4);
    expect(calls[2].prompt).toContain("what about caching?");
  });

  it("never runs more agents at once than the parallel cap", async () => {
    const repo = mkdtempSync(join(tmpdir(), "quorum-room-"));
    let now = 0;
    let peak = 0;
    const transportFor = (id: string): AgentTransport => ({
      id,
      async *send(): AsyncIterable<AgentEvent> {
        peak = Math.max(peak, ++now);
        await new Promise((r) => setTimeout(r, 5));
        now--;
        yield { type: "text", delta: "PASS" };
        yield { type: "done" };
      },
    });
    const room = Room.create({ repo, transportFor, topic: "t", agents, parallel: 2 });
    room.resume();
    await room.settled();
    expect(peak).toBe(2);
    expect(types(room).filter((t) => t === "pass")).toHaveLength(3);
  });

  it("resumes after a restart with saved vendor sessions, sending only what's new", async () => {
    const first = rig();
    const room = Room.create({ ...first, topic: "t", agents: agents.slice(0, 2), turnCap: 2 });
    room.resume();
    await room.settled();
    const seq = room.store.lastSeq;

    // A fresh process: new Room instance, new transports, same files on disk.
    const second = rig();
    const again = Room.open(room.id, { repo: first.repo, transportFor: second.transportFor });
    expect(again.configure({ turnCap: 3, parallel: undefined })).toEqual({ parallel: 2, turnCap: 3 });
    expect(() => again.configure({ parallel: 0 })).toThrow(/at least 1/);
    expect(RoomStore.list(first.repo)).toEqual([room.id]);
    again.resume();
    await again.settled();

    expect(second.calls[0].opts?.sessionId).toBe(`${second.calls[0].agent}-session`);
    expect(second.calls[0].prompt).toMatch(/^New in the room since your last turn/);
    expect(again.store.events().find((e) => e.type === "resumed" && e.seq > seq)).toBeDefined();
    expect(second.calls).toHaveLength(3);
  });

  it("aborts turns on pause and redoes them on resume", async () => {
    const { repo, calls, transportFor } = rig(() => ({ rules: [], fallback: "a long considered reply", chunkDelayMs: 5 }));
    const room = Room.create({ repo, transportFor, topic: "t", agents: agents.slice(0, 1) });
    room.resume();
    await new Promise((r) => setTimeout(r, 7));
    room.pause();
    await room.settled();
    expect(types(room)).toEqual(["message", "resumed", "paused"]);
    expect(room.store.agentState("arch").lastRead).toBe(0);

    room.resume();
    await room.settled();
    expect(calls).toHaveLength(2);
    expect(room.store.events().at(-1)).toMatchObject({ type: "message", from: "arch", text: "a long considered reply" });
  });

  it("delivers a DM only to its recipient", async () => {
    const { repo, calls, transportFor } = rig(() => ({ rules: [], fallback: "PASS" }));
    const room = Room.create({ repo, transportFor, topic: "t", agents: agents.slice(0, 2) });
    room.resume();
    await room.settled();
    room.post("just between us", "skeptic");
    await room.settled();
    expect(calls.slice(2).map((c) => c.agent)).toEqual(["skeptic"]);
    expect(calls[2].prompt).toContain("human → skeptic (private)");
    expect(() => room.post("hi", "nobody")).toThrow(/unknown agent/);
  });

  it("records a failed turn, drops the vendor session, and doesn't retry in a loop", async () => {
    const repo = mkdtempSync(join(tmpdir(), "quorum-room-"));
    const transportFor = (id: string): AgentTransport => ({
      id,
      async *send(): AsyncIterable<AgentEvent> {
        yield { type: "error", message: "rate limited" };
      },
    });
    const room = Room.create({ repo, transportFor, topic: "t", agents: agents.slice(0, 1) });
    room.store.saveAgentState("arch", { sessionId: "stale", lastRead: 0, turns: 0 });
    room.resume();
    await room.settled();
    expect(room.state).toBe("idle");
    expect(room.store.events().at(-1)).toMatchObject({ type: "turn.failed", agent: "arch", message: "rate limited" });
    expect(room.store.agentState("arch")).toEqual({ lastRead: 2, turns: 1 });
  });
});
