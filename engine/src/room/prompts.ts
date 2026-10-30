import type { RoomEvent } from "./store.js";

/** What a room looks like right now, as every prompt describes it. */
export interface RoomView {
  topic: string;
  focus?: string;
  topics: { slug: string; title: string; closed: boolean }[];
  docs: { slug: string; version: number; kind: string; accepted?: number }[];
  members: string[];
}

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters; read_doc for the rest)` : t);

export function renderEvent(e: RoomEvent, focus?: string): string {
  switch (e.type) {
    case "message": {
      const to = e.to === "room" ? "" : ` → ${e.to} (private)`;
      const re = e.replyTo ? ` (re #${e.replyTo})` : "";
      const topic = e.topic && e.topic !== focus ? ` [note on parked topic ${e.topic}]` : "";
      const thread = e.thread === e.seq ? " [starts a side thread]" : e.thread ? ` [in thread #${e.thread}]` : "";
      return `[#${e.seq}] ${e.from}${to}${re}${topic}${thread}:\n${e.text}`;
    }
    case "thread.summary":
      return `[#${e.seq}] — side thread #${e.thread} settled: ${e.text}`;
    case "tags":
      return "";
    case "topic.raised":
      return `[#${e.seq}] — ${e.by} raised a topic: "${e.title}" (${e.slug})${e.why ? `: ${e.why}` : ""}`;
    case "topic.focus":
      return `[#${e.seq}] — the room's focus is now ${e.slug}`;
    case "topic.closed":
      return `[#${e.seq}] — topic ${e.slug} closed${e.why ? `: ${e.why}` : ""}`;
    case "doc.revised":
      return `[#${e.seq}] — ${e.by} wrote ${e.slug} v${e.version}${e.note ? `: ${e.note}` : ""}`;
    case "doc.accepted":
      return `[#${e.seq}] — ${e.slug} v${e.version} accepted`;
    case "agent.joined":
      return `[#${e.seq}] — ${e.agent} joined the room`;
    case "agent.left":
      return `[#${e.seq}] — ${e.agent} left the room`;
    case "pass":
      return `[#${e.seq}] — ${e.from} passed`;
    case "aside":
      return `[#${e.seq}] (aside${e.kind === "digest" ? ", digest" : ""}) ${e.from}: ${e.text}`;
    case "floor":
      return `[#${e.seq}] (floor) ${e.picks.map((p) => `${p.agent}${p.why ? ` (${p.why})` : ""}`).join(", ") || "nobody"}`;
    case "suggestion":
      return `[#${e.seq}] (suggestion ${e.id} from ${e.from}) ${e.action} ${e.args.join(" ")}${e.why ? ` | ${e.why}` : ""}`;
    case "suggestion.resolved":
      return `[#${e.seq}] (suggestion ${e.id} ${e.accepted ? "approved" : "declined"} by the human)`;
    case "paused":
      return `[#${e.seq}] — room paused: ${e.reason}`;
    case "resumed":
      return `[#${e.seq}] — room resumed`;
    case "budget":
      return `[#${e.seq}] — budget ${e.level}: ${e.detail}`;
    case "turn.failed":
      return `[#${e.seq}] — ${e.agent}'s turn failed: ${e.message}`;
    case "docs.updated":
      return "";
  }
}

export const renderEvents = (es: readonly RoomEvent[], focus?: string): string =>
  es
    .map((e) => renderEvent(e, focus))
    .filter(Boolean)
    .join("\n\n");

