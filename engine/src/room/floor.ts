import { describeRoom, renderEvents, type RoomView } from "./prompts.js";
import type { RoomEvent } from "./store.js";

/** A member who should speak next, and why (shown to the member, so it knows what it was brought in for). */
export interface FloorPick {
  agent: string;
  /** The message it is answering, when there is one. */
  replyTo?: number;
  why: string;
  /** Answer privately to this sender (a DM gets a DM back). */
  to?: string;
}

export interface FloorContext {
  view: RoomView;
  /** Members who could speak, with their roles. */
  members: { id: string; role: string }[];
  /** Members mid-turn right now; they will see what's new when they finish. */
  speaking: string[];
  /** Messages since the floor last decided. */
  fresh: readonly RoomEvent[];
  /** Earlier public conversation, for context. */
  recent: readonly RoomEvent[];
  /** Most members to pick. */
  max: number;
}

/**
 * Decides who speaks next. The room calls it after new messages arrive; picking nobody is normal
 * and leaves the room quiet until something new happens. Swappable: relevance bidding today, a
 * Chair-moderated policy later.
 */
export interface FloorPolicy {
  decide(c: FloorContext, signal?: AbortSignal): Promise<FloorPick[]>;
}

/**
 * Members who must answer a message: the recipient of a DM, or whoever the human or the Chair names
 * with @id. Members name each other all the time, so between members an @mention is only a hint
 * for the floor policy, not a summons; otherwise the room falls back into ping-pong.
 */
export function mentioned(e: RoomEvent, members: string[]): string[] {
  if (e.type !== "message") return [];
  if (e.to !== "room") return members.includes(e.to) ? [e.to] : [];
  if (e.from !== "human" && e.from !== "chair") return [];
  const named = [...e.text.matchAll(/(?:^|[^\w@])@([a-z0-9][\w-]*)/gi)].map((m) => m[1].toLowerCase());
  return members.filter((m) => m !== e.from && named.includes(m));
}

export const FLOOR_SYSTEM = `You run the floor of a discussion between AI agents and a human. After each new message you decide who, if anyone, should speak next. You never speak in the discussion yourself. You answer with JSON only.`;

export function floorPrompt(c: FloorContext): string {
  const roster = c.members.map((m) => `- ${m.id}: ${m.role}${c.speaking.includes(m.id) ? " (speaking right now)" : ""}`).join("\n");
  return [
    describeRoom(c.view),
    `Members:\n${roster}`,
    c.recent.length ? `Earlier in the room:\n\n${renderEvents(c.recent, c.view.focus)}` : "",
    `New since you last decided:\n\n${renderEvents(c.fresh, c.view.focus)}`,
    `Who should speak next? Pick a member only when they have something genuinely new to add: their expertise is needed, a claim they can check or challenge, a question aimed at them, or a flaw they would catch. Several members may speak at once when each has something different to say (at most ${c.max}). A member named with @ by another member is a strong hint, not an obligation: skip them when the room already agrees or the question was answered. Do not pick someone just to agree or restate. Do not pick the author of the latest message unless someone asked them something. Silence is fine: when the point is settled, the room is circling, or it is waiting on the human, pick nobody.`,
    `Answer with JSON only, in this shape:
{"speak": [{"member": "<id>", "reply_to": <message number they answer>, "why": "<what they should bring, in a few words>"}]}
An empty list means nobody speaks.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Reads a floor model's answer leniently: the first JSON object in it, filtered to real members. */
export function parseFloor(text: string, members: string[], max: number): FloorPick[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list: any[] = Array.isArray(raw?.speak) ? raw.speak : [];
  const out: FloorPick[] = [];
  for (const p of list) {
    const agent = String(p?.member ?? "").trim();
    if (!members.includes(agent) || out.some((o) => o.agent === agent)) continue;
    const replyTo = Number(p?.reply_to);
    out.push({ agent, why: String(p?.why ?? "").trim().slice(0, 200), ...(Number.isInteger(replyTo) && replyTo > 0 ? { replyTo } : {}) });
  }
  return out.slice(0, max);
}

/** Relevance bidding: one cheap model call reads what's new and names who should answer. */
export class BidFloor implements FloorPolicy {
  constructor(private readonly ask: (prompt: string, system: string, signal?: AbortSignal) => Promise<string | undefined>) {}

  async decide(c: FloorContext, signal?: AbortSignal): Promise<FloorPick[]> {
    if (!c.members.length || !c.fresh.length) return [];
    const reply = await this.ask(floorPrompt(c), FLOOR_SYSTEM, signal);
    return reply === undefined ? [] : parseFloor(reply, c.members.map((m) => m.id), c.max);
  }
}
