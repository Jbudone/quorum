import type { RoomEvent } from "./store.js";

/** What a room looks like right now, as every prompt describes it. */
export interface RoomView {
  topic: string;
  vision?: string;
  considerations?: string[];
  workstreams?: { thread: number; title: string; done?: string; members: string[]; settled: boolean }[];
  focus?: string;
  topics: { slug: string; title: string; closed: boolean }[];
  /** `ready`: the version up for the human's review; `reviewed`: the last version the human reviewed; `by`: the latest version's author. */
  docs: { slug: string; version: number; kind: string; accepted?: number; ready?: number; reviewed?: number; by?: string }[];
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
    case "workstream":
      return "";
    case "mail.out":
      return `[#${e.seq}] — mail sent to ${e.to}: "${e.subject}" (${e.path ?? `.quorum/mail/${e.file}`})`;
    case "gists":
      return "";
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
      return `[#${e.seq}] — ${e.slug} v${e.version} accepted${e.by === "human" ? " by the human" : ""}`;
    case "doc.ready":
      return `[#${e.seq}] — ${e.slug} v${e.version} is up for the human's review`;
    case "doc.reviewed":
      return `[#${e.seq}] — the human ${e.action === "revise" ? "asked for changes to" : "asked about"} ${e.slug} v${e.version}${e.section ? ` (${e.section})` : ""}`;
    case "doc.exported":
      return `[#${e.seq}] — ${e.slug} v${e.version} exported to ${e.path}`;
    case "doc.brief":
      return `[#${e.seq}] (brief of ${e.slug} v${e.version} for the human)\n${e.text}`;
    case "workstream.closed":
      return `[#${e.seq}] — workstream #${e.thread} closed by the ${e.by}`;
    case "agent.joined":
      return `[#${e.seq}] — ${e.agent} joined the room`;
    case "agent.left":
      return `[#${e.seq}] — ${e.agent} left the room`;
    case "access.granted":
      return `[#${e.seq}] — everyone can now read ${e.path}`;
    case "agent.web":
      return `[#${e.seq}] — ${e.agent} ${e.on ? "can now search the web" : "is offline again"}`;
    case "agent.swapped":
      return `[#${e.seq}] — ${e.agent} now runs on ${e.cli}${e.model ? ` ${e.model}` : ""}`;
    case "pass":
      return `[#${e.seq}] — ${e.from} passed`;
    case "aside":
      return `[#${e.seq}] (aside${e.kind === "digest" ? ", digest" : ""}) ${e.from}: ${e.text}`;
    case "floor":
      return `[#${e.seq}] (floor) ${e.picks.map((p) => `${p.agent}${p.replyTo ? ` to answer #${p.replyTo}` : ""}${p.why ? ` (${p.why})` : ""}`).join(", ") || "nobody"}`;
    case "suggestion":
      return `[#${e.seq}] (suggestion ${e.id} from ${e.from}) ${e.action} ${e.args.join(" ")}${e.why ? ` | ${e.why}` : ""}`;
    case "suggestion.resolved":
      return `[#${e.seq}] (suggestion ${e.id} ${e.withdrawn ? "withdrawn" : e.accepted ? `approved by the human${e.args ? `, changed to: ${e.args.join(" | ")}` : ""}` : "declined by the human"})`;
    case "paused":
      return `[#${e.seq}] — room paused: ${e.reason}`;
    case "resumed":
      return `[#${e.seq}] — room resumed`;
    case "budget":
      return `[#${e.seq}] — budget ${e.level}: ${e.detail}`;
    case "turn.failed":
      return `[#${e.seq}] — ${e.agent}'s turn failed: ${e.message}`;
    case "turn.aborted":
      return `[#${e.seq}] — ${e.agent}'s turn${e.replyTo ? ` answering #${e.replyTo}` : ""} was cut off (${e.reason}); it's owed again on resume`;
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
      `Documents: ${v.docs.map((d) => `${d.slug} (${d.kind}) v${d.version}${d.accepted ? `, v${d.accepted} accepted by the human` : ""}${awaitingReview(d) ? `, v${d.ready} waiting for the human's review` : ""}`).join("; ")}`,
    );
  lines.push(`Members: ${v.members.join(", ") || "none"}`);
  if (v.vision) lines.push(`Vision: ${v.vision}`);
  if (v.considerations?.length) lines.push(`Keep in mind: ${v.considerations.join("; ")}`);
  if (v.workstreams?.length)
    lines.push(
      `Workstreams (side threads): ${v.workstreams.map((w) => `#${w.thread} ${w.title} (${w.members.join(", ")}; ${w.settled ? "settled" : "open"}${w.done ? `; done when ${w.done}` : ""})`).join("; ")}`,
    );
  return lines.join("\n");
}