export function describeRoom(v: RoomView): string {
  const open = v.topics.filter((t) => !t.closed);
  const focus = v.topics.find((t) => t.slug === v.focus);
  const lines = [
    `Room question: ${v.topic}`,
    focus ? `In focus: ${focus.slug} — ${focus.title}${focus.closed ? " (closed)" : ""}` : "No topic in focus.",
  ];
  const parked = open.filter((t) => t.slug !== v.focus);
  if (parked.length) lines.push(`Parked topics: ${parked.map((t) => `${t.slug} (${t.title})`).join("; ")}`);
  const closed = v.topics.filter((t) => t.closed && t.slug !== v.focus);
  if (closed.length) lines.push(`Closed topics: ${closed.map((t) => t.slug).join(", ")}`);
  if (v.docs.length)
    lines.push(
      `Documents: ${v.docs.map((d) => `${d.slug} (${d.kind}) v${d.version}${d.accepted ? `, v${d.accepted} accepted` : ""}`).join("; ")}`,
    );
  lines.push(`Members: ${v.members.join(", ") || "none"}`);
  return lines.join("\n");
}

/** Why a member was given the floor this turn. */
export interface FloorReason {
  why: string;
  replyTo?: number;
  /** Set when answering a private message: the reply goes only to this sender. */
  to?: string;
  /** The side conversation this turn belongs to. */
  thread?: number;
  /** With independent takes on: the last event this member may see before it drafts. */
  snapshot?: number;
}

/** What a member should read, and what changed since it last did. */
export interface Reading {
  paths: string[];
  /** Files changed since the member last read the list; undefined when it never has. */
  changed?: string[];
}

export interface MemberContext {
  agent: string;
  reading?: Reading;
  /** Where things stand in this member's other channels, as [channel, digest]. */
  elsewhere?: [string, string][];
  /** A catch-up brief written for this member when it joined. */
  brief?: string;
  view: RoomView;
  /** Shared notes worth showing on a fresh start, as [path, text]. */
  notes: [string, string][];
  /** Set when code notes were written at another commit. */
  staleCode?: string;
  notebook: string;
  recent: readonly RoomEvent[];
  total: number;
  joined: boolean;
  tools: boolean;
  floor?: FloorReason;
}

function readingLine(r?: Reading): string {
  if (!r?.paths.length) return "";
  if (!r.changed) {
    return `This channel's reading list: ${r.paths.join(", ")}. You haven't read it yet: read it now (it's where earlier discussions left off), and write what you need to remember into your notebook (notebook_write) so you don't have to reread it.`;
  }
  return r.changed.length ? `Changed in the reading list since you last read it: ${r.changed.slice(0, 20).join(", ")}${r.changed.length > 20 ? " …" : ""}. Read what matters to you.` : "";
}

export function memberRules(tools: boolean): string {
  return [
    "Your reply is what you say to the room: everyone sees it as it is written, so write it as a message, not as a report about what you did. Don't narrate reading files or calling tools.",
    tools
      ? "Tools are for side actions only: dm one member (or the human) privately, raise_topic for a question that deserves its own discussion, doc_draft to write or revise a document the room is producing (then say in your reply what you changed), read_doc for documents and shared notes, read_room for older messages, notebook_read/notebook_write for private notes you want to keep."
      : "",
    "Stay on the topic in focus.",
    "Add something each time you speak: a claim, evidence (cite files and lines), a sharp question, or a disagreement. Don't agree just to agree; push back when you see a flaw, and say so when the room is circling.",
    "Talk like a colleague in a meeting: short, a few sentences to a few paragraphs. Use @name only when you need a particular member to answer; whoever has something to add will be brought in anyway.",
    "When the room has converged, say so plainly and stop; don't restate agreement.",
    "If on reflection you have nothing new to add, reply with exactly PASS and nobody will see it.",
  ]
    .filter(Boolean)
    .join(" ");
}

const floorLine = (f?: FloorReason): string =>
  !f
    ? ""
    : `You have the floor${f.replyTo ? ` to answer #${f.replyTo}` : ""}: ${f.why || "the room wants your view"}.` +
      (f.to ? ` Your reply goes privately to ${f.to}, not to the room.` : "");

