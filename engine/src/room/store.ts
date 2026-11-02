import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSpec, CliName } from "../config.js";
import { appendJsonl, readJsonl, type Sitting, type UsageRow } from "./ledger.js";

/** Who a message is for: everyone in the room, or one agent (a DM). */
export type Recipient = "room" | string;

/** What a proposed change does; the human approves or declines each one. */
export type SuggestionAction = "steer" | "add" | "hire" | "swap" | "remove" | "focus" | "close" | "parallel" | "export" | "mail" | "pointer" | "read" | "web";

export type DocKind = "plan" | "issue" | "decision" | "other";

/** What the log records. Everything else in a room (inboxes, digests, docs) is derived from these. */
export type RoomEventBody =
  /** `thread` is the seq of the message a side conversation hangs off; a message whose thread is its own seq starts one. */
  | { type: "message"; from: string; to: Recipient; text: string; replyTo?: number; topic?: string; thread?: number }
  | { type: "pass"; from: string }
  | { type: "turn.failed"; agent: string; message: string }
  /** A turn cut off before it finished (the room paused, or the member left); it's owed again on resume. */
  | { type: "turn.aborted"; agent: string; reason: string; replyTo?: number; thread?: number }
  | { type: "paused"; reason: string }
  | { type: "resumed" }
  /** The human's private conversation with the assistant, and the assistant's own notes. Members never see these. */
  | { type: "aside"; from: "human" | "assistant"; text: string; kind?: "answer" | "note" | "digest" }
  /** Who the floor gave the next turn to, and why. Members never see it. */
  | { type: "floor"; picks: { agent: string; why: string; replyTo?: number; thread?: number }[] }
  /** What each message did to the discussion, as the floor read it; feeds the stats panel. Members never see it. */
  | { type: "tags"; items: MessageTag[] }
  /** Gists written afterwards for messages tagged before highlights existed (each item: seq, from, kind, gist). */
  | { type: "gists"; items: MessageTag[] }
  /** A starter workstream: a side thread owned by a few members, with what done looks like. */
  | { type: "workstream"; thread: number; title: string; done?: string; members: string[] }
  /** The outcome of a side conversation, posted back to the channel when it settles. */
  | { type: "thread.summary"; thread: number; text: string }
  /** Something only the human may approve. `from` is the assistant, the Chair, or a member. */
  | { type: "suggestion"; id: number; from: string; action: SuggestionAction; args: string[]; why: string }
  /** `withdrawn`: whoever suggested it took it back. `args`: what the human changed it to before approving. */
  | { type: "suggestion.resolved"; id: number; accepted: boolean; withdrawn?: boolean; args?: string[] }
  /** Mail sent to the project's agents; `path` is the file relative to the repo (older rooms: in .quorum/mail/). */
  | { type: "mail.out"; file: string; to: string; subject: string; by: string; thread?: number; path?: string }
  | { type: "topic.raised"; slug: string; title: string; by: string; why?: string }
  | { type: "topic.focus"; slug: string; by: string }
  | { type: "topic.closed"; slug: string; by: string; why?: string }
  | { type: "doc.revised"; slug: string; version: number; kind: DocKind; by: string; note?: string }
  | { type: "doc.accepted"; slug: string; version: number; by: string }
  /** The Chair (or a finished revision) put a version up for the human's review; only the human accepts. */
  | { type: "doc.ready"; slug: string; version: number; by: string }
  /** The human's feedback on a version under review: a question for its authors, or changes to make. */
  | { type: "doc.reviewed"; slug: string; version: number; action: "clarify" | "revise"; section?: string; text: string }
  /** A channel document copied into the project. */
  | { type: "doc.exported"; slug: string; version: number; path: string }
  /** The assistant's plain-English brief of a version up for review, for a human who hasn't followed the room. */
  | { type: "doc.brief"; slug: string; version: number; text: string }
  /** A workstream the human closed, e.g. by approving the document it fed into. */
  | { type: "workstream.closed"; thread: number; by: string }
  | { type: "docs.updated"; files: string[]; by: string }
  | { type: "agent.joined"; agent: string; persona: string; cli: CliName; model?: string }
  | { type: "agent.left"; agent: string; memo?: string }
  /** A member (or support role) moved to another harness or model; its memory stays, its vendor session doesn't. */
  /** A member allowed (or no longer allowed) to search and fetch the web. */
  | { type: "agent.web"; agent: string; on: boolean; by: string }
  | { type: "agent.swapped"; agent: string; cli: CliName; model?: string; was: { cli: CliName; model?: string } }
  | { type: "access.granted"; path: string; by: string }
  /**
   * A budget or vendor limit. "hold": members whose CLI or model hit a limit sit out (until `until`,
   * or until someone switches their model); "release": they're back.
   */
  | { type: "budget"; level: "warn" | "stop" | "hold" | "release"; cli: string; detail: string; members?: string[]; until?: string };