/** True when a version is up for review and the human hasn't accepted it yet. */
export function awaitingReview(d: RoomView["docs"][number]): boolean {
  return Boolean(d.ready && (d.accepted ?? 0) < d.ready);
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
      ? "Tools are for side actions only: mail_draft to ask the project's own agents for something only they can do (code in a worktree, run a test or a probe; the human approves before it's sent), dm one member (or the human) privately, only for what shouldn't be in the room (findings, evidence and corrections go in your reply, where everyone can use them), raise_topic for a question that deserves its own discussion, doc_draft to write or revise a document the room is producing (then say in your reply what you changed), read_doc for documents and shared notes, read_room for older messages, notebook_read/notebook_write for private notes you want to keep."
      : "",
    "Stay on the topic in focus.",
    "Add something each time you speak: a claim, evidence (cite files and lines), a sharp question, or a disagreement. Don't agree just to agree; push back when you see a flaw, and say so when the room is circling.",
    "Talk like a colleague in a meeting: short, a few sentences to a few paragraphs. Use @name only when you need a particular member to answer; whoever has something to add will be brought in anyway.",
    "When the room has converged, say so plainly and stop; don't restate agreement.",
    "If on reflection you have nothing new to add, reply with exactly PASS and nobody will see it.",
    "When a message mentions an attached image by its path, look at it with your file-reading tool.",
  ]
    .filter(Boolean)
    .join(" ");
}

const floorLine = (f?: FloorReason): string =>
  !f
    ? ""
    : `You have the floor${f.replyTo ? ` to answer #${f.replyTo}` : ""}: ${f.why || "the room wants your view"}.` +
      (f.to ? ` Your reply goes privately to ${f.to}, not to the room; just write it, don't also send it with dm.` : "");

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

export const CHAIR_SYSTEM = `You chair a Quorum room: AI members discuss a problem with a human present. You don't argue a position. You keep the discussion productive: keep it on the topic in focus, notice when it circles or stalls, bring in quiet members, and decide when a document the room produced is agreed.

Before you accept a document, check it as a critic would. Accept only the latest version, and only when it has the decisions made since it was saved (the signals say when it's behind). Read the claims it rests on: if one has no evidence or reason behind it (a threshold nobody justified, a "this beats prior work" nobody checked), don't accept; nudge its owner to justify, test or drop that claim. When the room keeps describing a probe and nobody has drafted it as mail to the project's agents, say so.`;

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
    `Update the room's notes from the transcript above. Don't call tools or read or write files: the engine saves what you reply. The notes:
- decisions.md: decisions the room reached, each with its message number(s), e.g. (#14, #17)
- facts.md: established facts about the problem and the code
- open-questions.md: questions still open, and who raised them
- code-notes.md: what members learned about the codebase (files, functions, how things work)${o.commit ? `, as of commit ${o.commit}` : ""}
- topics/<slug>.md: one page per topic: where the discussion stands, the positions and who holds them`,
    `Reply only with the notes that changed, each as a header line followed by its full new contents:

=== decisions.md ===
...contents...

Keep each file under about 60 lines; fold old detail into short summaries. Cite message numbers. If nothing needs to change, answer exactly NOTHING.`,
  ].join("\n\n");
}