/** A member's prompt when it has no live vendor session: everything it needs, rebuilt from files. */
export function memberFresh(c: MemberContext): string {
  const others = c.view.members.filter((m) => m !== c.agent);
  const parts = [
    `You are ${c.agent}, a member of a Quorum room: a standing discussion between AI agents and a human ("human"), working toward a good answer over many turns.`,
    `Other members: ${others.join(", ") || "none yet"}. It works like a team chat: nobody takes turns in order, you're brought in when you have something relevant to add, and several members may be talking at once. A Chair moderates, a scribe keeps shared notes, and the human has an assistant who reads everything.`,
    readingLine(c.reading),
    ...(c.elsewhere ?? []).map(([ch, d]) => `You're also in #${ch}, where things stand like this:\n${clip(d, 800)}`),
    c.joined ? "You have just joined a discussion already under way. Read the notes below before you speak, and bring a fresh view." : "",
    c.brief ? `A catch-up brief written for you:\n${c.brief}` : "",
    describeRoom(c.view),
    ...c.notes.map(([p, t]) => `Shared notes, ${p}:\n${clip(t, 3000)}`),
    c.staleCode ? `Note: ${c.staleCode}` : "",
    c.notebook.trim() ? `Your private notebook:\n${clip(c.notebook, 4000)}` : "",
    c.total > c.recent.length ? `The room so far (latest ${c.recent.length} of ${c.total} events):` : "The room so far:",
    renderEvents(c.recent, c.view.focus),
    floorLine(c.floor),
    memberRules(c.tools),
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** A member's prompt when its vendor session already remembers the room. */
export function memberIncremental(c: Pick<MemberContext, "view" | "recent" | "tools" | "floor" | "reading">): string {
  const focus = c.view.topics.find((t) => t.slug === c.view.focus);
  return [
    "New in the room since you last spoke:",
    renderEvents(c.recent, c.view.focus) || "(nothing new)",
    focus ? `In focus: ${focus.slug} — ${focus.title}` : "",
    readingLine(c.reading),
    floorLine(c.floor),
    memberRules(c.tools),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A member's prompt inside a side thread: the channel in brief, the message it hangs off, and the thread. */
export function memberThread(c: { agent: string; view: RoomView; digest?: string; root?: RoomEvent; thread: readonly RoomEvent[]; tools: boolean; floor?: FloorReason; fresh: boolean }): string {
  return [
    c.fresh ? `You are ${c.agent}, a member of a Quorum channel: a standing discussion between AI agents and a human.` : "",
    c.fresh ? describeRoom(c.view) : "",
    c.fresh && c.digest ? `Where the channel stands:\n${clip(c.digest, 1200)}` : "",
    "You're in a side thread: a focused conversation off the main channel. Keep to its question; when it's answered, say so in one line.",
    c.root ? `It hangs off this message:\n${renderEvent(c.root)}` : "",
    c.thread.length ? `${c.fresh ? "The thread so far" : "New in the thread"}:\n\n${renderEvents(c.thread)}` : "",
    floorLine(c.floor),
    memberRules(c.tools),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Asks a member who thought independently to revise after reading what others said meanwhile. */
export function reviseIndependent(draft: string, others: readonly RoomEvent[]): string {
  return [
    "While you were thinking, other members answered the same thing:",
    renderEvents(others),
    `Your draft was:\n${draft}`,
    "Reply with your final message: keep the draft if it still adds something, sharpen it in light of what they said, or answer exactly PASS if they already covered it. Don't mention that you revised.",
  ].join("\n\n");
}

export const THREAD_SUMMARY = `You summarize side threads in a team discussion. Answer with one short sentence: the thread's outcome or where it stands, naming who holds which view if they disagree.`;

export function threadSummaryPrompt(root: RoomEvent | undefined, thread: readonly RoomEvent[]): string {
  return [root ? `The thread hangs off:\n${renderEvent(root)}` : "", `The thread:\n\n${renderEvents(thread)}`, "One sentence."].filter(Boolean).join("\n\n");
}

export const CHAIR_SYSTEM = `You chair a Quorum room: AI members discuss a problem with a human present. You don't argue a position. You keep the discussion productive: keep it on the topic in focus, notice when it circles or stalls, bring in quiet members, and decide when a document the room produced is agreed.`;

export function chairPrompt(o: { view: RoomView; roster: string; signals: string; recent: string; reason: string }): string {
  return [
    `Why you were called: ${o.reason}.`,
    describeRoom(o.view),
    `Members, with turns taken and when each last spoke:\n${o.roster}`,
    `Signals: ${o.signals}.`,
    `Recent activity:\n\n${o.recent}`,
    `Write a short message to the room (two to five sentences) if it would help: sum up where things stand, name the open disagreement, ask a quiet member for their view, or redirect a drifting thread. Write exactly PASS instead if the room is fine without you.`,
    `Then, on their own lines at the end, any actions:
>> accept: <document> v<N>     a document version the members have clearly agreed on
>> nudge: <member> | <text>    a private nudge to one member
>> raise: <title> | <why>      a new topic the room keeps returning to
>> focus: <topic-slug> | <why> propose moving the focus (the human decides)
>> close: <topic-slug> | <why> propose closing a topic whose question is answered (the human decides)`,
  ].join("\n\n");
}

export const SCRIBE_SYSTEM = `You are the scribe of a Quorum room. You keep its shared notes accurate, short and current. You never take sides and never invent anything that wasn't said.`;

export function scribePrompt(o: { view: RoomView; docs: [string, string][]; recent: string; commit?: string }): string {
  return [
    describeRoom(o.view),
    o.docs.length ? `Current notes:\n\n${o.docs.map(([p, t]) => `=== ${p} ===\n${t}`).join("\n\n")}` : "There are no notes yet.",
    `New activity since you last updated the notes:\n\n${o.recent}`,
    `Update the notes. Files you may write:
- decisions.md: decisions the room reached, each with its message number(s), e.g. (#14, #17)
- facts.md: established facts about the problem and the code
- open-questions.md: questions still open, and who raised them
- code-notes.md: what members learned about the codebase (files, functions, how things work)${o.commit ? `, as of commit ${o.commit}` : ""}
- topics/<slug>.md: one page per topic: where the discussion stands, the positions and who holds them`,
    `Answer only with the files that changed, each as a header line followed by the file's full new contents:

=== decisions.md ===
...contents...

Keep each file under about 60 lines; fold old detail into short summaries. Cite message numbers. If nothing needs to change, answer exactly NOTHING.`,
  ].join("\n\n");
}

export const ASSISTANT_SYSTEM = `You are the human's assistant in a Quorum channel, where AI members work on a problem with the human present. You work only for the human: you say plainly what the members mean, answer questions about the discussion, suggest next steps, and say honestly when the room has tunnel vision or is missing someone. You don't speak in the channel yourself.

Write like a sharp colleague in a chat: one to three short sentences, plain words, no headings, no bold labels, no bullet lists unless asked. Cite a message number like #12 only when it helps the human check you. Never pad, never recap what the human just said.`;

export function assistantActions(clis: string[], members: string[]): string {
  return `To propose a change, end with action lines; the human approves or declines each, and nothing happens until they do.
>> hire: <id> | <cli> [model] | <role, a few words> | <persona: two or three sentences on expertise and how they think> | <why>
                                   bring in a new member, invented for this problem (CLIs: ${clis.join(", ")})
>> add: <member> <cli> [model] | <why>   bring back a workspace member${members.length ? ` (${members.join(", ")})` : ""}
>> steer: <text>                          post a steering message to the channel as the human
>> remove: <member> | <why>               have a member leave (it writes an exit memo first)
>> focus: <topic-slug> | <why>            move the focus
>> close: <topic-slug> | <why>            close a topic
>> parallel: <n> | <why>                  change how many members may speak at once
You may also pause the channel yourself (this one takes effect at once):
>> pause: <one-line reason>`;
}

export function assistantContext(o: { view: RoomView; signals: string; budget: string; notes: [string, string][]; recent: string; pending: string; digest?: string }): string {
  return [
    describeRoom(o.view),
    `Signals: ${o.signals}.`,
    o.budget ? `Budget: ${o.budget}` : "",
    ...o.notes.map(([p, t]) => `Scribe's notes, ${p}:\n${clip(t, 2500)}`),
    o.digest ? `Your current two-line status for the human:\n${o.digest}` : "",
    o.pending ? `Suggestions waiting for the human:\n${o.pending}` : "",
    `Recent activity (everything, including private messages and your earlier asides):\n\n${o.recent}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function assistantAsk(context: string, question: string, actions: string): string {
  return [context, `The human asks you: ${question}`, "Answer in one to three short sentences.", actions].join("\n\n");
}

export function assistantWatch(context: string, reason: string, actions: string): string {
  return [
    context,
    `You are checking on the channel because: ${reason}.`,
    `First rewrite the status line the human glances at: at most two short lines on where things stand right now. Start it with a line that says exactly DIGEST: and write it fresh.

Then, only if something shifted that the human should hear about (a decision landed, someone changed their mind, the room is circling, someone is missing, or it needs the human), add a line that says exactly NOTE: followed by one sentence. Never repeat an earlier note. Most check-ins have no note.`,
    `Pause only when the members are stuck and steering won't help, they need a decision only the human can make, the budget is nearly spent, or they reached a milestone the human should review.`,
    actions,
  ].join("\n\n");
}

export const SETUP_SYSTEM = `You are the human's assistant in Quorum, setting up a new channel: a long-lived team chat where AI members work on a hard problem with the human, possibly for weeks. Your job now is to understand the problem and assemble the right people.

Write like a colleague in a chat: one to three short sentences per reply, plain words, no headings or bullet lists. Ask at most one question at a time, and only when the answer changes who you'd bring in or what they should read.

Choose members the way you'd staff a research group, not a review board: real specialties that fit this problem (for example a research scientist in the relevant field, a UX researcher, someone who brings realistic use cases and edge cases, an engineer who has to build it). Three to six members, each with a distinct angle. Mix CLIs where it helps, since different models catch different things; put the strongest model on the roles that need the most judgment. Reuse existing workspace members when they fit; they bring their memory.`;

export function setupPrompt(o: { repo: string; members: { id: string; role?: string; persona: string; cli: string; model?: string }[]; channels: string[]; clis: string[]; history: { from: "human" | "assistant"; text: string }[] }): string {
  return [
    `The project is at ${o.repo}. You can read files there to find the docs the human mentions.`,
    o.channels.length ? `Existing channels: ${o.channels.map((c) => `#${c}`).join(", ")}.` : "This is the first channel.",
    o.members.length ? `Workspace members you can reuse:\n${o.members.map((m) => `- ${m.id}: ${m.role ?? m.persona} (${m.cli}${m.model ? ` ${m.model}` : ""})`).join("\n")}` : "",
    `The conversation so far:\n\n${o.history.map((h) => `${h.from}: ${h.text}`).join("\n\n")}`,
    `Reply to the human. When you know enough, propose the channel with these lines at the end of your reply (repeat the full set whenever you change it; the human sees it as a card and can ask you to change anything):
>> channel: <short-name> | <one-sentence topic>
>> read: <path relative to the project>         one line per folder or file the members should read first
>> member: <id> | <cli> [model] | <role, a few words> | <persona: two or three sentences on expertise and how they think>
>> member: <existing-id>                         to reuse a workspace member as they are
Member ids are short lowercase names like "pcg-researcher". CLIs available: ${o.clis.join(", ")}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A proposed channel, read from the setup assistant's action lines. */
export interface SetupProposal {
  name?: string;
  topic?: string;
  reading: string[];
  members: { id: string; cli?: string; model?: string; role?: string; persona?: string }[];
}

/** Reads `>> channel/read/member` lines. Returns undefined when the reply proposes nothing. */
export function parseSetup(text: string): { prose: string; proposal?: SetupProposal } {
  const prose: string[] = [];
  const p: SetupProposal = { reading: [], members: [] };
  let any = false;
  for (const line of text.split("\n")) {
    const m = /^\s*>>\s*(channel|read|member)\s*:\s*(.*)$/i.exec(line);
    if (!m) {
      prose.push(line);
      continue;
    }
    any = true;
    const parts = m[2].split("|").map((x) => x.trim());
    switch (m[1].toLowerCase()) {
      case "channel":
        p.name = parts[0].toLowerCase().replace(/^#/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || undefined;
        p.topic = parts.slice(1).join(" | ") || undefined;
        break;
      case "read":
        if (parts[0]) p.reading.push(parts[0]);
        break;
      case "member": {
        const id = parts[0].toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || p.members.some((x) => x.id === id)) break;
        const [cli, model] = (parts[1] ?? "").split(/\s+/).filter(Boolean);
        p.members.push({ id, ...(cli ? { cli } : {}), ...(model ? { model } : {}), ...(parts[2] ? { role: parts[2] } : {}), ...(parts[3] ? { persona: parts.slice(3).join(" | ") } : {}) });
        break;
      }
    }
  }
  return { prose: prose.join("\n").trim(), ...(any ? { proposal: p } : {}) };
}

/** Splits a check-in into its digest and optional note. A reply without the markers is all note. */
export function parseWatch(prose: string): { digest?: string; note?: string } {
  const d = /^\s*DIGEST:\s*/im.exec(prose);
  const n = /^\s*NOTE:\s*/im.exec(prose);
  if (!d && !n) return prose.trim() && prose.trim() !== "NOTHING" ? { note: prose.trim() } : {};
  const digest = d ? prose.slice(d.index + d[0].length, n && n.index > d.index ? n.index : undefined).trim() : undefined;
  const note = n ? prose.slice(n.index + n[0].length, d && d.index > n.index ? d.index : undefined).trim() : undefined;
  return { ...(digest ? { digest } : {}), ...(note && note !== "NOTHING" ? { note } : {}) };
}

export const BRIEF_SYSTEM = `You write catch-up briefs for people joining a long-running team discussion. You are concise and concrete, and you never invent anything that wasn't said.`;

export function briefPrompt(o: { view: RoomView; member: string; role: string; persona: string; digest?: string; notes: [string, string][]; recent: string }): string {
  return [
    describeRoom(o.view),
    o.digest ? `Where things stand, per the human's assistant:\n${o.digest}` : "",
    ...o.notes.map(([p, t]) => `Shared notes, ${p}:\n${clip(t, 2500)}`),
    `Recent discussion:\n\n${o.recent || "(nothing yet)"}`,
    `${o.member} is joining as: ${o.role}.\n${o.persona}`,
    `Write ${o.member} a catch-up brief of at most 150 words: where the discussion stands, what's agreed, what's open and who holds which view, and what someone in their role should look at first. Cite message numbers. Plain prose, no headings.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const PERSONA_SYSTEM = `You write personas for members of a long-running AI discussion group: specialists who will argue, check code and evidence, and change their minds when shown wrong.`;

export function personaDraftPrompt(o: { line: string; view: RoomView; taken: string[] }): string {
  return [
    describeRoom(o.view),
    `The human wants a new member: ${o.line}`,
    `Write the member. Answer with exactly these three lines and nothing else:
ID: <short lowercase id with dashes, not one of: ${o.taken.join(", ") || "none"}>
ROLE: <a few words>
PERSONA: <two to four sentences: their expertise, what they look for, how they argue>`,
  ].join("\n\n");
}

/** Reads a drafted persona; undefined when the reply doesn't have all three parts. */
export function parsePersonaDraft(text: string): { id: string; role: string; persona: string } | undefined {
  const get = (k: string) => new RegExp(`^\\s*${k}:\\s*(.+)$`, "im").exec(text)?.[1].trim();
  const id = get("ID")?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const role = get("ROLE");
  const persona = /^\s*PERSONA:\s*([\s\S]+)$/im.exec(text)?.[1].trim();
  return id && role && persona ? { id, role, persona } : undefined;
}

export const EXIT_MEMO = `You are leaving this Quorum room. Write a short exit memo for whoever continues the work: the threads you leave open, what you still believe and why, and anything unfinished. A few bullet points. Reply with the memo only.`;
