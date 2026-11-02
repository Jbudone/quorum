import { describeRoom, renderEvents, type RoomView } from "./prompts.js";
import { TAG_KINDS, type MessageTag, type RoomEvent, type TagKind } from "./store.js";

/** A member who should speak next, and why (shown to the member, so it knows what it was brought in for). */
export interface FloorPick {
  agent: string;
  /** The message it is answering, when there is one. */
  replyTo?: number;
  why: string;
  /** Answer privately to this sender (a DM gets a DM back). */
  to?: string;
  /** The side conversation this turn belongs to. */
  thread?: number;
}

/** What the floor decided: who speaks, and what each new message did to the discussion. */
export interface FloorDecision {
  picks: FloorPick[];
  tags: MessageTag[];
}

export interface FloorContext {
  view: RoomView;
  /** Members who could speak, with their roles. */
  members: { id: string; role: string }[];
  /** Members mid-turn right now; they will see what's new when they finish. */
  speaking: string[];
  /** Members already queued to speak; picking them again adds nothing. */
  queued?: string[];
  /** Messages since the floor last decided. */
  fresh: readonly RoomEvent[];
  /** Earlier public conversation, for context. */
  recent: readonly RoomEvent[];
  /** Most members to pick. */
  max: number;
  /** Set when deciding inside a side conversation: the seq of the message it hangs off. */
  thread?: number;
}

/**
 * Decides who speaks next. The room calls it after new messages arrive; picking nobody is normal
 * and leaves the room quiet until something new happens. Swappable: relevance bidding today, a
 * Chair-moderated policy later.
 */