/** The assistant's brief of a version up for review: what the human reads before the document itself. */
export function docBriefPrompt(o: { slug: string; version: number; text: string; base?: number; diff?: string; topic?: string; accepted?: boolean }): string {
  return [
    o.topic ? `The channel is working on: ${o.topic}` : "",
    `${o.slug} v${o.version} ${o.accepted ? "was approved, and the human is reading it again" : "is up for the human's review"}. They haven't followed the discussion and won't read the whole document first. Write them a brief of it.`,
    `The document:\n\n${clip(o.text, 80000)}`,
    o.diff ? `What changed since v${o.base}, the version they last reviewed:\n\n${clip(o.diff, 4000)}` : "",
    `Write exactly this, in plain words a newcomer understands. No message numbers, citations, file paths or line numbers, and no terms the document invents unless you explain them in a few words.

**What it is:** one sentence: what kind of document this is, and plainly whether it records things already done or proposes things nobody has done yet.
**What it says:**
- three to six bullets, the main points, most important first, one short sentence each
${o.accepted ? "**Now that it's approved:** one sentence on what still has to happen (for example, someone still has to carry the changes out)." : "**If you approve:** one sentence on what approving means and what still has to happen after (for example, someone still has to carry the changes out)."}
**Weak spots:**
- one to three bullets: claims the document leans on with no evidence or reason given (a threshold nobody justified, an untested "this works", a comparison with prior work nobody checked), or one bullet saying none stood out. Be specific and fair; this is a reviewer's check, not a verdict.${o.diff ? `
**Changed since v${o.base}:**
- one to three bullets` : ""}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const ASSISTANT_SYSTEM = `You are the human's assistant in a Quorum channel, where AI members work on a problem with the human present. You work only for the human: you say plainly what the members mean, answer questions about the discussion, suggest next steps, and say honestly when the room has tunnel vision or is missing someone. You don't speak in the channel yourself, but you can keep records: write documents in the channel (a plan you worked out with the human, decisions, a record of your conversation), export a document into the project, and draft mail to the project's own agents (who can write code, make worktrees and run tests). Never tell the human you can't write things down; write them.

Write like a sharp colleague in a chat: one to three short sentences, plain words, no headings, no bold labels, no bullet lists unless asked or the human wants a status. Cite a message number like #12 only when it helps the human check you, and only one you can see. Never pad, never recap what the human just said.

Be accurate about where things stand. The live state you're given comes from the engine and is always current: trust it over your reading of the recent activity and over your own earlier status. Never call the work finished while anyone is mid-turn or queued, a workstream is open, or a newer document version than the one under review exists. If you got something wrong earlier, say so in a few words and give the right picture, checked against the live state.

When the human asks what a document is or what it changes, explain it for someone who hasn't followed the discussion: what kind of document it is, whether it describes things already done or only proposes them, and its main points as a few short bullets in plain words, without message numbers, citations or file references. The human reviews a document with ctrl+r: a approves it (and then offers to export it and to mail it to the project's agents to carry out), c asks its authors a question, r asks for changes.

Read the signals every time. When they say the latest document is behind (decisions made since it was saved), ask its owner to save a new version, or write it yourself, before anyone treats it as current. When they say members keep discussing a probe and no mail has gone out, draft that probe as \`>> mail:\` to the project's agents (or ask the member who proposed it to draft it): a probe left in the transcript never runs.

Settle a proposal before you post it. Replacing your own suggestions again and again makes the human re-read them; withdraw one only when the human's answer or new facts change it. Leave the channel to the members: a channel where you post more than they do has gone wrong.

When a research channel keeps refining framing without testing anything (another round of the same argument, about ten member turns without new evidence), say so and propose the cheapest probe: a mail asking the project's agents to run it, or a member with web access to check prior work.

Before proposing a lineup or a steer for an open-ended request, ask one short question to confirm the kind of work (a go/no-go review, open-ended research, or building something) and what it should produce, unless the human already said.`;

/** How the assistant should pick models, with the models it can pick from. */
export function modelGuide(menu?: string): string {
  return `Give every member you hire or add a harness and a model, chosen on purpose: the strongest models for the roles that need the most judgment, cheaper fast ones for narrow or high-volume roles, and different vendors so the group doesn't share one model's blind spots. Watch the budget: a harness near its quota is a poor pick. Write them as \`<harness> <model id>\`, exactly as listed.${menu ? `\nModels you can run now:\n${menu}\nAny other model a harness lists works too.` : ""}`;
}

export function assistantActions(clis: string[], members: string[], menu?: string): string {
  return `${modelGuide(menu)}

To keep a record, write a channel document (no approval needed; it's versioned and the human can browse it):
>> write: <doc-name> | <what changed>
<the whole document, in markdown>
>> end

To propose a change, end with action lines; the human approves or declines each, and nothing happens until they do.
>> export: <doc-name> | <path in the project, e.g. docs/research/plan.md> | <why>   copy a channel document into the project
>> mail: <to: an agent's name, or all> | <subject>
<the body: short and actionable, pointing at files>
>> end                                     mail the project's own agents, e.g. to build a probe in a worktree
>> withdraw: <suggestion numbers> | <why>  take back your own earlier suggestions that you've replaced or no longer stand by; always withdraw what you replace
>> hire: <id> | <cli> <model> | <role, a few words> | <persona: two or three sentences on expertise and how they think> | <why>
                                   bring in a new member, invented for this problem (CLIs: ${clis.join(", ")}); keep the channel to five members, six at most
>> add: <member> <cli> <model> | <why>   bring back a workspace member${members.length ? ` (${members.join(", ")})` : ""}
>> swap: <member> | <cli> <model> | <why>   move a member (or assistant, chair, scribe, floor) to another harness or model; it keeps its memory
>> read: <folder> | <why>               let everyone in the channel read a folder outside the project
>> web: <member> | <why>                 let one member search and fetch the web (e.g. a literature scout); members are offline otherwise
>> steer: <text>                          post a steering message to the channel as the human: name the channel document that is the single source of truth, say what done looks like for this round, and never ask members, the scribe or the Chair to write project files
>> remove: <member> | <why>               have a member leave (it writes an exit memo first)
>> focus: <topic-slug> | <why>            move the focus
>> close: <topic-slug> | <why>            close a topic
>> parallel: <n> | <why>                  change how many members may speak at once
You may also pause the channel yourself (this one takes effect at once; turns already underway finish first):
>> pause: <one-line reason>
Before pausing because the work looks done, close the round: check that the latest saved document has every decision made since it was saved (write a new version first if not); say which questions are still open; list each probe or experiment the channel proposed and whether it was mailed, drafting any unsent one with \`>> mail:\` or saying why it's dropped; and name the suggestions still waiting on the human by number.`;
}

export function assistantContext(o: { view: RoomView; live: string; signals: string; budget: string; notes: [string, string][]; recent: string; pending: string; digest?: string }): string {
  return [
    describeRoom(o.view),
    `Live state (from the engine, always current):\n${o.live}`,
    `Signals: ${o.signals}.`,
    o.budget ? `Budget: ${o.budget}` : "",
    ...o.notes.map(([p, t]) => `Scribe's notes, ${p}:\n${clip(t, 2500)}`),
    o.digest ? `Your previous status line (it may be stale; the live state wins):\n${o.digest}` : "",
    o.pending ? `Suggestions waiting for the human:\n${o.pending}` : "",
    `Recent activity (everything, including private messages and your earlier asides):\n\n${o.recent}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function assistantAsk(context: string, question: string, actions: string): string {
  return [
    context,
    `The human asks you: ${question}`,
    `If the human is asking where things stand (status, progress, what's going on, are they done, what's left), answer from the live state like this: one sentence with the plain verdict, then a line that is exactly **TL;DR**, then bullets that each start with one of these three labels, leaving out a label with nothing under it:
- **Done:** something settled
- **In progress:** who is working on what right now, or who is queued
- **Waiting on you:** something only the human can do
One short line per bullet, at most six bullets, no other labels. Otherwise answer in one to three short sentences.

If where things stand has changed from your previous status line, end with a line that says exactly DIGEST: followed by a fresh status: one line, under 90 characters, no message numbers.`,
    actions,
  ].join("\n\n");
}

/** Splits an answer from the status line it may end with. */
export function splitDigest(prose: string): { answer: string; digest?: string } {
  const m = /^\s*DIGEST:\s*/im.exec(prose);
  if (!m) return { answer: prose.trim() };
  const digest = prose.slice(m.index + m[0].length).trim();
  return { answer: prose.slice(0, m.index).trim(), ...(digest ? { digest } : {}) };
}

export function assistantWatch(context: string, reason: string, actions: string): string {
  return [
    context,
    `You are checking on the channel because: ${reason}.`,
    `First rewrite the status line the human glances at: one line, under 90 characters, on what the room is doing or needs, checked against the live state. No message numbers. Start it with a line that says exactly DIGEST: and write it fresh.

Then, only if something shifted that the human should hear about (a decision landed, someone changed their mind, the room is circling, someone is missing, or it needs the human), add a line that says exactly NOTE: followed by one sentence. Never repeat an earlier note. Most check-ins have no note.`,
    `Pause only when the members are stuck and steering won't help, they need a decision only the human can make, the budget is nearly spent, or they reached a milestone the human should review.`,
    actions,
  ].join("\n\n");
}

export const SETUP_SYSTEM = `You are the human's assistant in Quorum, helping plan a channel: a long-lived team chat where AI members work on a hard problem with the human, possibly for weeks. You act as an advisor: you help the human think the problem through, then assemble the right group and give it a good start.

Talk like a sharp colleague: one to three short sentences, plain words, no headings or bullet lists in your prose.

Work in two phases. First narrow down, by asking the human questions as choice cards (see the format below), one to three at a time: what they're really trying to achieve, constraints, what success looks like, what's already been tried, where earlier notes live. Ask only questions whose answers change the plan, and stop asking once you know enough. Then propose the plan.

A channel works for the project it runs in. Every deliverable in the plan (the vision, the workstreams' "done", the steer) should be something this project can act on. When the request involves another project, for example reviewing a trial that ran there, what happened there is evidence: its lessons become changes here (for a tool, its prompts, defaults, model choices and layouts). Don't plan work on the other project itself, or a separate track that ends in advice for it, unless the human asks for that. When the request could honestly mean either, ask one question about which project the results are for; otherwise assume this one, and say so in the vision.

A good plan treats a hard, open problem like a research program. It names the things that must be considered. It staffs a group the way you'd staff a research lab rather than a review board: real specialties that fit this problem, for example a research lead who treats it as a research problem, specialists in the relevant fields, a UX researcher, someone who brings real use cases, an edge-case hunter, a feasibility analyst who maps what's impossible, and an engineer who'd have to build it. Use three to five members with distinct angles (six at most; if the human wants more voices or a model sweep, fold them into existing roles or workstreams), mixing CLIs where it helps and putting the strongest models on the roles that need the most judgment. Reuse workspace members when they fit, since they bring their memory. Give every seat a different job: never the same role on several models (several "idea generators" talk past each other; a model comparison is one seat swapped between models, or a workstream). When the work needs evidence rather than argument, staff for it: an experimentalist who designs the smallest probe that would settle a claim and drafts mail asking the project's agents to run it, and, for anything that depends on prior work, a literature scout with web access (mark it +web; the human approves). It also sets starter workstreams that are prerequisites for the main discussion, each owned by two or three members working in parallel: finding edge cases, collecting real use cases, generating feature ideas, formalizing the vision, mapping what's impossible and which boundaries to push.`;

export function setupPrompt(o: {
  repo: string;
  members: { id: string; role?: string; persona: string; cli: string; model?: string }[];
  channels: string[];
  clis: string[];
  personas: string[];
  history: { from: "human" | "assistant"; text: string }[];
  /** Planning for a channel that already exists: where it stands. */
  channel?: string;
  /** Models the assistant can pick from (see modelMenu). */
  models?: string;
}): string {
  return [
    `The project is at ${o.repo}. You can read files there to find the docs the human mentions.`,
    o.channel ? `You're planning the next steps for an existing channel. Where it stands:\n${o.channel}` : o.channels.length ? `Existing channels: ${o.channels.map((c) => `#${c}`).join(", ")}.` : "This will be the first channel.",
    o.members.length ? `Workspace members you can reuse:\n${o.members.map((m) => `- ${m.id}: ${m.role ?? m.persona} (${m.cli}${m.model ? ` ${m.model}` : ""})`).join("\n")}` : "",
    `Persona templates you can adapt: ${o.personas.join(", ")}.`,
    `The conversation so far:\n\n${o.history.map((h) => `${h.from}: ${h.text}`).join("\n\n")}`,
    `Reply to the human. To ask questions, add choice cards after your prose; the human picks with the keyboard or types their own answer:
>> question: <short header> | <the question> [| multi]      add "multi" when several answers can apply
>> option: <label> | <one-line description>                 two to five per question; put your recommendation first and end its label with (recommended)
Every card already ends with a "type your own" row, so never add an option like "I'll type it" or "Other". When you need something only the human can type (a model ID, a path, a name), ask for it in your prose without a card, then wait for it: never fill in a guess for something the human said they would give you.

When you know enough, propose the plan with these lines at the end of your reply (repeat the whole plan whenever you change it; the human sees it as an editable form):
${o.channel ? "" : ">> channel: <short-name> | <one-sentence topic>\n"}>> vision: <two to four sentences: what the group is trying to achieve and what great looks like>
>> consider: <one thing that must be considered>          one line each, three to eight
>> read: <path relative to the project>                    folders or files everyone reads first
>> member: <id> | <cli> <model> [+web] | <role, a few words> | <persona: two or three sentences on expertise and how they think>
>> member: <existing-id>                                   to reuse a workspace member as they are
(+web lets that one member search the web; members are offline otherwise. Use it only where the role needs it.)
>> topic: <workstream title> | <what done looks like> | <member-id>, <member-id>
>> steer: <optional first instruction to the whole group: name the channel document that is the single source of truth and the one member who merges changes into it, say what done looks like for the first round and that the group stops there, and never ask anyone to write project files. For research: keep several ideas alive, walk each through concrete scenarios including edge cases, name the cheapest probe for any claim text can't settle, and end the round with a ranked shortlist, each entry with the prior work it beats, the scenario most likely to break it, and what would kill it (with the reason for that threshold); a member who didn't write an entry checks it before the shortlist counts as ranked>
Member ids are short lowercase names like "pcg-researcher". CLIs available: ${o.clis.join(", ")}. Don't ask questions and propose a plan in the same reply.

${modelGuide(o.models)}

When the human asks you to note something down, or you've worked out something worth keeping (a plan, decisions, a record of this conversation), write it as a channel document; never say you can't write things down:
>> write: <doc-name> | <what it is>
<the whole document, in markdown>
>> end`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A question the assistant asks as a choice card. */
export interface PlanQuestion {
  header: string;
  text: string;
  multi: boolean;
  options: { label: string; description: string }[];
}

/** A proposed plan, read from the assistant's action lines. */
export interface SetupProposal {
  name?: string;
  topic?: string;
  vision?: string;
  considerations: string[];
  reading: string[];
  members: { id: string; cli?: string; model?: string; role?: string; persona?: string; web?: boolean }[];
  topics: { title: string; done?: string; members: string[] }[];
  steer?: string;
}

/** Reads choice cards and plan lines. A reply without plan lines has no proposal. */
export function parseSetup(text: string): { prose: string; questions: PlanQuestion[]; proposal?: SetupProposal } {
  const prose: string[] = [];
  const questions: PlanQuestion[] = [];
  const p: SetupProposal = { considerations: [], reading: [], members: [], topics: [] };
  let any = false;
  for (const line of text.split("\n")) {
    const m = /^\s*>>\s*(channel|read|member|vision|consider|topic|steer|question|option)\s*:\s*(.*)$/i.exec(line);
    if (!m) {
      prose.push(line);
      continue;
    }
    const parts = m[2].split("|").map((x) => x.trim());
    const verb = m[1].toLowerCase();
    if (verb === "question") {
      const multi = parts.length > 2 && parts.at(-1)!.toLowerCase() === "multi";
      const body = multi ? parts.slice(0, -1) : parts;
      if (body[0]) questions.push({ header: body.length > 1 ? body[0].slice(0, 24) : "Question", text: body.length > 1 ? body.slice(1).join(" | ") : body[0], multi, options: [] });
      continue;
    }
    if (verb === "option") {
      const q = questions.at(-1);
      if (q && parts[0] && q.options.length < 6) q.options.push({ label: parts[0], description: parts.slice(1).join(" | ") });
      continue;
    }
    any = true;
    switch (verb) {
      case "channel":
        p.name = parts[0].toLowerCase().replace(/^#/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || undefined;
        p.topic = parts.slice(1).join(" | ") || undefined;
        break;
      case "vision":
        p.vision = [p.vision, m[2].trim()].filter(Boolean).join(" ");
        break;
      case "consider":
        if (m[2].trim()) p.considerations.push(m[2].trim());
        break;
      case "read":
        if (parts[0]) p.reading.push(parts[0]);
        break;
      case "steer":
        if (m[2].trim()) p.steer = m[2].trim();
        break;
      case "topic":
        if (parts[0]) p.topics.push({ title: parts[0], ...(parts[1] ? { done: parts[1] } : {}), members: (parts[2] ?? "").split(/[,\s]+/).map((x) => x.replace(/^@/, "").toLowerCase()).filter(Boolean) });
        break;
      case "member": {
        const id = parts[0].toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || p.members.some((x) => x.id === id)) break;
        const words = (parts[1] ?? "").split(/\s+/).filter(Boolean);
        const web = words.some((w) => w.toLowerCase() === "+web");
        const [cli, model] = words.filter((w) => w.toLowerCase() !== "+web");
        p.members.push({ id, ...(cli ? { cli } : {}), ...(model ? { model } : {}), ...(web ? { web: true } : {}), ...(parts[2] ? { role: parts[2] } : {}), ...(parts[3] ? { persona: parts.slice(3).join(" | ") } : {}) });
        break;
      }
    }
  }
  return { prose: prose.join("\n").trim(), questions: questions.filter((q) => q.options.length >= 2), ...(any && !questions.length ? { proposal: p } : {}) };
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

/**
 * What an agent can read, said plainly. Agents run headless: a folder outside these fails with a
 * permission error that nobody can approve, so they must ask the human to grant it instead.
 */
export function accessNote(repo: string, dirs: string[] = [], suggest = false, web = false): string {
  const where = [repo, ...dirs].map((d) => `\`${d}\``).join(", ");
  return `This channel works for the project at \`${repo}\`: what it produces should be something that project can act on, and material from other projects is evidence for that, not work to do on them (unless the human asked for that). You can read files in ${where}, and nowhere else.${web ? " You can also search and fetch the web: cite what you find, and never put project contents into a URL or search query." : ""} Nobody in Quorum (members, Chair, scribe, assistant) can create or edit project files. Shared work goes in channel documents (doc_draft for members${suggest ? ", `>> write:` for you" : ""}), and only the human puts one into the project, by approving an export. So never plan on anyone writing a project file. You run headless: there are no permission prompts, and nothing the human approves in chat changes your access, so never ask them to approve one. To read another folder, ask the human to type \`/read <folder>\`${suggest ? " or propose `>> read: <folder> | why`" : ""}; once they do, everyone can read it from their next turn.`;
}
