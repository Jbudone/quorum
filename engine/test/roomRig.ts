import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "../src/config.js";
import type { FloorContext, FloorPick, FloorPolicy } from "../src/room/floor.js";
import { Room, SUPPORT_ROLES, type NewRoom, type TransportFactory } from "../src/room/room.js";
import type { AgentEvent, AgentTransport, McpServerSpec, SendOptions } from "../src/transports/index.js";

export const AGENTS: AgentSpec[] = [
  { id: "arch", cli: "mock", persona: "architect" },
  { id: "skeptic", cli: "mock", persona: "skeptic" },
  { id: "prag", cli: "mock", persona: "pragmatist" },
];

export type ToolCall = [name: string, args?: Record<string, unknown>];

/** What a scripted member does on a turn: reply with text, or call tools and then (optionally) say something. */
export type MemberScript = (agent: string, turn: number, prompt: string) => string | { tools: ToolCall[]; say?: string };

/** Who the scripted floor picks. The default: every member but the latest speaker, answering it. */
export type FloorScript = (c: FloorContext) => FloorPick[];
export const everyoneElse: FloorScript = (c) => {
  const last = c.fresh.at(-1)!;
  return c.members.filter((m) => last.type !== "message" || m.id !== last.from).map((m) => ({ agent: m.id, replyTo: last.seq, why: "has a view" }));
};

export interface Call {
  agent: string;
  prompt: string;
  opts?: SendOptions;
}

export interface RigOptions {
  member?: MemberScript;
  /** Replies per support role, used in order (the last one repeats). Defaults keep them silent. */
  chair?: string[];
  scribe?: string[];
  assistant?: string[];
  floor?: FloorScript;
  /** Extra events after each member reply (e.g. usage reports). */
  extra?: (agent: string, turn: number) => AgentEvent[];
  delayMs?: number;
}

/** Calls a room tool the way the MCP bridge does: over HTTP with the turn's token. */
export async function callTool(mcp: McpServerSpec, name: string, args: Record<string, unknown> = {}): Promise<{ text?: string; error?: string }> {
  const res = await fetch(`${mcp.env.QUORUM_ROOM_URL}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${mcp.env.QUORUM_ROOM_TOKEN}` },
    body: JSON.stringify({ name, arguments: args }),
  });
  return res.json();
}

/** A temp repo plus scripted, recorded transports for every member and support role. */
export function rig(o: RigOptions = {}) {
  const repo = mkdtempSync(join(tmpdir(), "quorum-room-"));
  const calls: Call[] = [];
  const results: Record<string, { text?: string; error?: string }[]> = {};
  const decisions: FloorContext[] = [];
  const floor: FloorPolicy = {
    decide: async (c) => (decisions.push(c), (o.floor ?? everyoneElse)(c)),
  };
  const turns: Record<string, number> = {};
  const member = o.member ?? ((agent) => `${agent} has a thought`);
  const support: Record<string, string[]> = {
    chair: o.chair ?? ["PASS"],
    scribe: o.scribe ?? ["NOTHING"],
    assistant: o.assistant ?? ["NOTHING"],
  };
  const transports: TransportFactory = (spec): AgentTransport => ({
    id: spec.id,
    supportsMcp: !SUPPORT_ROLES.includes(spec.id as never),
    async *send(prompt: string, opts?: SendOptions): AsyncIterable<AgentEvent> {
      calls.push({ agent: spec.id, prompt, opts });
      const n = (turns[spec.id] = (turns[spec.id] ?? 0) + 1);
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (opts?.signal?.aborted) {
        yield { type: "error", message: "aborted" };
        return;
      }
      const script = support[spec.id];
      if (script) {
        yield { type: "text", delta: script[Math.min(n - 1, script.length - 1)] };
      } else {
        const out = /You are leaving this Quorum room/.test(prompt) ? `- ${spec.id} memo` : member(spec.id, n, prompt);
        if (typeof out === "string") yield { type: "text", delta: out };
        else {
          yield { type: "text", delta: "thinking aloud" };
          for (const [name, args] of out.tools) {
            yield { type: "tool", name: `mcp__quorum__${name}` };
            (results[spec.id] ??= []).push(await callTool(opts!.mcp!, name, args));
          }
          yield { type: "text", delta: out.say ?? "PASS" };
        }
        yield* o.extra?.(spec.id, n) ?? [];
      }
      yield { type: "done", sessionId: `${spec.id}-session` };
    },
  });
  const rooms: Room[] = [];
  const create = (extra: Partial<NewRoom> = {}) => {
    const room = Room.create({ repo, transports, floor, topic: "pick a cache", agents: AGENTS.slice(0, 2), head: () => "abc123", ...extra });
    rooms.push(room);
    return room;
  };
  const memberCalls = () => calls.filter((c) => !SUPPORT_ROLES.includes(c.agent as never));
  const closeAll = () => Promise.all(rooms.splice(0).map((r) => r.close()));
  const open = (id: string, extra: Partial<NewRoom> = {}) => {
    const room = Room.open(id, { repo, transports, floor, head: () => "abc123", ...extra });
    rooms.push(room);
    return room;
  };
  return { repo, calls, memberCalls, results, decisions, transports, floor, create, open, closeAll };
}

export const types = (r: Room) => r.store.events().map((e) => e.type);
export const messages = (r: Room) => r.store.events().filter((e) => e.type === "message");