export type TagKind = "idea" | "critique" | "agreement" | "concession" | "question" | "evidence" | "decision";
export const TAG_KINDS: TagKind[] = ["idea", "critique", "agreement", "concession", "question", "evidence", "decision"];

export interface MessageTag {
  seq: number;
  from: string;
  kind: TagKind;
  /** A few words, for the recent-events list. */
  headline: string;
  /** Whom a critique challenges, or whose point a concession accepts. */
  against?: string;
  topic?: string;
  thread?: number;
  /**
   * For the few messages that change the discussion (a breaking flaw, new evidence, a new approach,
   * a settled question): what the member did, in plain words, without their name, e.g. "found that
   * shrinking the map silently deletes content". The human's highlights list reads these.
   */
  gist?: string;
}

export type RoomEvent = RoomEventBody & { seq: number; ts: string };
export type MessageEvent = Extract<RoomEvent, { type: "message" }>;

/** The CLI and model a support role (assistant, Chair, scribe) runs on. */
export interface SupportSpec {
  cli: CliName;
  model?: string;
}

export interface RoomConfig {
  id: string;
  /** Short channel name, e.g. "terrain-semantics". Rooms saved before channels had none. */
  name?: string;
  topic: string;
  /** Files and folders (relative to the repo) every member reads before speaking. */
  reading?: string[];
  /** Folders outside the repo the human let everyone in the channel read (absolute paths). */
  dirs?: string[];
  /** Members picked together think without seeing each other's answers, then revise. */
  independent?: boolean;
  /** What the group is trying to achieve, pinned for every member. */
  vision?: string;
  /** Things that must be considered, pinned for every member. */
  considerations?: string[];
  /** Current members. Members who left are kept in `left` so they can be brought back. */
  agents: AgentSpec[];
  left?: AgentSpec[];
  /** `floor` decides who speaks next; rooms saved before it existed fall back to the scribe's model. */
  support: { assistant: SupportSpec; chair: SupportSpec; scribe: SupportSpec; floor?: SupportSpec };
  /** Most agents running a turn at once. */
  parallel: number;
  /** Turns per resume for each CLI that doesn't report its quota. */
  turnCap: number;
  /** Quota fraction at which the room warns, and at which it pauses. */
  quotaWarn: number;
  quotaStop: number;
}

export type RoomTuning = Pick<RoomConfig, "parallel" | "turnCap" | "quotaWarn" | "quotaStop"> & Pick<RoomConfig, "independent">;

/** Per-agent state that must survive a restart. */
/** Tokens a member used in a channel, and their cost in USD when its model is paid per token. */
export interface Spend {
  input: number;
  output: number;
  usd?: number;
}

export interface AgentState {
  /** Vendor CLI session to resume, when the transport reported one. */
  sessionId?: string;
  /** Turns taken on the current vendor session; past a limit the session is dropped and rebuilt. */
  sessionTurns?: number;
  /** When this member last went through the channel's reading list (ms since epoch). */
  readAt?: number;
  /** The reading list as it stood then, so newly added entries count as unread. */
  readList?: string[];
  /** What the human set up for a member joining: used on its first turn, then dropped. */
  onboarding?: Onboarding;
  /** Highest event seq this agent has been shown. */
  lastRead: number;
  turns: number;
}

export interface Onboarding {
  /** A catch-up brief written for this member. */
  brief?: string;
  /** What it reads first, instead of the channel's reading list. */
  reading?: string[];
  /** The human's first question for it. */
  question?: string;
}

/** Shared docs the scribe may write, relative to `docs/`. */
export const DOC_FILES = ["decisions.md", "facts.md", "open-questions.md", "code-notes.md"] as const;
const DOC_PATH = /^(decisions|facts|open-questions|code-notes)\.md$|^topics\/[a-z0-9][a-z0-9-]{0,47}\.md$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";

/**
 * Plain-file room store under `<repo>/.quorum/rooms/<id>/`. `events.jsonl` is append-only and the
 * source of truth; `agents/<id>.json` holds what each agent needs to pick up where it left off.
 * `docs/` is the scribe's shared memory, `outputs/` the documents the room produces, and
 * `notebooks/` each member's private notes.
 */
export class RoomStore {
  readonly dir: string;
  private log: RoomEvent[];

