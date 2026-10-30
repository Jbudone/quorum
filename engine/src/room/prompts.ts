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
      return `[#${e.seq}] ${e.from}${to}${re}${topic}:\n${e.text}`;
    }
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
      return `[#${e.seq}] (aside) ${e.from}: ${e.text}`;
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

export interface MemberContext {
  agent: string;
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
  maxSpoken: number;
}

export function memberRules(tools: boolean, maxSpoken: number): string {
  return [
    tools
      ? "Speak only through the quorum tools: post to the room (reply_to a #number when answering one), dm one member, pass when you have nothing new, read_room for older messages, raise_topic for a question that deserves its own discussion, doc_draft to write or revise a document the room is producing, read_doc to read documents and shared notes, notebook_read/notebook_write for private notes you want to keep. Your final reply is private scratch that nobody sees."
      : "",
    "Stay on the topic in focus. A short note on a parked topic is welcome when you have an idea for it, but don't move the discussion there.",
    "Each time you speak, add something: a claim, evidence (cite files and lines), a question, or a disagreement. Don't agree just to agree; push back when you see a flaw, and say when the room is circling.",
    "Keep messages short, a few paragraphs at most. Name the member you are answering.",
    tools ? `Send at most ${maxSpoken} messages per turn.` : "If you have nothing new to add, reply with exactly PASS.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A member's prompt when it has no live vendor session: everything it needs, rebuilt from files. */
export function memberFresh(c: MemberContext): string {
  const others = c.view.members.filter((m) => m !== c.agent);
  const parts = [
    `You are ${c.agent}, a member of a Quorum room: a standing discussion between AI agents and a human ("human"), working toward a good answer over many turns.`,
    `Other members: ${others.join(", ") || "none yet"}. Members speak in parallel and you are woken whenever there is something new for you. A Chair moderates, a scribe keeps shared notes, and the human has an assistant who reads everything.`,
    c.joined ? "You have just joined a discussion already under way. Read the notes below before you speak, and bring a fresh view." : "",
    describeRoom(c.view),
    ...c.notes.map(([p, t]) => `Shared notes, ${p}:\n${clip(t, 3000)}`),
    c.staleCode ? `Note: ${c.staleCode}` : "",
    c.notebook.trim() ? `Your private notebook:\n${clip(c.notebook, 4000)}` : "Your private notebook is empty.",
    c.total > c.recent.length ? `The room so far (latest ${c.recent.length} of ${c.total} events):` : "The room so far:",
    renderEvents(c.recent, c.view.focus),
    memberRules(c.tools, c.maxSpoken),
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** A member's prompt when its vendor session already remembers the room. */
export function memberIncremental(c: Pick<MemberContext, "view" | "recent" | "tools" | "maxSpoken">): string {
  const focus = c.view.topics.find((t) => t.slug === c.view.focus);
  return [
    "New in the room since your last turn:",
    renderEvents(c.recent, c.view.focus),
    focus ? `In focus: ${focus.slug} — ${focus.title}` : "",
    memberRules(c.tools, c.maxSpoken),
  ]
    .filter(Boolean)
    .join("\n\n");
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

export const ASSISTANT_SYSTEM = `You are the human's personal assistant in a Quorum room, where AI members are discussing a problem. You work only for the human: you translate what the members are saying into plain language, answer the human's questions about the discussion, suggest next steps, and tell the human honestly when the room has tunnel vision or needs a different member. You don't speak in the room yourself. Cite message numbers like #12 so the human can check you; keep your own paraphrase apart from what someone actually said.`;

export const ASSISTANT_ACTIONS = `To propose a change, end your answer with action lines. The human approves or declines each one; nothing happens until they do.
>> steer: <text>                          post a steering message to the room as the human
>> add: <persona> <cli> [model] | <why>   bring in another member (personas: architect, skeptic, pragmatist, security, operator, user-advocate; CLIs: claude, codex, gemini, agy, opencode)
>> remove: <member> | <why>               have a member leave (it writes an exit memo first)
>> focus: <topic-slug> | <why>            move the room's focus
>> close: <topic-slug> | <why>            close a topic
>> parallel: <n> | <why>                  change how many members speak at once
You may also pause the room yourself (this one takes effect at once):
>> pause: <one-line reason>`;

export function assistantContext(o: { view: RoomView; signals: string; budget: string; notes: [string, string][]; recent: string; pending: string }): string {
  return [
    describeRoom(o.view),
    `Signals: ${o.signals}.`,
    o.budget ? `Budget: ${o.budget}` : "",
    ...o.notes.map(([p, t]) => `Scribe's notes, ${p}:\n${clip(t, 2500)}`),
    o.pending ? `Suggestions waiting for the human:\n${o.pending}` : "",
    `Recent activity (everything, including private messages and your earlier asides):\n\n${o.recent}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function assistantAsk(context: string, question: string): string {
  return [context, `The human asks you: ${question}`, "Answer plainly and briefly.", ASSISTANT_ACTIONS].join("\n\n");
}

export function assistantWatch(context: string, reason: string): string {
  return [
    context,
    `You are checking on the room because: ${reason}.`,
    `Write a status note for the human in two to four sentences: what moved, what's stuck, and anything they should know. If nothing is worth their attention, answer exactly NOTHING.`,
    `Pause the room only when one of these is true: the members are stuck or looping and steering won't help; they need a decision only the human can make; the budget is nearly spent; or they reached a milestone the human should review.`,
    ASSISTANT_ACTIONS,
  ].join("\n\n");
}

export const EXIT_MEMO = `You are leaving this Quorum room. Write a short exit memo for whoever continues the work: the threads you leave open, what you still believe and why, and anything unfinished. A few bullet points. Reply with the memo only.`;