export interface FloorPolicy {
  decide(c: FloorContext, signal?: AbortSignal): Promise<FloorDecision>;
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

export const FLOOR_SYSTEM = `You run the floor of a discussion between AI agents and a human. After each new message you decide who, if anyone, should speak next, from the transcript you're given alone: never call tools or read files. You never speak in the discussion yourself. You answer with JSON only.`;

export function floorPrompt(c: FloorContext): string {
  const roster = c.members.map((m) => `- ${m.id}: ${m.role}${c.speaking.includes(m.id) ? " (speaking right now)" : c.queued?.includes(m.id) ? " (already queued to speak)" : ""}`).join("\n");
  return [
    describeRoom(c.view),
    `Members:\n${roster}`,
    c.thread ? `This is a side thread hanging off message #${c.thread}; decide only for the thread.` : "",
    c.recent.length ? `Earlier${c.thread ? " in the thread" : " in the room"}:\n\n${renderEvents(c.recent, c.view.focus)}` : "",
    `New since you last decided:\n\n${renderEvents(c.fresh, c.view.focus)}`,
    `Who should speak next? Pick a member only when they have something genuinely new to add: their expertise is needed, a claim they can check or challenge, a question aimed at them, or a flaw they would catch. Several members may speak at once when each has something different to say (at most ${c.max}). A member named with @ by another member is a strong hint, not an obligation: skip them when the room already agrees or the question was answered. Do not pick someone just to agree or restate. Do not pick the author of the latest message unless someone asked them something. Do not pick a member who is speaking right now or already queued unless a new message asks them a direct question. Silence is fine: when the point is settled, the room is circling, or it is waiting on the human, pick nobody.`,
    `Also tag each new message for the human's dashboard: what it did to the discussion (one of ${TAG_KINDS.join(", ")}), a headline of at most eight words, and for a critique whom it challenges, for a concession whose point was accepted. "decision" means the room settled something. For the few messages that change the discussion (a flaw that breaks a plan, new evidence, a genuinely new approach, a question settled), add a gist: what the member did, glanceable in a second, at most six plain words, starting with a past-tense verb and without their name, like "found resize deletes content" or "proposed intent checks on edits". No lists, no IDs, no jargon. Leave the gist out for agreement, restating, small points and questions; most messages have none.`,
    `Answer with JSON only, in this shape:
{"speak": [{"member": "<id>", "reply_to": <message number they answer>, "why": "<what they should bring, in a few words>"}],
 "tags": [{"msg": <message number>, "kind": "<kind>", "headline": "<at most eight words>", "against": "<member, optional>", "topic": "<topic slug, optional>", "gist": "<optional, at most six words>"}]}
An empty speak list means nobody speaks.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Reads a floor model's answer leniently: the first JSON object in it, filtered to real members and messages. */
export function parseFloor(text: string, members: string[], max: number, fresh: readonly RoomEvent[] = []): FloorDecision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { picks: [], tags: [] };
  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { picks: [], tags: [] };
  }
  const list: any[] = Array.isArray(raw?.speak) ? raw.speak : [];
  const picks: FloorPick[] = [];
  for (const p of list) {
    const agent = String(p?.member ?? "").trim();
    if (!members.includes(agent) || picks.some((o) => o.agent === agent)) continue;
    const replyTo = Number(p?.reply_to);
    picks.push({ agent, why: String(p?.why ?? "").trim().slice(0, 200), ...(Number.isInteger(replyTo) && replyTo > 0 ? { replyTo } : {}) });
  }
  const bySeq = new Map(fresh.flatMap((e) => (e.type === "message" ? [[e.seq, e] as const] : [])));
  const tags: MessageTag[] = [];
  for (const t of Array.isArray(raw?.tags) ? raw.tags : []) {
    const msg = bySeq.get(Number(t?.msg));
    const kind = String(t?.kind ?? "") as TagKind;
    if (!msg || !TAG_KINDS.includes(kind) || tags.some((x) => x.seq === msg.seq)) continue;
    const against = String(t?.against ?? "").trim().replace(/^@/, "");
    const topic = String(t?.topic ?? "").trim();
    const gist = shortGist(t?.gist);
    tags.push({
      seq: msg.seq,
      from: msg.from,
      kind,
      headline: String(t?.headline ?? "").trim().split(/\s+/).slice(0, 10).join(" ").slice(0, 80),
      ...(against && against !== msg.from && (members.includes(against) || against === "human") ? { against } : {}),
      ...(topic ? { topic } : {}),
      ...(msg.thread ? { thread: msg.thread } : {}),
      ...(gist ? { gist } : {}),
    });
  }
  return { picks: picks.slice(0, max), tags };
}

/** Relevance bidding: one cheap model call reads what's new, names who should answer, and tags each message. */
export class BidFloor implements FloorPolicy {
  constructor(private readonly ask: (prompt: string, system: string, signal?: AbortSignal) => Promise<string | undefined>) {}

  async decide(c: FloorContext, signal?: AbortSignal): Promise<FloorDecision> {
    if (!c.fresh.length) return { picks: [], tags: [] };
    const reply = await this.ask(floorPrompt(c), FLOOR_SYSTEM, signal);
    if (reply === undefined) return { picks: [], tags: [] };
    const d = parseFloor(reply, c.members.map((m) => m.id), c.max, c.fresh);
    return c.members.length ? d : { picks: [], tags: d.tags };
  }
}

/**
 * For channels from before highlights: reads back over members' messages and writes a gist for the
 * few that changed the discussion, as the floor does for new messages.
 */
export function highlightsPrompt(transcript: string): string {
  return [
    `Members' messages in a discussion, oldest first:\n\n${transcript}`,
    `Pick the few messages that changed the discussion: a flaw that breaks a plan, new evidence, a genuinely new approach, a question settled. Messages marked ★ were picked before: keep them, with a shorter gist. For each, write a gist: what the member did, glanceable in a second, at most six plain words, starting with a past-tense verb and without their name, like "found resize deletes content" or "proposed intent checks on edits". No lists, no IDs, no jargon. Skip agreement, restating and small points; most messages get none. At most one in four messages, and no more than twelve in all.`,
    `Answer with JSON only: {"highlights": [{"msg": <message number>, "kind": "<${TAG_KINDS.join("|")}>", "gist": "<the gist>"}]}`,
  ].join("\n\n");
}

/** Reads highlightsPrompt's answer: gists for real member messages only. */
export function parseHighlights(text: string, messages: readonly RoomEvent[]): MessageTag[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const bySeq = new Map(messages.flatMap((e) => (e.type === "message" ? [[e.seq, e] as const] : [])));
  const out: MessageTag[] = [];
  for (const h of Array.isArray(raw?.highlights) ? raw.highlights : []) {
    const msg = bySeq.get(Number(h?.msg));
    const gist = shortGist(h?.gist);
    const kind = (TAG_KINDS as string[]).includes(String(h?.kind)) ? (String(h.kind) as TagKind) : "idea";
    if (!msg || msg.type !== "message" || !gist || out.some((x) => x.seq === msg.seq)) continue;
    out.push({ seq: msg.seq, from: msg.from, kind, headline: "", gist, ...(msg.thread ? { thread: msg.thread } : {}) });
  }
  return out.slice(0, 12);
}

/** Words past which a gist is too long to read at a glance (the prompt asks for six). */
export const GIST_WORDS = 8;

/** A gist as the highlights show it: one short line, no trailing period. */
export function shortGist(g: unknown): string {
  return String(g ?? "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "").split(" ").slice(0, GIST_WORDS).join(" ").slice(0, 70);
}

export const CARD_SYSTEM = `You explain one message from a discussion between AI agents to a human who is glancing at it. Plain words, no preamble, never more than asked for.`;

/** The card shown when the human hovers a highlight: a little more than the gist, still quick to read. */
export function highlightCardPrompt(o: { from: string; gist: string; text: string; topic?: string; before?: string }): string {
  return [
    o.topic ? `The discussion is about: ${o.topic}` : "",
    o.before ? `What it answered:\n\n${o.before}` : "",
    `${o.from}'s message (its highlight reads "${o.gist}"):\n\n${o.text.slice(0, 6000)}`,
    `Write exactly this, in markdown, for someone who hasn't followed the discussion:
- one paragraph of at most two short sentences (under 40 words): what ${o.from} found or proposed, and why it matters
- then two or three bullets, the noteworthy specifics, each under twelve words
- then, only if a picture makes it clearer (a flow, a before/after, a comparison), a tiny diagram in a code block: at most five lines, at most 44 characters wide, plain box-drawing or ASCII
Nothing more: no headings, no bold labels, no message numbers, no file paths or line numbers. It's read in a few seconds.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
