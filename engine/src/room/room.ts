import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentSpec, CliName, Persona } from "../config.js";
import type { AgentEvent, AgentTransport, McpServerSpec } from "../transports/index.js";
import { parseBlocks, parseDirectives, parseFileBlocks, type Directive } from "./directives.js";
import { MAIL_POINTER, Mailbox, QUORUM } from "./mail.js";
import { BidFloor, mentioned, type FloorPick, type FloorPolicy } from "./floor.js";
import {
  ASSISTANT_SYSTEM,
  accessNote,
  assistantActions,
  assistantAsk,
  assistantContext,
  assistantWatch,
  CHAIR_SYSTEM,
  chairPrompt,
  EXIT_MEMO,
  memberFresh,
  memberIncremental,
  memberThread,
  describeRoom,
  splitDigest,
  parsePersonaDraft,
  parseWatch,
  personaDraftPrompt,
  PERSONA_SYSTEM,
  BRIEF_SYSTEM,
  briefPrompt,
  renderEvent,
  renderEvents,
  reviseIndependent,
  THREAD_SUMMARY,
  threadSummaryPrompt,
  SCRIBE_SYSTEM,
  scribePrompt,
  type FloorReason,
  type RoomView,
  type SetupProposal,
} from "./prompts.js";
import { computeSignals, describeSignals, looksStuck } from "./signals.js";
import {
  RoomStore,
  slugify,
  visibleTo,
  type AgentState,
  type DocKind,
  type MessageEvent,
  type MessageTag,
  type Recipient,
  type RoomConfig,
  type RoomEvent,
  type RoomEventBody,
  type RoomTuning,
  type Spend,
  type SuggestionAction,
  type SupportSpec,
} from "./store.js";
import { newToken, ToolServer, type ToolHandler } from "./tools.js";
import { noteVendorSession } from "./vendorlog.js";
import { personaFor, readingFiles, readingPath, Workspace } from "./workspace.js";

/** What a Room tells whoever drives it. `room.event` mirrors the log; the rest is live-only. */
export type RoomEmit =
  | { event: "room.event"; data: RoomEvent }
  | { event: "room.state"; data: { state: RoomState; reason?: string } }
  | { event: "room.turn.start"; data: { agent: string; thread?: number } }
  | { event: "room.turn.delta"; data: { agent: string; delta: string; thread?: number } }
  | { event: "room.turn.tool"; data: { agent: string; name: string; thread?: number } }
  | { event: "room.turn.end"; data: { agent: string; thread?: number } }
  /** A support role started or stopped working, so the human can see it isn't stuck. */
  | { event: "room.support"; data: { role: SupportRole | "watch"; busy: boolean } }
  | { event: "room.usage"; data: { agent: string; cli: string; quotaUtilization?: number; rateLimited?: boolean } }
  /** What a member has used in this channel so far, after each of its turns. */
  | { event: "room.spend"; data: { agent: string; cli: string; spend: Spend } };

/** paused: nobody is woken. running: turns underway. idle: running, but nobody has anything new to answer. */
export type RoomState = "paused" | "running" | "idle";

export type SupportRole = "assistant" | "chair" | "scribe" | "floor";
export const SUPPORT_ROLES: SupportRole[] = ["assistant", "chair", "scribe", "floor"];

/** Builds the transport for a member or support role. */
export type TransportFactory = (spec: { id: string; cli: CliName; model?: string }) => AgentTransport;

export interface RoomOptions {
  /** Target repo; the room is stored in its .quorum/ directory. */
  repo: string;
  transports: TransportFactory;
  assetsDir?: string;
  readOnly?: boolean;
  /** Current commit of the repo (code notes are tagged with it). Defaults to `git rev-parse`. */
  head?: () => string | undefined;
  /** Files an issue and returns its URL. Defaults to `gh issue create`. */
  fileIssue?: (title: string, body: string) => Promise<string>;
  /** Decides who speaks next. Defaults to relevance bidding on the room's floor model. */
  floor?: FloorPolicy;
  /** CLIs the assistant may propose for new members. */
  clis?: string[];
  /** Models the assistant can pick from, for its prompt (see catalog.modelMenu). */
  modelMenu?: () => string | undefined;
  /** USD per million tokens for a harness and model billed per token; undefined for subscriptions. */
  price?: (cli: string, model?: string) => { input: number; output: number } | undefined;
  /** The model a harness runs by default, filled into suggestions that don't name one (see models.defaultModel). */
  defaultModel?: (cli: string) => string | undefined;
}

export interface NewRoom extends RoomOptions, Partial<RoomTuning> {
  /** The opening question. An empty room starts without one; the human's first message becomes it. */
  topic?: string;
  agents?: AgentSpec[];
  /** Defaults to each role running on the first member's CLI. */
  support?: Partial<RoomConfig["support"]>;
  name?: string;
  reading?: string[];
  /** Folders outside the repo everyone may read. */
  dirs?: string[];
  /** Members who speak once when the channel opens (their first take), instead of waiting for the floor; true for all. */
  kickoff?: boolean | string[];
  vision?: string;
  considerations?: string[];
}

/** How many recent events a member without a live vendor session is shown. */
const RECENT = 40;
/** A reply that is exactly this means "nothing new to add"; nobody sees it. */
const PASS = "PASS";
/** Turns on one vendor session before it is dropped and the member's context rebuilt from files. */
const REFRESH = 12;
/** Unread events past which a member's vendor session is dropped and its context rebuilt instead. */
const CATCHUP = 60;
/** Member messages between runs of each support role. */
const EVERY = { scribe: 8, chair: 10, watch: 8 };

/** A turn in progress that may call the room tools. */
interface LiveTurn {
  agent: string;
  ctrl: AbortController;
  thread?: number;
}

/** A member the floor gave a turn to. */
interface Want extends FloorReason {
  agent: string;
}

/** Turns are per member and per conversation: a member can be wanted in the channel and in a thread at once. */
const turnKey = (agent: string, thread?: number) => (thread ? `${agent}#${thread}` : agent);
/** Each thread keeps its own vendor session and read position, so it doesn't fill the channel's context. */
const stateKey = (agent: string, thread?: number) => (thread ? `${agent}@t${thread}` : agent);

/** What each suggestion's arguments are, for the human's edits. A model may be left empty (the harness's default). */
export const SUGGESTION_FIELDS: Record<SuggestionAction, string[]> = {
  steer: ["text"],
  add: ["member", "harness", "model"],
  hire: ["name", "harness", "model", "role", "persona"],
  swap: ["member", "harness", "model"],
  remove: ["member"],
  focus: ["topic"],
  close: ["topic"],
  parallel: ["how many"],
  export: ["document", "path"],
  mail: ["to", "subject", "body"],
  pointer: ["file"],
  read: ["folder"],
};

/** The human's edit of a suggestion, checked: same fields, the required ones filled in. */
export function checkEdit(action: SuggestionAction, was: string[], edited: string[]): string[] {
  const fields = SUGGESTION_FIELDS[action];
  const args = [...was];
  edited.slice(0, fields.length).forEach((v, i) => (args[i] = String(v ?? "").trim()));
  fields.forEach((f, i) => {
    if (f !== "model" && !args[i]) throw new Error(`the ${action} needs its ${f}`);
  });
  if (action === "hire" && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(args[0])) throw new Error("a member's name is lowercase letters, digits and dashes");
  if (action === "parallel" && !(Number(args[0]) >= 1)) throw new Error("parallel needs a number, 1 or more");
  return args;
}
/**
 * A folder the human may let a channel read: it must exist and lie outside the repo (the repo is
 * readable already). A file grants the folder it's in; `~` is the home folder.
 */