  private constructor(
    readonly root: string,
    readonly id: string,
  ) {
    this.dir = join(root, ".quorum", "rooms", id);
    try {
      this.log = readFileSync(join(this.dir, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      this.log = [];
    }
  }

  static create(root: string, config: Omit<RoomConfig, "id">, now = new Date()): RoomStore {
    const stamp = `${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}-room`;
    let id = stamp;
    for (let n = 2; existsSync(join(root, ".quorum", "rooms", id)); n++) id = `${stamp}-${n}`;
    const dir = join(root, ".quorum", "rooms", id);
    for (const sub of ["agents", "docs/topics", "outputs"]) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, "room.json"), JSON.stringify({ id, ...config }, null, 2));
    return new RoomStore(root, id);
  }

  static open(root: string, id: string): RoomStore {
    if (!existsSync(join(root, ".quorum", "rooms", id, "room.json"))) throw new Error(`no room "${id}"`);
    return new RoomStore(root, id);
  }

  /** Saved rooms under `root`, newest first. */
  static list(root: string): { id: string; name: string; topic: string; events: number; updated: string; digest: string }[] {
    let ids: string[];
    try {
      ids = readdirSync(join(root, ".quorum", "rooms")).sort().reverse();
    } catch {
      return [];
    }
    return ids.flatMap((id) => {
      try {
        const s = RoomStore.open(root, id);
        const c = s.config();
        const digest = [...s.log].reverse().find((e) => e.type === "aside" && e.kind === "digest");
        return [{ id, name: c.name ?? "", topic: c.topic, events: s.lastSeq, updated: s.log.at(-1)?.ts ?? "", digest: digest?.type === "aside" ? digest.text : "" }];
      } catch {
        return [];
      }
    });
  }

  config(): RoomConfig {
    return JSON.parse(readFileSync(join(this.dir, "room.json"), "utf8"));
  }

  private saveConfig(c: RoomConfig): RoomConfig {
    writeFileSync(join(this.dir, "room.json"), JSON.stringify(c, null, 2));
    return c;
  }

  updateConfig(patch: Partial<RoomTuning>): RoomConfig {
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return this.saveConfig({ ...this.config(), ...set });
  }

  setTopic(topic: string): RoomConfig {
    return this.saveConfig({ ...this.config(), topic });
  }

  setPlan(vision: string | undefined, considerations: string[]): RoomConfig {
    return this.saveConfig({ ...this.config(), ...(vision ? { vision } : {}), considerations });
  }

  setReading(reading: string[]): RoomConfig {
    return this.saveConfig({ ...this.config(), reading });
  }

  setDirs(dirs: string[]): RoomConfig {
    return this.saveConfig({ ...this.config(), dirs });
  }

  setSupport(role: keyof RoomConfig["support"], spec: SupportSpec): RoomConfig {
    const c = this.config();
    return this.saveConfig({ ...c, support: { ...c.support, [role]: spec } });
  }