export function grantableDir(path: string, repo: string): string {
  const raw = expandHome(path);
  if (!raw) throw new Error("say which folder");
  let dir = resolve(repo, raw);
  if (!existsSync(dir)) throw new Error(`there's no ${dir}`);
  if (!statSync(dir).isDirectory()) dir = dirname(dir);
  const rel = relative(resolve(repo), dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error(`${dir} is inside the project, which everyone can read already`);
  return dir;
}

const expandHome = (p: string) => p.trim().replace(/^~(?=$|\/)/, homedir());

/** Whether a path the human typed points outside the repo. */
function isOutside(path: string, repo: string): boolean {
  const rel = relative(resolve(repo), resolve(repo, expandHome(path)));
  return rel.startsWith("..") || isAbsolute(rel);
}

/** Messages in a side thread (including one that starts a thread) stay out of the main conversation. */
const inMain = (e: RoomEvent) => e.type !== "message" || e.thread === undefined;

/** Log events members aren't shown: bookkeeping that would only distract them. */
const MEMBER_NOISE = new Set<RoomEvent["type"]>(["pass", "docs.updated", "turn.failed", "paused", "resumed"]);

const DEFAULT_CLIS = ["claude", "codex", "gemini", "agy", "opencode", "kimi", "zcode"];

const CHAIR_VERBS = ["accept", "nudge", "raise", "focus", "close"] as const;
const ASSISTANT_VERBS = ["steer", "add", "hire", "swap", "remove", "focus", "close", "parallel", "pause", "export", "withdraw", "read"] as const;
/** Assistant actions that carry a multi-line body, closed by `>> end`. */
const ASSISTANT_BLOCKS = ["write", "mail"] as const;
/** How often a running room looks for mail from the project's agents. */
const MAIL_POLL_MS = 5000;

/**
 * A long-running discussion. Members are not processes: each is an identity with persisted state.
 * Nobody takes turns in order: after new messages the floor decides who has something to add
 * (whoever was addressed directly, plus whoever the floor policy picks), and those members speak,
 * several at once. A quiet room is normal. Pause, resume after a restart, and roster changes all
 * come down to the same question of whom to run next. Support roles run beside the members: the
 * floor picks speakers, the Chair moderates, the scribe keeps the shared notes, and the assistant
 * works for the human.
 */
export class Room {
  private readonly personas = new Map<string, Persona>();
  private readonly running = new Map<string, { agent: string; ctrl: AbortController; why: FloorReason }>();
  /** Turns the floor gave out that haven't started yet, by turn key. Saved, so a restart keeps them. */
  private readonly wants = new Map<string, Want>();
  private deciding = false;
  private floorDirty = false;
  private readonly floorPolicy: FloorPolicy;
  /** Members writing an exit memo; never woken. */
  private readonly leaving = new Set<string>();
  /** Turns that can call the room tools, keyed by their token. */
  private readonly live = new Map<string, LiveTurn>();
  private tools?: Promise<ToolServer>;
  private listeners: ((e: RoomEmit) => void)[] = [];
  private waiters: (() => void)[] = [];
  private turnsByCli = new Map<string, number>();
  /** Latest quota fraction each CLI reported; a CLI that reports one is limited by it instead of the turn cap. */
  private readonly quota = new Map<string, number>();
  private readonly warned = new Set<string>();
  private readonly busy = new Set<SupportRole | "watch">();
  private supportAbort = new AbortController();
  private mailTimer?: ReturnType<typeof setInterval>;
  /** Run once, the next time the room resumes. */
  private resumeHooks: (() => void)[] = [];
  private _state: RoomState = "paused";

  private constructor(
    readonly store: RoomStore,
    private readonly o: RoomOptions,
  ) {
    for (const a of store.config().agents) this.personas.set(a.id, personaFor(o.repo, a.persona, o.assetsDir));
    try {
      for (const [key, w] of JSON.parse(String(store.meta().wants ?? "[]")) as [string, Want][]) this.wants.set(key, { ...w, agent: w.agent ?? key });
    } catch {}
    this.floorPolicy = o.floor ?? new BidFloor((prompt, system, signal) => this.oneShot("floor", prompt, system, undefined, undefined, signal));
  }

  /** Creates a paused room; with a topic, it is the room's first message. Call resume() to start it. */
  static create(o: NewRoom): Room {
    const agents = o.agents ?? [];
    const topic = o.topic?.trim() ?? "";
    const first: SupportSpec = { cli: agents[0]?.cli ?? "mock" };
    const store = RoomStore.create(o.repo, {
      ...(o.name ? { name: o.name } : {}),
      ...(o.reading?.length ? { reading: o.reading } : {}),
      ...(o.dirs?.length ? { dirs: o.dirs } : {}),
      ...(o.independent ? { independent: true } : {}),
      ...(o.vision ? { vision: o.vision } : {}),
      ...(o.considerations?.length ? { considerations: o.considerations } : {}),
      topic,
      agents,
      left: [],
      support: { assistant: first, chair: first, scribe: first, floor: first, ...o.support },
      parallel: o.parallel ?? 2,
      turnCap: o.turnCap ?? 40,
      quotaWarn: o.quotaWarn ?? 0.75,
      quotaStop: o.quotaStop ?? 0.9,
    });
    if (topic) {
      openingTopic(store, topic);
      const first = store.append({ type: "message", from: "human", to: "room", text: topic });
      const kick = o.kickoff === true ? agents : agents.filter((a) => Array.isArray(o.kickoff) && o.kickoff.includes(a.id));
      if (o.kickoff) {
        const why = o.reading?.length ? "the channel just opened: read the reading list, then give your first take from your angle" : "the channel just opened: give your first take from your angle";
        store.setMeta({ floorSeq: first.seq, wants: JSON.stringify(kick.map((a) => [a.id, { agent: a.id, why, replyTo: first.seq }])) });
      }
    }
    return new Room(store, o);
  }

  /** Reopens a saved room, paused. Members pick up from their saved state on resume(). */
  static open(id: string, o: RoomOptions): Room {
    return new Room(RoomStore.open(o.repo, id), o);
  }

  get id(): string {
    return this.store.id;
  }

  get state(): RoomState {
    return this._state;
  }

  /** Members currently mid-turn (in the channel or a thread). */
  get speaking(): string[] {
    return [...new Set([...this.running.values()].map((t) => t.agent))];
  }

  on(listener: (e: RoomEmit) => void): () => void {
    this.listeners.push(listener);
    return () => (this.listeners = this.listeners.filter((l) => l !== listener));
  }

  private emit(e: RoomEmit): void {
    for (const l of this.listeners) l(e);
  }

  private log(body: RoomEventBody): RoomEvent {
    const e = this.store.append(body);
    this.emit({ event: "room.event", data: e });
    return e;
  }

  private setState(state: RoomState, reason?: string): void {
    if (state === this._state) return;
    this._state = state;
    this.emit({ event: "room.state", data: { state, ...(reason ? { reason } : {}) } });
  }

  // ---- derived state ----

  private members(): string[] {
    return [...this.personas.keys()];
  }

  focus(): string | undefined {
    for (const e of [...this.store.events()].reverse()) if (e.type === "topic.focus") return e.slug;
    return undefined;
  }

  topics(): RoomView["topics"] {
    const byslug = new Map<string, { slug: string; title: string; closed: boolean }>();
    for (const e of this.store.events()) {
      if (e.type === "topic.raised") byslug.set(e.slug, { slug: e.slug, title: e.title, closed: false });
      if (e.type === "topic.closed" && byslug.has(e.slug)) byslug.get(e.slug)!.closed = true;
    }
    return [...byslug.values()];
  }

  docs(): RoomView["docs"] {
    const out = new Map<string, RoomView["docs"][number]>();
    for (const e of this.store.events()) {
      if (e.type === "doc.revised") out.set(e.slug, { ...out.get(e.slug), slug: e.slug, version: e.version, kind: e.kind });
      if (e.type === "doc.accepted" && out.has(e.slug)) out.get(e.slug)!.accepted = e.version;
    }
    return [...out.values()];
  }

  view(): RoomView {
    const c = this.store.config();
    return {
      topic: c.topic,
      focus: this.focus(),
      topics: this.topics(),
      docs: this.docs(),
      members: this.members(),
      ...(c.vision ? { vision: c.vision } : {}),
      ...(c.considerations?.length ? { considerations: c.considerations } : {}),
      ...(this.workstreams().length ? { workstreams: this.workstreams() } : {}),
    };
  }

  /** Starter workstreams and whether each has settled. */
  workstreams(): NonNullable<RoomView["workstreams"]> {
    const settled = new Set(this.store.events().flatMap((e) => (e.type === "thread.summary" ? [e.thread] : [])));
    return this.store.events().flatMap((e) => (e.type === "workstream" ? [{ thread: e.thread, title: e.title, ...(e.done ? { done: e.done } : {}), members: e.members, settled: settled.has(e.thread) }] : []));
  }

  /** Starts a workstream: a side thread the named members own, with what done looks like. */
  workstream(title: string, done: string | undefined, owners: string[]): number {
    const members = owners.filter((m) => this.personas.has(m));
    if (!title.trim()) throw new Error("a workstream needs a title");
    const who = members.length ? ` ${members.map((m) => `@${m}`).join(" ")}, this one's yours.` : "";
    const e = this.post(`Workstream: ${title.trim()}.${done ? ` Done when: ${done}.` : ""}${who}`, "room", "new");
    this.log({ type: "workstream", thread: e.seq, title: title.trim(), ...(done ? { done } : {}), members });
    return e.seq;
  }

  /**
   * Applies a plan from the planning session to this channel: new members join with an onboarding
   * brief, the reading list grows, the vision and considerations are pinned (and said once in the
   * channel), workstreams start, and the steer is posted.
   */
  async applyPlan(p: SetupProposal): Promise<void> {
    const owned = new Set(p.topics.flatMap((t) => t.members));
    const ws = new Workspace(this.o.repo);
    for (const m of p.members) {
      if (this.personas.has(m.id)) continue;
      const known = ws.members().find((x) => x.id === m.id);
      const cli = (m.cli ?? known?.cli) as CliName | undefined;
      if (!cli) throw new Error(`${m.id} needs a CLI`);
      await this.join({ id: m.id, cli, model: m.model ?? (m.persona ? undefined : known?.model), role: m.role, persona: m.persona, brief: true, quiet: owned.has(m.id) });
    }
    if (p.reading.length) this.setReading([...(this.store.config().reading ?? []), ...p.reading]);
    if (p.vision || p.considerations.length) {
      this.store.setPlan(p.vision, p.considerations);
      const said = [p.vision, p.considerations.length ? `To keep in mind: ${p.considerations.join("; ")}.` : ""].filter(Boolean).join("\n\n");
      this.post(said);
    }
    for (const t of p.topics) this.workstream(t.title, t.done, t.members);
    if (p.steer) this.post(p.steer);
  }

  /** Suggestions the human hasn't answered yet. */
  pending(): Extract<RoomEvent, { type: "suggestion" }>[] {
    const done = new Set(this.store.events().flatMap((e) => (e.type === "suggestion.resolved" ? [e.id] : [])));
    // Older suggestions may name no model; they show (and, approved, pin) the harness's default.
    return this.store.events().flatMap((e) => (e.type === "suggestion" && !done.has(e.id) ? [{ ...e, args: this.withModel(e.action, e.args) }] : []));
  }

  /** A member's model is always spelled out, so the human sees what they approve and it stays put if the default changes. */
  private withModel(action: SuggestionAction, args: string[]): string[] {
    if (!(action === "hire" || action === "add" || action === "swap") || !args[1] || args[2]) return args;
    // Someone coming back on the same harness keeps the model they had.
    const before = action === "add" ? [...(this.store.config().left ?? []), ...new Workspace(this.o.repo).members()].find((m) => m.id === args[0] && m.cli === args[1]) : undefined;
    const model = before?.model ?? this.o.defaultModel?.(args[1]);
    return model ? [args[0], args[1], model, ...args.slice(3)] : args;
  }

  private memberMessagesAfter(seq: number): number {
    const who = new Set(this.members());
    return this.store.events().slice(seq).filter((e) => e.type === "message" && who.has(e.from)).length;
  }

  private signals() {
    return computeSignals(this.store.events(), this.members());
  }

  private spec(id: string): { id: string; cli: CliName; model?: string } {
    const c = this.store.config();
    if (id === "floor") return { id, ...(c.support.floor ?? c.support.scribe) };
    if ((SUPPORT_ROLES as string[]).includes(id)) return { id, ...c.support[id as Exclude<SupportRole, "floor">] };
    const a = [...c.agents, ...(c.left ?? [])].find((x) => x.id === id);
    if (!a) throw new Error(`unknown member "${id}"`);
    return { id, cli: a.cli, model: a.model };
  }

  // ---- control ----

  resume(): void {
    if (this._state !== "paused") return;
    this.turnsByCli = new Map();
    this.warned.clear();
    this.supportAbort = new AbortController();
    this.log({ type: "resumed" });
    this.setState("running");
    // Mail from the project's agents arrives while the channel is open.
    this.checkMail();
    this.mailTimer ??= setInterval(() => this.checkMail(), MAIL_POLL_MS);
    this.mailTimer.unref?.();
    for (const h of this.resumeHooks.splice(0)) h();
    this.floorCheck();
  }

  /** Runs `fn` once, when the room next resumes. */
  onResume(fn: () => void): void {
    this.resumeHooks.push(fn);
  }

  /** Where the channel stands, for planning its next steps. */
  brief(): string {
    const recent = this.store.events().filter((e) => e.type === "message" && e.to === "room" && inMain(e)).slice(-15);
    return [describeRoom(this.view()), this.digest() ? `The assistant's status: ${this.digest()}` : "", recent.length ? `Latest messages:\n\n${renderEvents(recent, this.focus())}` : ""]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Stops waking members and aborts turns underway; aborted turns are redone after resume(). */
  pause(reason = "paused by the human"): void {
    if (this._state === "paused") return;
    this.setState("paused", reason);
    this.log({ type: "paused", reason });
    for (const t of this.running.values()) t.ctrl.abort();
    this.supportAbort.abort();
    this.settle();
  }

  /** Retunes pacing and budgets; a higher parallel cap takes effect at once. */
  configure(patch: Partial<RoomTuning>): RoomTuning {
    for (const k of ["parallel", "turnCap"] as const) {
      const v = patch[k];
      if (v !== undefined && !(Number.isInteger(v) && v >= 1)) throw new Error(`${k} must be a whole number of at least 1`);
    }
    for (const k of ["quotaWarn", "quotaStop"] as const) {
      const v = patch[k];
      if (v !== undefined && !(v > 0 && v <= 1)) throw new Error(`${k} must be a fraction between 0 and 1`);
    }
    const { parallel, turnCap, quotaWarn, quotaStop, independent } = this.store.updateConfig(patch);
    this.kick();
    return { parallel, turnCap, quotaWarn, quotaStop, independent: Boolean(independent) };
  }

  /** Sets the channel's reading list; members are told about entries they haven't read on their next turn. */
  /**
   * `/read`: paths inside the repo become the reading list; folders outside it are granted to
   * everyone, since nobody could read them otherwise.
   */
  read(paths: string[]): { reading: string[]; dirs: string[] } {
    const outside = paths.filter((p) => isOutside(p, this.o.repo));
    const dirs = outside.map((p) => this.allowRead(p, "human"));
    const inside = paths.filter((p) => !outside.includes(p));
    return { reading: inside.length || !outside.length ? this.setReading(inside) : (this.store.config().reading ?? []), dirs };
  }

  setReading(paths: string[]): string[] {
    const clean = [...new Set(paths.map((p) => readingPath(this.o.repo, p)))];
    this.store.setReading(clean);
    return clean;
  }

  /**
   * The human speaks: to the whole channel, or privately to one member. `thread` posts into a side
   * thread (the seq it hangs off), or "new" starts one with this message, so a quick question doesn't
   * spend the main discussion's context. The first channel message sets the topic.
   */
  post(text: string, to: Recipient = "room", thread?: number | "new"): RoomEvent {
    if (!text.trim()) throw new Error("say something first");
    if (to !== "room" && !this.personas.has(to)) throw new Error(`unknown member "${to}"`);
    if (to !== "room" && thread) throw new Error("private messages can't go in a thread");
    let th: number | undefined;
    if (thread === "new") th = this.store.lastSeq + 1;
    else if (thread) {
      const root = this.store.events()[thread - 1];
      if (root?.type !== "message" || root.to !== "room" || (root.thread && root.thread !== root.seq)) throw new Error(`no message #${thread} to start a thread from`);
      th = thread;
    }
    if (to === "room" && !th && !this.store.config().topic) {
      this.store.setTopic(text.trim());
      for (const b of openingTopic(this.store, text.trim())) this.emit({ event: "room.event", data: b });
      if (thread === "new") th = this.store.lastSeq + 1;
    }
    const e = this.log({ type: "message", from: "human", to, text: text.trim(), ...(th ? { thread: th } : {}) });
    this.floorCheck();
    return e;
  }

  /** The messages of a side thread, oldest first, and the message it hangs off. */
  thread(seq: number): { root?: RoomEvent; messages: RoomEvent[] } {
    const root = this.store.events()[seq - 1];
    return { root, messages: this.store.events().filter((e) => e.type === "message" && e.thread === seq && e.seq !== seq) };
  }

  setFocus(slug: string, by = "human"): void {
    const t = this.topics().find((x) => x.slug === slug);
    if (!t) throw new Error(`no topic "${slug}"; topics are ${this.topics().map((x) => x.slug).join(", ")}`);
    if (t.closed) throw new Error(`topic "${slug}" is closed`);
    if (this.focus() === slug) return;
    this.log({ type: "topic.focus", slug, by });
    this.kick();
  }

  raiseTopic(title: string, by: string, why?: string): string {
    const clean = title.trim().slice(0, 80);
    if (!clean) throw new Error("a topic needs a title");
    const taken = new Set(this.topics().map((t) => t.slug));
    const base = slugify(clean.split(/\s+/).slice(0, 5).join(" "));
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    this.log({ type: "topic.raised", slug, title: clean, by, ...(why ? { why } : {}) });
    return slug;
  }

  closeTopic(slug: string, by = "human", why?: string): void {
    const t = this.topics().find((x) => x.slug === slug);
    if (!t) throw new Error(`no topic "${slug}"`);
    if (t.closed) return;
    this.log({ type: "topic.closed", slug, by, ...(why ? { why } : {}) });
    // With its focus closed the room needs a new direction; the Chair proposes one.
    if (this.focus() === slug) void this.runChair("the topic in focus was just closed; propose what the room should focus on next");
  }

  /**
   * Brings a member into this channel: a workspace member (by id, with its memory), a new one built
   * on a persona, or one who left. It gets the floor at once to catch up.
   */
  addMember(o: { persona: string; cli: CliName; model?: string; id?: string; why?: string; quiet?: boolean }): string {
    const c = this.store.config();
    const back = (c.left ?? []).find((a) => a.id === (o.id ?? o.persona));
    const model = (m?: string) => m ?? this.o.defaultModel?.(o.cli);
    if (back && !o.id && back.cli === o.cli && model(back.model) === model(o.model)) return this.rejoin(back.id);
    const ws = new Workspace(this.o.repo);
    const known = ws.members().find((m) => m.id === (o.id ?? o.persona));
    const personaKey = known?.persona ?? o.persona;
    const persona = personaFor(this.o.repo, personaKey, this.o.assetsDir);
    const taken = new Set([...c.agents, ...(c.left ?? [])].map((a) => a.id).concat(SUPPORT_ROLES, ["human", "room"]));
    let id = o.id ?? o.persona;
    if (o.id && taken.has(id)) throw new Error(`"${id}" is already in this channel`);
    for (let n = 2; taken.has(id); n++) id = `${o.persona}-${n}`;
    const spec: AgentSpec = { id, cli: o.cli, persona: personaKey, ...(o.model ? { model: o.model } : {}) };
    this.store.setRoster([...c.agents, spec], c.left ?? []);
    if (!ws.members().some((m) => m.id === id)) ws.saveMember({ ...spec, role: persona.role });
    this.personas.set(id, persona);
    this.log({ type: "agent.joined", agent: id, persona: personaKey, cli: o.cli, ...(o.model ? { model: o.model } : {}) });
    if (o.quiet) this.kick();
    else this.welcome(id, o.why);
    return id;
  }

  /**
   * Onboards a member chosen in the add-member modal: a new one (with its persona, which joins the
   * workspace) or a workspace member, on the CLI and model picked. A catch-up brief written for its
   * role, its own reading list and the human's first question shape its first turn. Answering an
   * assistant suggestion this way counts as approving it.
   */
  async join(o: {
    id: string;
    cli: CliName;
    model?: string;
    role?: string;
    persona?: string;
    brief?: boolean;
    reading?: string[];
    question?: string;
    suggestion?: number;
    /** Join without taking the floor (it has a workstream to start on instead). */
    quiet?: boolean;
  }): Promise<string> {
    const id = o.id.trim().toLowerCase();
    // A channel only runs on the CLIs it was opened with (a mock channel never reaches a real CLI).
    if (this.o.clis && !this.o.clis.includes(o.cli)) throw new Error(`${o.cli} isn't available here; use ${this.o.clis.join(", ")}`);
    const ws = new Workspace(this.o.repo);
    const known = ws.members().find((m) => m.id === id);
    if (this.personas.has(id)) throw new Error(`${id} is already in this channel`);
    if (!known && !o.persona?.trim()) throw new Error(`${id} needs a persona`);
    if (o.persona?.trim()) {
      ws.writePersona(id, { name: id, role: o.role?.trim() || known?.role || id, body: o.persona });
      ws.saveMember({ id, cli: o.cli, persona: id, role: o.role?.trim() || known?.role, ...(o.model ? { model: o.model } : {}) });
    }
    const reading = o.reading?.map((p) => readingPath(this.o.repo, p));
    const persona = personaFor(this.o.repo, o.persona?.trim() ? id : (known?.persona ?? id), this.o.assetsDir);
    let brief: string | undefined;
    if (o.brief) {
      const notes = (["decisions.md", "open-questions.md"] as const).flatMap((p): [string, string][] => (this.store.readDoc(p).trim() ? [[p, this.store.readDoc(p)]] : []));
      const recent = renderEvents(this.store.events().filter((e) => e.type === "message" && e.to === "room" && inMain(e)).slice(-30), this.focus());
      brief = (await this.oneShot("scribe", briefPrompt({ view: this.view(), member: id, role: persona.role, persona: persona.body, digest: this.digest(), notes, recent }), BRIEF_SYSTEM))?.trim() || undefined;
    }
    const st = this.store.agentState(id);
    const question = o.question?.trim() || undefined;
    this.store.saveAgentState(id, { ...st, sessionId: undefined, sessionTurns: 0, onboarding: { ...(brief ? { brief } : {}), ...(reading ? { reading } : {}), ...(question ? { question } : {}) } });
    // Someone who left this channel comes back on whatever CLI was picked now.
    const c = this.store.config();
    if ((c.left ?? []).some((a) => a.id === id)) this.store.setRoster(c.agents, (c.left ?? []).filter((a) => a.id !== id));
    const joined = this.addMember({ persona: o.persona?.trim() ? id : (known?.persona ?? id), id, cli: o.cli, model: o.model, why: question ? `you just joined, and the human asks you to start with: ${question}` : undefined, quiet: o.quiet });
    if (o.suggestion !== undefined && this.pending().some((p) => p.id === o.suggestion)) this.log({ type: "suggestion.resolved", id: o.suggestion, accepted: true });
    return joined;
  }

  /** The assistant turns a one-line description into a persona the human can edit before anyone joins. */
  async draftPersona(line: string): Promise<{ id: string; role: string; persona: string }> {
    if (!line.trim()) throw new Error("describe the member in a line first");
    const taken = new Set([...new Workspace(this.o.repo).members().map((m) => m.id), ...this.members()]);
    const reply = await this.oneShot("assistant", personaDraftPrompt({ line: line.trim(), view: this.view(), taken: [...taken] }), PERSONA_SYSTEM);
    const d = reply ? parsePersonaDraft(reply) : undefined;
    if (!d) throw new Error("the assistant didn't produce a persona; try describing the member differently");
    let id = d.id;
    for (let n = 2; taken.has(id); n++) id = `${d.id}-${n}`;
    return { ...d, id };
  }

  /** Brings in a member the assistant invented for this problem: its persona joins the workspace too. */
  hire(o: { id: string; cli: CliName; model?: string; role: string; persona: string }): string {
    const ws = new Workspace(this.o.repo);
    if (!ws.members().some((m) => m.id === o.id)) {
      ws.writePersona(o.id, { name: o.id, role: o.role, body: o.persona });
      ws.saveMember({ id: o.id, cli: o.cli, persona: o.id, role: o.role, ...(o.model ? { model: o.model } : {}) });
    }
    return this.addMember({ persona: o.id, id: o.id, cli: o.cli, model: o.model });
  }

  /** A member who joins a conversation already under way (or is asked something) gets the floor. */
  private welcome(id: string, why?: string): void {
    if (why || this.store.events().some((e) => e.type === "message" && e.to === "room" && inMain(e))) {
      this.want({ agent: id, why: why ?? "you just joined; catch up on where things stand and bring your angle" });
    }
    this.kick();
  }

  /** Brings back a member who left; its notebook went with it, and it rebuilds its context on its next turn. */
  rejoin(id: string): string {
    const c = this.store.config();
    const spec = (c.left ?? []).find((a) => a.id === id);
    if (!spec) throw new Error(`"${id}" hasn't left the channel`);
    this.store.setRoster([...c.agents, spec], (c.left ?? []).filter((a) => a.id !== id));
    const st = this.store.agentState(id);
    this.store.saveAgentState(id, { ...st, sessionId: undefined, sessionTurns: 0 });
    this.personas.set(id, personaFor(this.o.repo, spec.persona, this.o.assetsDir));
    this.log({ type: "agent.joined", agent: id, persona: spec.persona, cli: spec.cli, ...(spec.model ? { model: spec.model } : {}) });
    this.welcome(id);
    return id;
  }

  /** A member leaves after writing an exit memo into its notebook (skipped with memo = false); it stays in the workspace. */
  async removeMember(id: string, memo = true): Promise<void> {
    if (!this.personas.has(id)) throw new Error(`no member "${id}"`);
    this.leaving.add(id);
    for (const t of this.running.values()) if (t.agent === id) t.ctrl.abort();
    for (const [k, w] of this.wants) if (w.agent === id) this.wants.delete(k);
    let text: string | undefined;
    if (memo) {
      const st = this.store.agentState(id);
      const prompt = st.sessionId ? EXIT_MEMO : `${renderEvents(this.store.events().filter((e) => visibleTo(id, e) && inMain(e)).slice(-RECENT))}\n\n${EXIT_MEMO}`;
      text = (await this.oneShot(id, prompt, this.personas.get(id)!.body, undefined, st.sessionId))?.trim();
      if (text) this.store.writeNotebook(id, `${this.store.notebook(id).trimEnd()}\n\n## Left #${this.channelName()}\n\n${text}`);
    }
    const c = this.store.config();
    const spec = c.agents.find((a) => a.id === id)!;
    this.store.setRoster(c.agents.filter((a) => a.id !== id), [...(c.left ?? []).filter((a) => a.id !== id), spec]);
    this.personas.delete(id);
    this.leaving.delete(id);
    this.log({ type: "agent.left", agent: id, ...(text ? { memo: text } : {}) });
    this.kick();
  }

  /** CLIs members can run on in this channel. */
  get clis(): string[] {
    return this.o.clis ?? DEFAULT_CLIS;
  }

  channelName(): string {
    return this.store.config().name || this.focus() || this.id;
  }

  /**
   * The human answers a suggestion; an approved one is carried out at once. `edited` replaces its
   * arguments (the human changed the model, the persona, the wording…) and is logged with it.
   */
  async resolve(id: number, accept: boolean, edited?: string[]): Promise<void> {
    const s = this.pending().find((x) => x.id === id);
    if (!s) throw new Error(`no open suggestion ${id}`);
    const args = accept && edited ? checkEdit(s.action, s.args, edited) : s.args;
    if (accept) await this.apply(s.action, args, s.why, s.from);
    // Declining the mail pointer is remembered too, so it isn't offered again.
    if (!accept && s.action === "pointer") new Workspace(this.o.repo).setFlag("mailPointer", "declined");
    const changed = args.join("\u0000") !== s.args.join("\u0000");
    this.log({ type: "suggestion.resolved", id, accepted: accept, ...(changed ? { args } : {}) });
  }

  /**
   * Moves a member, or a support role, to another harness or model. A member keeps its notebook
   * and what it has read; its vendor sessions are dropped, so its next turn rebuilds its context.
   */
  /** Folders outside the repo everyone in the channel may read. */
  dirs(): string[] {
    return this.store.config().dirs ?? [];
  }

  /** Lets everyone in the channel read a folder outside the repo, from their next turn. Returns it, resolved. */
  allowRead(path: string, by: string): string {
    const dir = grantableDir(path, this.o.repo);
    if (!this.dirs().includes(dir)) {
      this.store.setDirs([...this.dirs(), dir]);
      this.log({ type: "access.granted", path: dir, by });
    }
    return dir;
  }

  swapModel(id: string, cli: CliName, model?: string): void {
    if (this.o.clis && !this.o.clis.includes(cli)) throw new Error(`${cli} isn't available here; use ${this.o.clis.join(", ")}`);
    const c = this.store.config();
    if ((SUPPORT_ROLES as string[]).includes(id)) {
      const role = id as keyof RoomConfig["support"];
      const was = c.support[role] ?? c.support.scribe;
      this.store.setSupport(role, { cli, ...(model ? { model } : {}) });
      this.log({ type: "agent.swapped", agent: id, cli, ...(model ? { model } : {}), was: { cli: was.cli, ...(was.model ? { model: was.model } : {}) } });
      return;
    }
    const spec = c.agents.find((a) => a.id === id);
    if (!spec) throw new Error(`no member "${id}"`);
    const next: AgentSpec = { ...spec, cli };
    if (model) next.model = model;
    else delete next.model;
    this.store.setRoster(c.agents.map((a) => (a.id === id ? next : a)), c.left ?? []);
    for (const k of this.store.agentStateKeys(id)) this.store.saveAgentState(k, { ...this.store.agentState(k), sessionId: undefined, sessionTurns: 0 });
    const ws = new Workspace(this.o.repo);
    const known = ws.members().find((m) => m.id === id);
    if (known) ws.saveMember({ ...known, cli, ...(model ? { model } : { model: undefined }) });
    this.log({ type: "agent.swapped", agent: id, cli, ...(model ? { model } : {}), was: { cli: spec.cli, ...(spec.model ? { model: spec.model } : {}) } });
  }

  /** Whoever made suggestions takes them back (they were replaced, or no longer stand). */
  withdraw(ids: number[], by: string): void {
    for (const id of ids) {
      const s = this.pending().find((x) => x.id === id);
      if (s && (s.from === by || by === "assistant")) this.log({ type: "suggestion.resolved", id, accepted: false, withdrawn: true });
    }
  }

  private async apply(action: SuggestionAction, args: string[], why: string, from = "assistant"): Promise<void> {
    switch (action) {
      case "export":
        this.exportDoc(args[0], args[1]);
        return;
      case "mail":
        this.sendMail(args[0], args[1], args[2] ?? "", from);
        return;
      case "pointer":
        this.addMailPointer(args[0]);
        return;
      case "read":
        this.allowRead(args[0], "human");
        return;
      case "steer":
        this.post(args[0]);
        return;
      case "add":
        this.addMember({ persona: args[0], cli: args[1] as CliName, model: args[2] || undefined });
        return;
      case "hire":
        this.hire({ id: args[0], cli: args[1] as CliName, model: args[2] || undefined, role: args[3] ?? "", persona: args[4] ?? "" });
        return;
      case "swap":
        this.swapModel(args[0], args[1] as CliName, args[2] || undefined);
        return;
      case "remove":
        await this.removeMember(args[0]);
        return;
      case "focus":
        this.setFocus(args[0]);
        return;
      case "close":
        this.closeTopic(args[0], "human", why);
        return;
      case "parallel":
        this.configure({ parallel: Number(args[0]) });
        return;
    }
  }

  /** Saves a channel document someone wrote (the assistant's records, for one). */
  writeDoc(name: string, text: string, by: string, note?: string): { slug: string; version: number } {
    const slug = slugify(name);
    if (!text.trim()) throw new Error("the document is empty");
    const kind = (this.docs().find((d) => d.slug === slug)?.kind ?? (/^(plan|issue|decision)/.exec(slug)?.[1] as DocKind | undefined) ?? "other") as DocKind;
    const version = this.store.writeOutput(slug, text);
    this.log({ type: "doc.revised", slug, version, kind, by, ...(note ? { note } : {}) });
    return { slug, version };
  }

  /**
   * Copies a channel document into the project. It won't overwrite a file Quorum didn't write
   * itself; a file it exported before is updated in place.
   */
  exportDoc(slug: string, path: string): string {
    const doc = this.docs().find((d) => d.slug === slugify(slug));
    if (!doc) throw new Error(`no document "${slug}"`);
    const rel = relative(this.o.repo, resolve(this.o.repo, path));
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === ".quorum") throw new Error(`${path} isn't a path in the project`);
    const ws = new Workspace(this.o.repo);
    const mine: string[] = JSON.parse(ws.flag("exported") ?? "[]");
    if (existsSync(join(this.o.repo, rel)) && !mine.includes(rel)) throw new Error(`${rel} already exists and Quorum didn't write it; export somewhere else`);
    mkdirSync(dirname(join(this.o.repo, rel)), { recursive: true });
    writeFileSync(join(this.o.repo, rel), this.store.readOutput(doc.slug, doc.accepted ?? doc.version));
    if (!mine.includes(rel)) ws.setFlag("exported", JSON.stringify([...mine, rel]));
    this.log({ type: "aside", from: "assistant", text: `Exported ${doc.slug} to ${rel}.`, kind: "note" });
    return rel;
  }

  /** Sends mail to the project's agents; the first mail offers to tell them where to find it. */
  sendMail(to: string, subject: string, body: string, by: string, thread?: number): string {
    if (!to.trim() || !subject.trim()) throw new Error("mail needs a recipient and a subject");
    const box = new Mailbox(this.o.repo);
    const m = box.send({ to: to.trim(), from: QUORUM, subject: subject.trim(), body, channel: this.channelName() });
    this.log({ type: "mail.out", file: m.file, to: m.to, subject: m.subject, by, ...(thread ? { thread } : {}) });
    const ws = new Workspace(this.o.repo);
    if (!ws.flag("mailPointer")) {
      ws.setFlag("mailPointer", "offered");
      const target = ["AGENTS.md", "CLAUDE.md"].find((f) => existsSync(join(this.o.repo, f))) ?? "AGENTS.md";
      this.suggest("assistant", "pointer", [target], `so the project's agents know to check .quorum/mail/ and how to reply`);
    }
    return m.file;
  }

  /** Adds a short section about Quorum mail to the project's agent notes. */
  addMailPointer(file: string): void {
    const path = join(this.o.repo, file);
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (!before.includes("## Quorum mail")) writeFileSync(path, `${before.trimEnd()}${before ? "\n" : ""}${MAIL_POINTER}`);
    new Workspace(this.o.repo).setFlag("mailPointer", "added");
  }

  /** Delivers mail from the project's agents into the channel: as a message, in the thread it answers if any. */
  checkMail(): void {
    const box = new Mailbox(this.o.repo);
    const name = this.channelName();
    const sent = new Map(this.store.events().flatMap((e) => (e.type === "mail.out" ? [[e.file, e] as const] : [])));
    let any = false;
    for (const m of box.undelivered(name)) {
      if (m.channel && m.channel !== name && m.to === QUORUM) continue;
      const replyTo = m.inReplyTo ? sent.get(m.inReplyTo) : undefined;
      const text = `**Mail: ${m.subject}**${replyTo ? ` (reply to "${replyTo.subject}")` : ""}\n\n${m.body}\n\n_(.quorum/mail/${m.file})_`;
      this.log({ type: "message", from: `mail:${m.from}`, to: "room", text, ...(replyTo?.thread ? { thread: replyTo.thread } : {}) });
      box.markDelivered(m.file);
      any = true;
    }
    if (any) this.floorCheck();
  }

  private suggest(from: string, action: SuggestionAction, args: string[], why: string): void {
    args = this.withModel(action, args);
    if (this.pending().some((p) => p.action === action && p.args.join(" ") === args.join(" "))) return;
    const id = 1 + Math.max(0, ...this.store.events().flatMap((e) => (e.type === "suggestion" ? [e.id] : [])));
    this.log({ type: "suggestion", id, from, action, args, why });
  }

  /** Files the latest version of an issue document with `gh` and returns its URL. Only on the human's say-so. */
  async exportIssue(slug: string): Promise<string> {
    const doc = this.docs().find((d) => d.slug === slug);
    if (!doc) throw new Error(`no document "${slug}"`);
    const text = this.store.readOutput(slug, doc.accepted);
    const heading = /^#\s+(.+)$/m.exec(text);
    const title = heading?.[1].trim() ?? slug;
    const body = heading ? text.replace(heading[0], "").trim() : text;
    const url = await (this.o.fileIssue ?? ghIssue(this.o.repo))(title, body);
    this.log({ type: "aside", from: "assistant", text: `Filed ${slug} as ${url}`, kind: "note" });
    return url;
  }

  /** Stops everything and the tool server; call when done with the room. */
  async close(): Promise<void> {
    if (this.mailTimer) clearInterval(this.mailTimer);
    this.pause("closed");
    if (this.tools) await (await this.tools).close();
  }

  /** Resolves once no member or support role is working and the room is paused or idle. */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.settle();
    });
  }

  private settle(): void {
    if (this.running.size || this.busy.size || this.deciding || this._state === "running") return;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  // ---- scheduling ----

  private want(p: FloorPick | Want): void {
    if (!this.personas.has(p.agent) || this.leaving.has(p.agent)) return;
    const { agent, why, replyTo, to, thread, snapshot } = p as Want;
    this.wants.set(turnKey(agent, thread), {
      agent,
      why,
      ...(replyTo ? { replyTo } : {}),
      ...(to ? { to } : {}),
      ...(thread ? { thread } : {}),
      ...(snapshot ? { snapshot } : {}),
    });
  }

  private saveWants(): void {
    this.store.setMeta({ wants: JSON.stringify([...this.wants]) });
  }

  /**
   * After new messages: members addressed directly (a DM, or an @mention from the human or the
   * Chair) get the floor at once, and the floor policy decides who else, if anyone, has something to
   * add. The channel and each side thread are decided separately, in order. The floor also tags each
   * message for the human's dashboard.
   */
  private floorCheck(): void {
    if (this._state === "paused") return;
    if (this.deciding) {
      this.floorDirty = true;
      return;
    }
    const after = Number(this.store.meta().floorSeq ?? 0);
    const fresh = this.store.events().slice(after).filter((e): e is MessageEvent => e.type === "message");
    this.store.setMeta({ floorSeq: this.store.lastSeq });
    const members = this.members().filter((m) => !this.leaving.has(m));
    const direct: FloorPick[] = [];
    for (const e of fresh) {
      for (const m of mentioned(e, members)) {
        direct.push(
          e.to === m
            ? { agent: m, replyTo: e.seq, why: `${e.from} wrote to you privately`, to: e.from }
            : { agent: m, replyTo: e.seq, why: `${e.from} asked you directly`, ...(e.thread ? { thread: e.thread } : {}) },
        );
      }
    }
    for (const p of direct) this.want(p);
    // Public messages, grouped by conversation: the channel (0) and each thread.
    const groups = new Map<number, MessageEvent[]>();
    for (const e of fresh) if (e.to === "room") groups.set(e.thread ?? 0, [...(groups.get(e.thread ?? 0) ?? []), e]);
    if (!groups.size) return this.kick();
    this.deciding = true;
    this.kick();
    void (async () => {
      this.emit({ event: "room.support", data: { role: "floor", busy: true } });
      const picked: FloorPick[] = [...direct];
      const tags: MessageTag[] = [];
      for (const [thread, pub] of groups) {
        if (this.state === "paused") break;
        const d = await this.floorPolicy
          .decide(
            {
              view: this.view(),
              members: members.map((id) => ({ id, role: this.personas.get(id)?.role ?? "" })),
              speaking: this.speaking,
              fresh: pub,
              recent: this.floorRecent(thread, pub[0].seq),
              max: this.store.config().parallel,
              ...(thread ? { thread } : {}),
            },
            this.supportAbort.signal,
          )
          .catch(() => ({ picks: [] as FloorPick[], tags: [] as MessageTag[] }));
        tags.push(...d.tags);
        // Whoever spoke last doesn't get to answer itself unless someone asked it something.
        const last = pub.at(-1)!;
        const snapshot = this.store.config().independent ? this.store.lastSeq : undefined;
        const chosen = d.picks
          .filter((p) => p.agent !== last.from && !direct.some((x) => x.agent === p.agent && (x.thread ?? 0) === thread))
          .map((p) => ({ ...p, ...(thread ? { thread } : {}), ...(snapshot ? { snapshot } : {}) }));
        // The human is never left unanswered: if nobody was picked or summoned, whoever has spoken
        // least recently in this conversation takes it.
        if (!chosen.length && last.from === "human" && !direct.some((x) => (x.thread ?? 0) === thread)) {
          const quiet = this.leastRecent(members, thread);
          if (quiet) chosen.push({ agent: quiet, replyTo: last.seq, why: "the human asked and nobody else picked it up", ...(thread ? { thread } : {}) });
        }
        if (this._state !== "paused") for (const p of chosen) this.want(p);
        picked.push(...chosen);
        if (thread && !chosen.length) this.settleThread(thread);
      }
      this.emit({ event: "room.support", data: { role: "floor", busy: false } });
      if (tags.length) this.log({ type: "tags", items: tags });
      if (this._state !== "paused" && picked.length) this.log({ type: "floor", picks: picked });
    })().finally(() => {
      this.deciding = false;
      if (this.floorDirty) {
        this.floorDirty = false;
        this.floorCheck();
      } else this.kick();
    });
  }

  /** The member who has spoken least recently in a conversation (never counts as longest ago); ties go by name. */
  private leastRecent(members: string[], thread: number): string | undefined {
    const last = new Map<string, number>();
    for (const e of this.store.events()) {
      if (e.type === "message" && (e.thread ?? 0) === thread) last.set(e.from, e.seq);
    }
    return [...members].sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0) || a.localeCompare(b))[0];
  }

  /** Earlier public messages the floor sees for a conversation: the channel's, or a thread's with its root. */
  private floorRecent(thread: number, before: number): RoomEvent[] {
    const msgs = this.store.events().slice(0, before - 1).filter((e) => e.type === "message" && e.to === "room");
    if (!thread) return msgs.filter(inMain).slice(-20);
    return msgs.filter((e) => e.seq === thread || (e.type === "message" && e.thread === thread)).slice(-20);
  }

  /** Once a thread goes quiet, posts its outcome back to the channel (once per burst of activity). */
  private settleThread(thread: number): void {
    const busy = [...this.running.keys(), ...this.wants.keys()].some((k) => k.endsWith(`#${thread}`));
    const { root, messages } = this.thread(thread);
    const lastSeq = messages.at(-1)?.seq ?? thread;
    if (busy || Number(this.store.meta()[`thread${thread}`] ?? 0) >= lastSeq || !messages.some((m) => m.type === "message" && m.from !== "human")) return;
    this.store.setMeta({ [`thread${thread}`]: lastSeq });
    void this.job("scribe", async () => {
      const text = (await this.oneShot("scribe", threadSummaryPrompt(root, root?.seq === thread && root.type === "message" && root.thread ? [root, ...messages] : messages), THREAD_SUMMARY, undefined, undefined, this.supportAbort.signal))?.trim();
      if (text && text !== "NOTHING") this.log({ type: "thread.summary", thread, text: text.split("\n")[0].slice(0, 300) });
    });
  }

  /** CLIs without a quota report are held to the turn cap per resume. */
  private capped(cli: string): boolean {
    return !this.quota.has(cli) && (this.turnsByCli.get(cli) ?? 0) >= this.store.config().turnCap;
  }

  /** Starts turns for members who have the floor, up to the parallel cap; goes quiet when nobody does. */
  private kick(): void {
    if (this._state === "paused") return;
    const { parallel, turnCap } = this.store.config();
    const blocked: string[] = [];
    for (const [key, w] of [...this.wants]) {
      if (this.running.size >= parallel) break;
      if (!this.personas.has(w.agent) || this.leaving.has(w.agent)) {
        this.wants.delete(key);
        continue;
      }
      if (this.running.has(key)) continue;
      const { cli } = this.spec(w.agent);
      if (this.capped(cli)) {
        blocked.push(w.agent);
        continue;
      }
      this.wants.delete(key);
      this.turnsByCli.set(cli, (this.turnsByCli.get(cli) ?? 0) + 1);
      const ctrl = new AbortController();
      this.running.set(key, { agent: w.agent, ctrl, why: w });
      void this.turn(w.agent, ctrl, w);
    }
    this.saveWants();
    if (this.running.size || this.deciding) return this.setState("running");
    if (blocked.length) {
      const clis = [...new Set(blocked.map((a) => this.spec(a).cli))];
      return this.pause(`turn cap reached (${turnCap} turns each for ${clis.join(", ")})`);
    }
    this.setState("idle");
    // A quiet room is the support roles' cue, if anything happened since each last looked.
    const m = this.store.meta();
    if (this.memberMessagesAfter(Number(m.chairSeq ?? 0)) > 0) void this.runChair("the room went quiet");
    if (this.memberMessagesAfter(Number(m.scribeSeq ?? 0)) > 0) void this.runScribe();
    if (this.memberMessagesAfter(Number(m.watchSeq ?? 0)) > 0) void this.watch("the room went quiet");
    this.settle();
  }

  /** After each member message: run support roles whose interval has passed. */
  private afterMessage(): void {
    const m = this.store.meta();
    if (this.memberMessagesAfter(Number(m.scribeSeq ?? 0)) >= EVERY.scribe) void this.runScribe();
    if (this.memberMessagesAfter(Number(m.chairSeq ?? 0)) >= EVERY.chair) void this.runChair("regular check-in");
    const s = this.signals();
    if (looksStuck(s)) void this.watch(`the room may be stuck: ${describeSignals(s)}`);
    else if (this.memberMessagesAfter(Number(m.watchSeq ?? 0)) >= EVERY.watch) void this.watch("regular check-in");
  }

  private async turn(agent: string, ctrl: AbortController, why: FloorReason): Promise<void> {
    const thread = why.thread;
    const key = turnKey(agent, thread);
    const sk = stateKey(agent, thread);
    let st = this.store.agentState(sk);
    // With independent takes, a member drafts from what was there when the floor picked it.
    const upTo = why.snapshot ?? this.store.lastSeq;
    // Long vendor sessions get compacted unpredictably, and a member that missed a lot reads better
    // from a fresh summary; either way, rebuild its context from files.
    const unread = this.store.events().slice(st.lastRead, upTo).filter((e) => visibleTo(agent, e)).length;
    if (st.sessionId && ((st.sessionTurns ?? 0) >= REFRESH || unread > CATCHUP)) st = { ...st, sessionId: undefined, sessionTurns: 0 };
    const spec = this.spec(agent);
    const transport = this.o.transports(spec);
    const token = newToken();
    let mcp: McpServerSpec | undefined;
    if (transport.supportsMcp) {
      this.tools ??= ToolServer.start(this.callTool);
      try {
        mcp = (await this.tools).spec(token);
        this.live.set(token, { agent, ctrl, ...(thread ? { thread } : {}) });
      } catch {
        // Without the tool server the member can still speak; it just can't take side actions.
        this.tools = undefined;
      }
    }
    const tag = thread ? { thread } : {};
    this.emit({ event: "room.turn.start", data: { agent, ...tag } });
    const reading = this.readingFor(agent, st);
    let sessionId = st.sessionId;
    const run = async (prompt: string, session: string | undefined): Promise<{ text: string; failed?: string }> => {
      let text = "";
      let failed: string | undefined;
      try {
        for await (const e of transport.send(prompt, {
          cwd: this.o.repo,
          dirs: this.dirs(),
          systemPrompt: [this.personas.get(agent)?.body, accessNote(this.o.repo, this.dirs())].filter(Boolean).join("\n\n"),
          readOnly: this.o.readOnly ?? true,
          sessionId: session,
          signal: ctrl.signal,
          mcp,
        })) {
          if (e.type === "text") {
            text += e.delta;
            this.emit({ event: "room.turn.delta", data: { agent, delta: e.delta, ...tag } });
          } else if (e.type === "tool") {
            // What a member writes before a tool call is thinking aloud; its message is what comes after the last one.
            text = "";
            this.emit({ event: "room.turn.tool", data: { agent, name: e.name, ...tag } });
          } else if (e.type === "usage") {
            this.usage(agent, spec.cli, e.quotaUtilization, e.rateLimited);
            this.spent(agent, spec, e);
          } else if (e.type === "done" && e.sessionId) {
            sessionId = e.sessionId;
            noteVendorSession(this.o.repo, { room: this.id, agent: sk, cli: spec.cli, ...(spec.model ? { model: spec.model } : {}), session: e.sessionId });
          }
          else if (e.type === "error") failed = e.message;
        }
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
      }
      return { text: text.trim(), failed };
    };
    let { text: reply, failed } = await run(this.memberPrompt(agent, st, upTo, Boolean(mcp), why, reading), st.sessionId);
    // Independent takes: if others answered while this member was drafting, it reads them and revises.
    if (why.snapshot && !ctrl.signal.aborted && reply && reply !== PASS) {
      const others = this.store.events().slice(why.snapshot).filter((e) => e.type === "message" && e.from !== agent && e.to === "room" && (e.thread ?? 0) === (thread ?? 0));
      if (others.length) {
        this.emit({ event: "room.turn.tool", data: { agent, name: "revise", ...tag } });
        const second = await run(sessionId ? reviseIndependent(reply, others) : `${this.memberPrompt(agent, st, upTo, Boolean(mcp), why, reading)}\n\n${reviseIndependent(reply, others)}`, sessionId);
        if (!second.failed && second.text) reply = second.text;
      }
    }
    this.running.delete(key);
    this.live.delete(token);
    this.emit({ event: "room.turn.end", data: { agent, ...tag } });
    // An aborted turn is owed: the member gets the floor back on resume.
    if (ctrl.signal.aborted) {
      if (!this.leaving.has(agent) && this.personas.has(agent)) this.wants.set(key, { ...why, agent });
      this.saveWants();
      this.settle();
      return;
    }
    if (failed && !reply) {
      this.log({ type: "turn.failed", agent, message: failed });
      // A vendor session that broke the turn is dropped; the next turn rebuilds context from the log.
      sessionId = undefined;
    } else if (reply && reply !== PASS) {
      // A DM from a member who has since left goes to the room instead of nowhere.
      const to = why.to && (why.to === "human" || this.personas.has(why.to)) ? why.to : "room";
      this.log({ type: "message", from: agent, to, text: reply, ...(why.replyTo ? { replyTo: why.replyTo } : {}), ...(to === "room" && thread ? { thread } : {}) });
      if (to === "room" && !thread) this.afterMessage();
    }
    const fresh = sessionId !== st.sessionId;
    this.store.saveAgentState(sk, {
      sessionId,
      sessionTurns: sessionId ? (fresh ? 1 : (st.sessionTurns ?? 0) + 1) : 0,
      lastRead: upTo,
      turns: st.turns + 1,
      ...(reading.paths.length ? { readAt: Date.now(), readList: reading.paths } : { readAt: st.readAt, readList: st.readList }),
    });
    this.floorCheck();
  }

  /** The channel's reading list for a member: everything if it never read it, otherwise what changed. */
  private readingFor(agent: string, st: AgentState): { paths: string[]; changed?: string[] } {
    // A member onboarded with its own reading list starts from that.
    if (st.onboarding?.reading) return { paths: st.onboarding.reading };
    const paths = this.store.config().reading ?? [];
    if (!paths.length) return { paths };
    // The channel-level state holds the reading position, whichever conversation the turn is in.
    const main = this.store.agentState(agent);
    const readAt = main.readAt ?? st.readAt;
    if (!readAt) return { paths };
    const known = new Set(main.readList ?? st.readList ?? []);
    const changed = readingFiles(this.o.repo, paths)
      .filter((f) => f.mtime > readAt || ![...known].some((k) => f.path === k || f.path.startsWith(`${k}/`) || k === "."))
      .map((f) => f.path);
    return { paths, changed };
  }

  /** Quota reports drive the hard budget: warn once per resume, pause at the stop line. */
  /** Adds a turn's tokens to the member's spend, priced when its model is paid per token. */
  private spent(agent: string, spec: { cli: CliName; model?: string }, e: Extract<AgentEvent, { type: "usage" }>): void {
    const input = e.inputTokens ?? 0;
    const output = e.outputTokens ?? 0;
    if (!input && !output && e.costUsd === undefined) return;
    const p = this.o.price?.(spec.cli, spec.model || this.o.defaultModel?.(spec.cli));
    const usd = e.costUsd ?? (p ? (input * p.input + output * p.output) / 1e6 : undefined);
    const id = agent.split("@")[0]; // a side thread counts toward its member
    const spend = this.store.addSpend(id, { input, output, ...(usd !== undefined ? { usd } : {}) });
    this.emit({ event: "room.spend", data: { agent: id, cli: spec.cli, spend } });
  }

  private usage(agent: string, cli: string, q: number | undefined, rateLimited: boolean | undefined): void {
    if (q === undefined && !rateLimited) return;
    this.emit({ event: "room.usage", data: { agent, cli, quotaUtilization: q, rateLimited } });
    const { quotaWarn, quotaStop } = this.store.config();
    if (rateLimited) {
      this.log({ type: "budget", level: "stop", cli, detail: `${cli} is rate limited` });
      return this.pause(`budget: ${cli} is rate limited`);
    }
    this.quota.set(cli, q!);
    const pct = Math.round(q! * 100);
    if (q! >= quotaStop) {
      this.log({ type: "budget", level: "stop", cli, detail: `${cli} is at ${pct}% of its quota window` });
      this.pause(`budget: ${cli} at ${pct}% of its quota window`);
      void this.watch(`the room paused because ${cli} reached ${pct}% of its quota`);
    } else if (q! >= quotaWarn && !this.warned.has(cli)) {
      this.warned.add(cli);
      this.log({ type: "budget", level: "warn", cli, detail: `${cli} is at ${pct}% of its quota window` });
    }
  }

  private memberPrompt(agent: string, st: AgentState, upTo: number, tools: boolean, floor: FloorReason, reading: { paths: string[]; changed?: string[] }): string {
    const events = this.store.events().slice(0, upTo);
    const view = this.view();
    if (floor.thread) {
      const { root } = this.thread(floor.thread);
      const thread = events.filter((e) => e.type === "message" && e.thread === floor.thread && e.seq !== floor.thread && (!st.sessionId || e.seq > st.lastRead));
      return memberThread({ agent, view, digest: this.digest(), root, thread, tools, floor, fresh: !st.sessionId });
    }
    const seen = events.filter((e) => visibleTo(agent, e) && !MEMBER_NOISE.has(e.type) && inMain(e));
    // The reading list is mentioned on a fresh start, or when something on it changed.
    const read = !reading.paths.length ? undefined : reading.changed === undefined || reading.changed.length ? reading : undefined;
    if (st.sessionId) {
      return memberIncremental({ view, recent: seen.filter((e) => e.seq > st.lastRead), tools, floor, ...(read ? { reading: read } : {}) });
    }
    const notes: [string, string][] = [];
    for (const p of ["decisions.md", "open-questions.md", view.focus && `topics/${view.focus}.md`, "code-notes.md"]) {
      if (p && this.store.readDoc(p).trim()) notes.push([p, this.store.readDoc(p)]);
    }
    return memberFresh({
      agent,
      view,
      notes,
      staleCode: this.staleCode(),
      notebook: this.store.notebook(agent),
      recent: seen.slice(-RECENT),
      total: seen.length,
      joined: st.turns === 0 && events.some((e) => e.type === "agent.joined" && e.agent === agent),
      tools,
      floor,
      reading: read ?? (reading.paths.length ? { paths: reading.paths, changed: [] } : undefined),
      elsewhere: this.elsewhere(agent),
      ...(st.onboarding?.brief ? { brief: st.onboarding.brief } : {}),
    });
  }

  /** Where things stand in the member's other channels, from each one's assistant digest. */
  private elsewhere(agent: string): [string, string][] {
    return new Workspace(this.o.repo)
      .channels()
      .filter((c) => c.id !== this.id && c.digest)
      .flatMap((c): [string, string][] => {
        try {
          const cfg = RoomStore.open(this.o.repo, c.id).config();
          return cfg.agents.some((a) => a.id === agent) ? [[cfg.name || c.id, c.digest]] : [];
        } catch {
          return [];
        }
      })
      .slice(0, 4);
  }

  /** A warning when the code notes describe a different commit than the repo is at now. */
  private staleCode(): string | undefined {
    const at = this.store.meta().codeCommit;
    if (!at || !this.store.readDoc("code-notes.md").trim()) return undefined;
    const now = (this.o.head ?? gitHead(this.o.repo))();
    return now && now !== at ? `the code notes were written at commit ${at}, but the repo is now at ${now}; check before relying on them.` : undefined;
  }

  // ---- member tools ----

  /** Runs a room tool for the turn holding `token`; a thrown error goes back to the member as the tool result. */
  private readonly callTool: ToolHandler = (token, name, args) => {
    const turn = this.live.get(token);
    if (!turn) throw new Error("this turn is over; nothing was sent");
    if (turn.ctrl.signal.aborted) throw new Error("the room is paused; nothing was sent");
    const { agent } = turn;
    const text = typeof args.text === "string" ? args.text.trim() : "";
    switch (name) {
      case "dm": {
        if (!text) throw new Error("text is required");
        const to = String(args.to ?? "");
        if (to === agent || (to !== "human" && !this.personas.has(to)))
          throw new Error(`no member "${to}"; members are ${["human", ...this.members()].filter((a) => a !== agent).join(", ")}`);
        const e = this.log({ type: "message", from: agent, to, text });
        this.floorCheck();
        return `Sent privately to ${to} as #${e.seq}.`;
      }
      case "mail_draft": {
        const to = String(args.to ?? "").trim();
        const subject = String(args.subject ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!to || !subject || !body) throw new Error("to, subject and body are required");
        this.suggest(agent, "mail", [to, subject, body], typeof args.why === "string" ? args.why : "");
        return "Drafted. The human approves it before it's sent; replies come back into the channel.";
      }
      case "raise_topic": {
        const slug = this.raiseTopic(String(args.title ?? ""), agent, typeof args.why === "string" ? args.why : undefined);
        return `Raised as ${slug}. It is parked until the Chair and the human give it focus.`;
      }
      case "doc_draft": {
        const slug = slugify(String(args.name ?? ""));
        if (!text) throw new Error("text is required: the whole document");
        const kind = (["plan", "issue", "decision", "other"].includes(String(args.kind)) ? args.kind : (this.docs().find((d) => d.slug === slug)?.kind ?? "other")) as DocKind;
        const version = this.store.writeOutput(slug, text);
        const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined;
        this.log({ type: "doc.revised", slug, version, kind, by: agent, ...(note ? { note } : {}) });
        return `Saved ${slug} v${version}.`;
      }
      case "read_doc": {
        const want = String(args.name ?? "").trim().replace(/\.md$/, "");
        const listing = () =>
          [
            this.docs().length ? `Documents: ${this.docs().map((d) => `${d.slug} v${d.version}`).join(", ")}` : "No documents yet.",
            `Shared notes: ${this.store.docPaths().map((p) => p.replace(/\.md$/, "")).join(", ") || "none yet"}`,
          ].join("\n");
        if (!want) return listing();
        const doc = this.docs().find((d) => d.slug === want);
        if (doc) return `${doc.slug} v${doc.version}${doc.accepted ? ` (v${doc.accepted} accepted)` : ""}:\n\n${this.store.readOutput(doc.slug)}`;
        if (RoomStore.isDocPath(`${want}.md`) && this.store.readDoc(`${want}.md`).trim()) return this.store.readDoc(`${want}.md`);
        throw new Error(`nothing called "${want}".\n${listing()}`);
      }
      case "notebook_read":
        return this.store.notebook(agent) || "Your notebook is empty.";
      case "notebook_write": {
        if (String(args.text ?? "").length > 20_000) throw new Error("keep your notebook under 20,000 characters");
        this.store.writeNotebook(agent, String(args.text ?? ""));
        return "Notebook saved.";
      }
      case "read_room": {
        const limit = Math.min(50, Math.max(1, Math.trunc(Number(args.limit ?? 20)) || 20));
        const before = args.before === undefined ? Infinity : Number(args.before);
        const msgs = this.store
          .events()
          .filter((e) => e.seq < before && e.type === "message" && visibleTo(agent, e))
          .slice(-limit);
        return msgs.length ? renderEvents(msgs, this.focus()) : "No messages.";
      }
      default:
        throw new Error(`unknown tool "${name}"`);
    }
  };

  // ---- support roles ----

  /** One plain turn for a support role (or a leaving member); returns the reply, or undefined on failure. */
  private async oneShot(
    id: string,
    prompt: string,
    systemPrompt: string,
    onDelta?: (d: string) => void,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const spec = this.spec(id);
    let text = "";
    let failed: string | undefined;
    try {
      const access = accessNote(this.o.repo, this.dirs(), id === "assistant");
      for await (const e of this.o.transports(spec).send(prompt, { cwd: this.o.repo, dirs: this.dirs(), systemPrompt: `${systemPrompt}\n\n${access}`, readOnly: true, sessionId, signal })) {
        if (e.type === "text") {
          text += e.delta;
          onDelta?.(e.delta);
        } else if (e.type === "usage") {
          this.usage(id, spec.cli, e.quotaUtilization, e.rateLimited);
          this.spent(id, spec, e);
        }
        else if (e.type === "done" && e.sessionId) noteVendorSession(this.o.repo, { room: this.id, agent: id, cli: spec.cli, ...(spec.model ? { model: spec.model } : {}), session: e.sessionId });
        else if (e.type === "error") failed = e.message;
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    if (signal?.aborted) return undefined;
    if (failed && !text.trim()) {
      this.log({ type: "turn.failed", agent: id, message: failed });
      return undefined;
    }
    return text;
  }

  /** Runs a support job unless the same one is already running. */
  private async job(name: SupportRole | "watch", fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    this.emit({ event: "room.support", data: { role: name, busy: true } });
    try {
      await fn();
    } finally {
      this.busy.delete(name);
      this.emit({ event: "room.support", data: { role: name, busy: false } });
      this.settle();
    }
  }

  private roster(): string {
    const last = new Map<string, number>();
    for (const e of this.store.events()) if (e.type === "message") last.set(e.from, e.seq);
    return this.members()
      .map((m) => `- ${m}: ${this.store.agentState(m).turns} turns, last spoke ${last.has(m) ? `at #${last.get(m)}` : "never"}`)
      .join("\n");
  }

  /** What members can all see, for the Chair and scribe (no DMs or asides). */
  private publicEvents(after: number, limit: number): string {
    const es = this.store
      .events()
      .slice(after)
      .filter((e) => (e.type === "message" ? e.to === "room" : visibleTo("", e)) && e.type !== "pass" && e.type !== "docs.updated");
    return renderEvents(es.slice(-limit), this.focus()) || "(nothing yet)";
  }

  runChair(reason: string): Promise<void> {
    if (this._state === "paused") return Promise.resolve();
    return this.job("chair", async () => {
      const upTo = this.store.lastSeq;
      this.store.setMeta({ chairSeq: upTo });
      const reply = await this.oneShot(
        "chair",
        chairPrompt({ view: this.view(), roster: this.roster(), signals: describeSignals(this.signals()), recent: this.publicEvents(0, 40), reason }),
        CHAIR_SYSTEM,
        undefined,
        undefined,
        this.supportAbort.signal,
      );
      if (reply === undefined) return;
      const { prose, directives } = parseDirectives(reply, CHAIR_VERBS);
      for (const d of directives) this.chairAction(d);
      if (prose && prose !== PASS) {
        this.log({ type: "message", from: "chair", to: "room", text: prose });
        this.floorCheck();
      }
    });
  }

  private chairAction(d: Directive): void {
    try {
      switch (d.verb) {
        case "accept": {
          const slug = d.args[0];
          const doc = this.docs().find((x) => x.slug === slug);
          const version = Number((d.args[1] ?? "").replace(/^v/i, "")) || doc?.version;
          if (!doc || !version || version > doc.version || doc.accepted === version) return;
          this.store.markAccepted(slug, version);
          this.log({ type: "doc.accepted", slug, version, by: "chair" });
          // An agreed document is a milestone the human should look at before the room carries on.
          this.pause(`milestone: ${slug} v${version} accepted`);
          void this.watch(`the Chair accepted ${slug} v${version} and the room paused for the human to review it`);
          return;
        }
        case "nudge": {
          const to = d.args[0];
          if (this.personas.has(to) && d.why) {
            this.log({ type: "message", from: "chair", to, text: d.why });
            this.floorCheck();
          }
          return;
        }
        case "raise":
          this.raiseTopic(d.args[0], "chair", d.why || undefined);
          return;
        case "focus":
        case "close":
          if (this.topics().some((t) => t.slug === d.args[0] && !t.closed)) this.suggest("chair", d.verb, [d.args[0]], d.why);
          return;
      }
    } catch {
      // A malformed action from a model is dropped rather than stopping the room.
    }
  }

  runScribe(): Promise<void> {
    return this.job("scribe", async () => {
      const after = Number(this.store.meta().scribeSeq ?? 0);
      const upTo = this.store.lastSeq;
      if (upTo <= after) return;
      const commit = (this.o.head ?? gitHead(this.o.repo))();
      const docs = this.store.docPaths().map((p): [string, string] => [p, this.store.readDoc(p)]);
      const reply = await this.oneShot("scribe", scribePrompt({ view: this.view(), docs, recent: this.publicEvents(after, 80), commit }), SCRIBE_SYSTEM);
      if (reply === undefined) return;
      this.store.setMeta({ scribeSeq: upTo });
      const files = parseFileBlocks(reply);
      for (const f of files) this.store.writeDoc(f.path, f.text);
      if (files.some((f) => f.path === "code-notes.md") && commit) this.store.setMeta({ codeCommit: commit });
      if (files.length) this.log({ type: "docs.updated", files: files.map((f) => f.path), by: "scribe" });
    });
  }

  /** The assistant's latest digest of where the room stands. */
  digest(): string | undefined {
    for (const e of [...this.store.events()].reverse()) if (e.type === "aside" && e.kind === "digest") return e.text;
    return undefined;
  }

  private assistantContext(): string {
    const pending = this.pending()
      .map((p) => `${p.id}. ${p.action} ${p.args.join(" ")} (from ${p.from}${p.why ? `: ${p.why}` : ""})`)
      .join("\n");
    const budget = [...this.quota].map(([cli, q]) => `${cli} at ${Math.round(q * 100)}% of its quota window`).join("; ");
    const notes = (["decisions.md", "open-questions.md"] as const).flatMap((p): [string, string][] => (this.store.readDoc(p).trim() ? [[p, this.store.readDoc(p)]] : []));
    const recent = renderEvents(
      this.store.events().filter((e) => e.type !== "docs.updated" && !(e.type === "aside" && e.kind === "digest")).slice(-60),
      this.focus(),
    );
    return assistantContext({ view: this.view(), signals: describeSignals(this.signals()), budget, notes, recent, pending, digest: this.digest() });
  }

  private actions(): string {
    const here = new Set(this.members());
    const others = new Workspace(this.o.repo)
      .members()
      .filter((m) => !here.has(m.id))
      .map((m) => `${m.id} (${m.role ?? m.persona})`);
    return assistantActions(this.o.clis ?? DEFAULT_CLIS, others, this.o.modelMenu?.());
  }

  /**
   * Applies what the assistant wrote: documents are saved at once, a pause takes effect at once,
   * withdrawals clear its old suggestions, and everything else becomes a suggestion.
   */
  private assistantActions(directives: Directive[], blocks: Directive[] = []): void {
    for (const b of blocks) {
      try {
        if (b.verb === "write") this.writeDoc(b.args[0], b.args.at(-1) ?? "", "assistant", b.args.length > 2 ? b.args[1] : b.why || undefined);
        if (b.verb === "mail") this.suggest("assistant", "mail", [b.args[0], b.args.length > 2 ? b.args[1] : b.why, b.args.at(-1) ?? ""], "");
      } catch {
        // A malformed block is dropped rather than breaking the answer.
      }
    }
    for (const d of directives) {
      if (d.verb === "pause") this.pause(`assistant: ${d.args[0] || "pausing for you"}`);
      else if (d.verb === "withdraw") this.withdraw(d.args.flatMap((a) => a.split(",")).map((x) => Number(x.replace(/^#/, ""))).filter(Number.isInteger), "assistant");
      else if (d.verb === "export") {
        const [path, ...why] = d.why.split("|").map((x) => x.trim());
        if (d.args[0] && path) this.suggest("assistant", "export", [d.args[0], path], why.join(" | "));
      }
      else if (d.verb === "hire") {
        // >> hire: id | cli [model] | role | persona | why
        const [cliModel = "", role = "", persona = "", ...why] = d.why.split("|").map((x) => x.trim());
        const [cli, model] = cliModel.split(/\s+/);
        const id = (d.args[0] ?? "").toLowerCase();
        if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) && cli && role && persona) this.suggest("assistant", "hire", [id, cli, model ?? "", role, persona], why.join(" | "));
      } else if (d.verb === "read") {
        // >> read: folder | why
        const folder = d.args.join(" ").trim();
        if (folder) this.suggest("assistant", "read", [folder], d.why);
      } else if (d.verb === "swap") {
        // >> swap: member | cli [model] | why
        const [cliModel = "", ...why] = d.why.split("|").map((x) => x.trim());
        const [cli, model] = cliModel.split(/\s+/);
        if (d.args[0] && cli) this.suggest("assistant", "swap", [d.args[0], cli, model ?? ""], why.join(" | "));
      } else if (d.args.length && d.args[0]) this.suggest("assistant", d.verb as SuggestionAction, d.args, d.why);
    }
  }

  /** The human asks the assistant something; the answer streams through `onDelta` and is logged as an aside. */
  async ask(question: string, onDelta?: (d: string) => void): Promise<string> {
    if (!question.trim()) throw new Error("ask something first");
    this.log({ type: "aside", from: "human", text: question.trim() });
    const context = this.assistantContext();
    let answer = "";
    await this.job("assistant", async () => {
      const reply = await this.oneShot("assistant", assistantAsk(context, question.trim(), this.actions()), ASSISTANT_SYSTEM, onDelta);
      if (reply === undefined) return;
      const { rest, blocks } = parseBlocks(reply, ASSISTANT_BLOCKS);
      const { prose, directives } = parseDirectives(rest, ASSISTANT_VERBS);
      const { answer: said, digest } = splitDigest(prose);
      answer = said;
      this.log({ type: "aside", from: "assistant", text: said || "(no answer)", kind: "answer" });
      if (digest && digest !== this.digest()) this.log({ type: "aside", from: "assistant", text: digest, kind: "digest" });
      this.assistantActions(directives, blocks);
    });
    return answer;
  }

  /** The assistant checks on the room by itself: it rewrites its digest, and leaves a note when something shifted. */
  watch(reason: string): Promise<void> {
    return this.job("watch", async () => {
      this.store.setMeta({ watchSeq: this.store.lastSeq });
      const reply = await this.oneShot("assistant", assistantWatch(this.assistantContext(), reason, this.actions()), ASSISTANT_SYSTEM);
      if (reply === undefined) return;
      const { rest, blocks } = parseBlocks(reply, ASSISTANT_BLOCKS);
      const { prose, directives } = parseDirectives(rest, ASSISTANT_VERBS);
      const { digest, note } = parseWatch(prose);
      if (digest && digest !== this.digest()) this.log({ type: "aside", from: "assistant", text: digest, kind: "digest" });
      if (note) this.log({ type: "aside", from: "assistant", text: note, kind: "note" });
      this.assistantActions(directives, blocks);
    });
  }
}

/** Raises the room's opening topic and puts it in focus. */
function openingTopic(store: RoomStore, topic: string): RoomEvent[] {
  const title = topic.split("\n")[0].slice(0, 80);
  const slug = slugify(title.split(/\s+/).slice(0, 5).join(" "));
  return [store.append({ type: "topic.raised", slug, title, by: "human" }), store.append({ type: "topic.focus", slug, by: "human" })];
}

const gitHead = (repo: string) => (): string | undefined => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
};

const ghIssue =
  (repo: string) =>
  (title: string, body: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const p = spawn("gh", ["issue", "create", "--title", title, "--body-file", "-"], { cwd: repo });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => reject(new Error(`gh: ${e.message}`)));
      p.on("close", (code) => (code === 0 ? resolve(out.trim().split("\n").at(-1) ?? "") : reject(new Error(err.trim() || `gh exited with ${code}`))));
      p.stdin.end(body);
    });

export type { MessageEvent };