  /** Every state file an agent has: its main conversation and each side thread (`id@t<seq>`). */
  agentStateKeys(id: string): string[] {
    try {
      return readdirSync(join(this.dir, "agents"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .filter((k) => k === id || k.startsWith(`${id}@`));
    } catch {
      return [];
    }
  }

  setRoster(agents: AgentSpec[], left: AgentSpec[]): RoomConfig {
    return this.saveConfig({ ...this.config(), agents, left });
  }

  append(body: RoomEventBody): RoomEvent {
    const e = { ...body, seq: this.lastSeq + 1, ts: new Date().toISOString() } as RoomEvent;
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(e) + "\n");
    this.log.push(e);
    return e;
  }

  /** The whole log, oldest first. Callers must not mutate it. */
  events(): readonly RoomEvent[] {
    return this.log;
  }

  get lastSeq(): number {
    return this.log.at(-1)?.seq ?? 0;
  }

  agentState(id: string): AgentState {
    try {
      return JSON.parse(readFileSync(join(this.dir, "agents", `${id}.json`), "utf8"));
    } catch {
      return { lastRead: 0, turns: 0 };
    }
  }

  saveAgentState(id: string, s: AgentState): void {
    writeFileSync(join(this.dir, "agents", `${id}.json`), JSON.stringify(s, null, 2));
  }

  /** Running totals per member from before turns were recorded one by one; nothing adds to them now. */
  spend(): Record<string, Spend> {
    try {
      return JSON.parse(readFileSync(join(this.dir, "spend.json"), "utf8"));
    } catch {
      return {};
    }
  }

  /** Each turn's usage, one row per turn (see ledger.ts). */
  usageRows(): UsageRow[] {
    return readJsonl<UsageRow>(join(this.dir, "usage.jsonl"));
  }

  addUsage(row: UsageRow): void {
    appendJsonl(join(this.dir, "usage.jsonl"), row);
  }

  sittings(): Sitting[] {
    return readJsonl<Sitting>(join(this.dir, "sittings.jsonl"));
  }

  startSitting(s: Sitting): void {
    appendJsonl(join(this.dir, "sittings.jsonl"), s);
  }

  // ---- shared docs (scribe) ----

  static isDocPath(p: string): boolean {
    return DOC_PATH.test(p);
  }

  readDoc(path: string): string {
    if (!RoomStore.isDocPath(path)) throw new Error(`not a room doc: ${path}`);
    try {
      return readFileSync(join(this.dir, "docs", path), "utf8");
    } catch {
      return "";
    }
  }

  writeDoc(path: string, text: string): void {
    if (!RoomStore.isDocPath(path)) throw new Error(`not a room doc: ${path}`);
    mkdirSync(dirname(join(this.dir, "docs", path)), { recursive: true });
    writeFileSync(join(this.dir, "docs", path), text.trimEnd() + "\n");
  }

  /** Every shared doc that has content, as relative paths. */
  docPaths(): string[] {
    let topics: string[] = [];
    try {
      topics = readdirSync(join(this.dir, "docs", "topics")).map((f) => `topics/${f}`);
    } catch {}
    return [...DOC_FILES, ...topics].filter((p) => this.readDoc(p).trim());
  }

  /** Small sidecar state (e.g. the commit code notes were written at). */
  meta(): Record<string, string | number> {
    try {
      return JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8"));
    } catch {
      return {};
    }
  }

  setMeta(patch: Record<string, string | number>): void {
    writeFileSync(join(this.dir, "meta.json"), JSON.stringify({ ...this.meta(), ...patch }, null, 2));
  }

  // ---- outputs (documents the room produces) ----

  static isSlug(s: string): boolean {
    return SLUG.test(s);
  }

  outputVersions(slug: string): number {
    try {
      return readdirSync(join(this.dir, "outputs", slug)).filter((f) => /^v\d+\.md$/.test(f)).length;
    } catch {
      return 0;
    }
  }

  writeOutput(slug: string, text: string): number {
    if (!SLUG.test(slug)) throw new Error(`bad document name "${slug}"`);
    const v = this.outputVersions(slug) + 1;
    mkdirSync(join(this.dir, "outputs", slug), { recursive: true });
    writeFileSync(join(this.dir, "outputs", slug, `v${v}.md`), text.trimEnd() + "\n");
    return v;
  }

  /** Where a document version is saved on disk. */
  outputPath(slug: string, version: number): string {
    return join(this.dir, "outputs", slug, `v${version}.md`);
  }

  readOutput(slug: string, version?: number): string {
    const v = version ?? this.outputVersions(slug);
    if (!SLUG.test(slug) || v < 1) throw new Error(`no document "${slug}"`);
    try {
      return readFileSync(join(this.dir, "outputs", slug, `v${v}.md`), "utf8");
    } catch {
      throw new Error(`no version ${v} of "${slug}"`);
    }
  }

  markAccepted(slug: string, version: number): void {
    writeFileSync(join(this.dir, "outputs", slug, "accepted"), `${version}\n`);
  }

  // ---- notebooks (private per member, shared across the workspace's channels) ----

  private notebookPath(agent: string): string {
    return join(this.root, ".quorum", "members", `${agent}.md`);
  }

  notebook(agent: string): string {
    try {
      return readFileSync(this.notebookPath(agent), "utf8");
    } catch {
      // Rooms from before the workspace kept notebooks per room.
      try {
        return readFileSync(join(this.dir, "notebooks", `${agent}.md`), "utf8");
      } catch {
        return "";
      }
    }
  }

  writeNotebook(agent: string, text: string): void {
    mkdirSync(dirname(this.notebookPath(agent)), { recursive: true });
    writeFileSync(this.notebookPath(agent), text.trimEnd() + "\n");
  }
}

/** Whether a member may see an event: room messages, DMs to or from it, and room-level events. */
export function visibleTo(agent: string, e: RoomEvent): boolean {
  switch (e.type) {
    case "message":
      return e.to === "room" || e.to === agent || e.from === agent;
    case "aside":
    case "suggestion":
    case "suggestion.resolved":
    case "budget":
    case "floor":
    case "tags":
    case "gists":
    case "doc.brief":
      return false;
    default:
      return true;
  }
}
