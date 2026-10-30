import { execFileSync, spawn } from "node:child_process";
import { loadPersona, type AgentSpec, type CliName, type Persona } from "../config.js";
import type { AgentTransport, McpServerSpec } from "../transports/index.js";
import { parseDirectives, parseFileBlocks, type Directive } from "./directives.js";
import {
  ASSISTANT_SYSTEM,
  assistantAsk,
  assistantContext,
  assistantWatch,
  CHAIR_SYSTEM,
  chairPrompt,
  EXIT_MEMO,
  memberFresh,
  memberIncremental,
  renderEvents,
  SCRIBE_SYSTEM,
  scribePrompt,
  type RoomView,
} from "./prompts.js";
import { computeSignals, describeSignals, looksStuck } from "./signals.js";
import {
  RoomStore,
  slugify,
  visibleTo,
  type AgentState,
  type DocKind,
  type MessageEvent,
  type Recipient,
  type RoomConfig,
  type RoomEvent,
  type RoomEventBody,
  type RoomTuning,
  type SuggestionAction,
  type SupportSpec,
} from "./store.js";
import { newToken, ToolServer, type ToolHandler } from "./tools.js";

/** What a Room tells whoever drives it. `room.event` mirrors the log; the rest is live-only. */
export type RoomEmit =
  | { event: "room.event"; data: RoomEvent }
  | { event: "room.state"; data: { state: RoomState; reason?: string } }
  | { event: "room.turn.start"; data: { agent: string } }
  | { event: "room.turn.delta"; data: { agent: string; delta: string } }
  | { event: "room.turn.tool"; data: { agent: string; name: string } }
  | { event: "room.turn.end"; data: { agent: string } }
  | { event: "room.usage"; data: { agent: string; cli: string; quotaUtilization?: number; rateLimited?: boolean } };

/** paused: nobody is woken. running: turns underway. idle: running, but nobody has anything new to answer. */
export type RoomState = "paused" | "running" | "idle";

export type SupportRole = "assistant" | "chair" | "scribe";
export const SUPPORT_ROLES: SupportRole[] = ["assistant", "chair", "scribe"];

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
}

export interface NewRoom extends RoomOptions, Partial<RoomTuning> {
  topic: string;
  agents: AgentSpec[];
  /** Defaults to each role running on the first member's CLI. */
  support?: Partial<RoomConfig["support"]>;
}

/** How many recent events a member without a live vendor session is shown. */
const RECENT = 40;
/** A reply that is exactly this means "nothing new to add" and wakes nobody. */
const PASS = "PASS";
/** Messages one turn may send through the tools, so a member can't flood the room. */
const MAX_SPOKEN = 4;
/** Turns on one vendor session before it is dropped and the member's context rebuilt from files. */
const REFRESH = 12;
/** Member messages between runs of each support role. */
const EVERY = { scribe: 8, chair: 10, watch: 12 };

/** A turn in progress that may call the room tools. */
interface LiveTurn {
  agent: string;
  ctrl: AbortController;
  spoke: number;
  passed: boolean;
}

/** Log events members aren't shown: bookkeeping that would only distract them. */
const MEMBER_NOISE = new Set<RoomEvent["type"]>(["pass", "docs.updated", "turn.failed", "paused", "resumed"]);

const CHAIR_VERBS = ["accept", "nudge", "raise", "focus", "close"] as const;
const ASSISTANT_VERBS = ["steer", "add", "remove", "focus", "close", "parallel", "pause"] as const;

/**
 * A long-running discussion. Members are not processes: each is an identity with persisted state,
 * and the scheduler runs a turn for it whenever something it can see arrives that it hasn't read.
 * That makes pause, resume after a restart, and changing the roster all the same operation:
 * deciding whom to wake next. Three support roles run beside the members: the Chair moderates,
 * the scribe keeps the shared notes, and the assistant works for the human.
 */
export class Room {
  private readonly personas = new Map<string, Persona>();
  private readonly running = new Map<string, AbortController>();
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
  private _state: RoomState = "paused";

  private constructor(
    readonly store: RoomStore,
    private readonly o: RoomOptions,
  ) {
    for (const a of store.config().agents) this.personas.set(a.id, loadPersona(a.persona, o.assetsDir));
  }

  /** Creates a paused room whose first message is the topic; call resume() to start it. */
  static create(o: NewRoom): Room {
    const first: SupportSpec = { cli: o.agents[0]?.cli ?? "mock" };
    const store = RoomStore.create(o.repo, {
      topic: o.topic,
      agents: o.agents,
      left: [],
      support: { assistant: first, chair: first, scribe: first, ...o.support },
      parallel: o.parallel ?? 2,
      turnCap: o.turnCap ?? 40,
      quotaWarn: o.quotaWarn ?? 0.75,
      quotaStop: o.quotaStop ?? 0.9,
    });
    const title = o.topic.split("\n")[0].slice(0, 80);
    const slug = slugify(title.split(/\s+/).slice(0, 5).join(" "));
    store.append({ type: "topic.raised", slug, title, by: "human" });
    store.append({ type: "topic.focus", slug, by: "human" });
    store.append({ type: "message", from: "human", to: "room", text: o.topic });
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

  /** Members currently mid-turn. */
  get speaking(): string[] {
    return [...this.running.keys()];
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
    return { topic: this.store.config().topic, focus: this.focus(), topics: this.topics(), docs: this.docs(), members: this.members() };
  }

  /** Suggestions the human hasn't answered yet. */
  pending(): Extract<RoomEvent, { type: "suggestion" }>[] {
    const done = new Set(this.store.events().flatMap((e) => (e.type === "suggestion.resolved" ? [e.id] : [])));
    return this.store.events().flatMap((e) => (e.type === "suggestion" && !done.has(e.id) ? [e] : []));
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
    if ((SUPPORT_ROLES as string[]).includes(id)) return { id, ...c.support[id as SupportRole] };
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
    this.kick();
  }

  /** Stops waking members and aborts turns underway; aborted turns are redone after resume(). */
  pause(reason = "paused by the human"): void {
    if (this._state === "paused") return;
    this.setState("paused", reason);
    this.log({ type: "paused", reason });
    for (const c of this.running.values()) c.abort();
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
    const { parallel, turnCap, quotaWarn, quotaStop } = this.store.updateConfig(patch);
    this.kick();
    return { parallel, turnCap, quotaWarn, quotaStop };
  }

  /** The human speaks: to the whole room, or privately to one member. */
  post(text: string, to: Recipient = "room"): RoomEvent {
    if (!text.trim()) throw new Error("say something first");
    if (to !== "room" && !this.personas.has(to)) throw new Error(`unknown member "${to}"`);
    const e = this.log({ type: "message", from: "human", to, text: text.trim() });
    this.kick();
    return e;
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

  /** Brings in a new member, or brings back one who left. It wakes at once to catch up. */
  addMember(o: { persona: string; cli: CliName; model?: string; id?: string }): string {
    const c = this.store.config();
    const back = (c.left ?? []).find((a) => a.id === (o.id ?? o.persona));
    if (back && !o.id && back.cli === o.cli && back.model === o.model) return this.rejoin(back.id);
    const persona = loadPersona(o.persona, this.o.assetsDir);
    const taken = new Set([...c.agents, ...(c.left ?? [])].map((a) => a.id).concat(SUPPORT_ROLES, ["human", "room"]));
    let id = o.id ?? o.persona;
    if (o.id && taken.has(id)) throw new Error(`"${id}" is already taken`);
    for (let n = 2; taken.has(id); n++) id = `${o.persona}-${n}`;
    const spec: AgentSpec = { id, cli: o.cli, persona: o.persona, ...(o.model ? { model: o.model } : {}) };
    this.store.setRoster([...c.agents, spec], c.left ?? []);
    this.personas.set(id, persona);
    this.log({ type: "agent.joined", agent: id, persona: o.persona, cli: o.cli, ...(o.model ? { model: o.model } : {}) });
    this.kick();
    return id;
  }

  /** Brings back a member who left, with its notebook; it rebuilds its context on its next turn. */
  rejoin(id: string): string {
    const c = this.store.config();
    const spec = (c.left ?? []).find((a) => a.id === id);
    if (!spec) throw new Error(`"${id}" hasn't left the room`);
    this.store.setRoster([...c.agents, spec], (c.left ?? []).filter((a) => a.id !== id));
    this.store.archiveNotebook(id, false);
    const st = this.store.agentState(id);
    this.store.saveAgentState(id, { ...st, sessionId: undefined, sessionTurns: 0 });
    this.personas.set(id, loadPersona(spec.persona, this.o.assetsDir));
    this.log({ type: "agent.joined", agent: id, persona: spec.persona, cli: spec.cli, ...(spec.model ? { model: spec.model } : {}) });
    this.kick();
    return id;
  }

  /** A member leaves after writing an exit memo (skipped with memo = false). Its notebook is archived. */
  async removeMember(id: string, memo = true): Promise<void> {
    if (!this.personas.has(id)) throw new Error(`no member "${id}"`);
    this.leaving.add(id);
    this.running.get(id)?.abort();
    let text: string | undefined;
    if (memo) {
      const st = this.store.agentState(id);
      const prompt = st.sessionId ? EXIT_MEMO : `${renderEvents(this.store.events().filter((e) => visibleTo(id, e)).slice(-RECENT))}\n\n${EXIT_MEMO}`;
      text = (await this.oneShot(id, prompt, this.personas.get(id)!.body, undefined, st.sessionId))?.trim();
      if (text) this.store.writeNotebook(id, `${this.store.notebook(id)}\n\n## Exit memo\n\n${text}`);
    }
    const c = this.store.config();
    const spec = c.agents.find((a) => a.id === id)!;
    this.store.setRoster(c.agents.filter((a) => a.id !== id), [...(c.left ?? []).filter((a) => a.id !== id), spec]);
    this.store.archiveNotebook(id, true);
    this.personas.delete(id);
    this.leaving.delete(id);
    this.log({ type: "agent.left", agent: id, ...(text ? { memo: text } : {}) });
    this.kick();
  }

  /** The human answers a suggestion; an approved one is carried out at once. */
  async resolve(id: number, accept: boolean): Promise<void> {
    const s = this.pending().find((x) => x.id === id);
    if (!s) throw new Error(`no open suggestion ${id}`);
    if (accept) await this.apply(s.action, s.args, s.why);
    this.log({ type: "suggestion.resolved", id, accepted: accept });
  }

  private async apply(action: SuggestionAction, args: string[], why: string): Promise<void> {
    switch (action) {
      case "steer":
        this.post(args[0]);
        return;
      case "add":
        this.addMember({ persona: args[0], cli: args[1] as CliName, model: args[2] });
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

  private suggest(from: "assistant" | "chair", action: SuggestionAction, args: string[], why: string): void {
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
    if (this.running.size || this.busy.size || this._state === "running") return;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  // ---- scheduling ----

  /** Whether an unread event should wake `agent`. Notes on parked topics wake nobody. */
  private wakes(agent: string, e: RoomEvent, focus?: string): boolean {
    if (e.type !== "message" || e.from === agent || !visibleTo(agent, e)) return false;
    if (e.to === agent || e.from === "human" || e.from === "chair") return true;
    return !e.topic || e.topic === focus;
  }

  /** Members not mid-turn with something unread that should wake them. */
  private wakeable(): string[] {
    const events = this.store.events();
    const focus = this.focus();
    return this.members().filter((agent) => {
      if (this.running.has(agent) || this.leaving.has(agent)) return false;
      // seq n is at index n - 1, so the unread events start at index lastRead.
      return events.slice(this.store.agentState(agent).lastRead).some((e) => this.wakes(agent, e, focus));
    });
  }

  /** CLIs without a quota report are held to the turn cap per resume. */
  private capped(cli: string): boolean {
    return !this.quota.has(cli) && (this.turnsByCli.get(cli) ?? 0) >= this.store.config().turnCap;
  }

  /** Fills free slots with woken members; pauses when the turn cap stops work that's waiting. */
  private kick(): void {
    if (this._state === "paused") return;
    const { parallel, turnCap } = this.store.config();
    const waiting = this.wakeable();
    for (const agent of waiting) {
      if (this.running.size >= parallel) break;
      const { cli } = this.spec(agent);
      if (this.capped(cli)) continue;
      this.turnsByCli.set(cli, (this.turnsByCli.get(cli) ?? 0) + 1);
      const ctrl = new AbortController();
      this.running.set(agent, ctrl);
      void this.turn(agent, ctrl);
    }
    if (this.running.size) return this.setState("running");
    if (waiting.length) {
      const clis = [...new Set(waiting.map((a) => this.spec(a).cli))];
      return this.pause(`turn cap reached (${turnCap} turns each for ${clis.join(", ")})`);
    }
    this.setState("idle");
    // A quiet room is the Chair's cue, if anything happened since it last looked.
    if (this.memberMessagesAfter(Number(this.store.meta().chairSeq ?? 0)) > 0) void this.runChair("everyone has had their say and the room went quiet");
    if (this.memberMessagesAfter(Number(this.store.meta().scribeSeq ?? 0)) > 0) void this.runScribe();
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

  private async turn(agent: string, ctrl: AbortController): Promise<void> {
    let st = this.store.agentState(agent);
    // Long vendor sessions get compacted unpredictably; past REFRESH turns, rebuild from files instead.
    if (st.sessionId && (st.sessionTurns ?? 0) >= REFRESH) st = { ...st, sessionId: undefined, sessionTurns: 0 };
    const upTo = this.store.lastSeq;
    const spec = this.spec(agent);
    const transport = this.o.transports(spec);
    const token = newToken();
    const turn: LiveTurn = { agent, ctrl, spoke: 0, passed: false };
    let mcp: McpServerSpec | undefined;
    if (transport.supportsMcp) {
      this.tools ??= ToolServer.start(this.callTool);
      try {
        mcp = (await this.tools).spec(token);
        this.live.set(token, turn);
      } catch {
        // Without the tool server the member still speaks through its reply text.
        this.tools = undefined;
      }
    }
    this.emit({ event: "room.turn.start", data: { agent } });
    let text = "";
    let failed: string | undefined;
    let sessionId = st.sessionId;
    try {
      for await (const e of transport.send(this.memberPrompt(agent, st, upTo, Boolean(mcp)), {
        cwd: this.o.repo,
        systemPrompt: this.personas.get(agent)?.body,
        readOnly: this.o.readOnly ?? true,
        sessionId: st.sessionId,
        signal: ctrl.signal,
        mcp,
      })) {
        if (e.type === "text") {
          text += e.delta;
          this.emit({ event: "room.turn.delta", data: { agent, delta: e.delta } });
        } else if (e.type === "tool") this.emit({ event: "room.turn.tool", data: { agent, name: e.name } });
        else if (e.type === "usage") this.usage(agent, spec.cli, e.quotaUtilization, e.rateLimited);
        else if (e.type === "done" && e.sessionId) sessionId = e.sessionId;
        else if (e.type === "error") failed = e.message;
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    this.running.delete(agent);
    this.live.delete(token);
    this.emit({ event: "room.turn.end", data: { agent } });
    // An aborted turn leaves lastRead alone, so the member is woken for the same messages on resume.
    if (ctrl.signal.aborted) {
      this.settle();
      return;
    }
    const reply = text.trim();
    const usedTools = turn.spoke > 0 || turn.passed;
    // A member who spoke through the tools used its final reply as scratch; nobody sees it.
    if (failed && (usedTools || !reply)) {
      if (!usedTools) this.log({ type: "turn.failed", agent, message: failed });
      // A vendor session that broke the turn is dropped; the next wake rebuilds context from the log.
      sessionId = undefined;
    } else if (!usedTools) {
      if (reply === PASS) this.log({ type: "pass", from: agent });
      else {
        this.log({ type: "message", from: agent, to: "room", text: reply });
        this.afterMessage();
      }
    }
    const fresh = sessionId !== st.sessionId;
    // Advancing lastRead even on failure keeps a broken member from being re-woken in a hot loop.
    this.store.saveAgentState(agent, {
      sessionId,
      sessionTurns: sessionId ? (fresh ? 1 : (st.sessionTurns ?? 0) + 1) : 0,
      lastRead: upTo,
      turns: st.turns + 1,
    });
    this.kick();
  }

  /** Quota reports drive the hard budget: warn once per resume, pause at the stop line. */
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

  private memberPrompt(agent: string, st: AgentState, upTo: number, tools: boolean): string {
    const events = this.store.events().slice(0, upTo);
    const seen = events.filter((e) => visibleTo(agent, e) && !MEMBER_NOISE.has(e.type));
    const view = this.view();
    if (st.sessionId) {
      return memberIncremental({ view, recent: seen.filter((e) => e.seq > st.lastRead), tools, maxSpoken: MAX_SPOKEN });
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
      maxSpoken: MAX_SPOKEN,
    });
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
    const speak = () => {
      if (turn.spoke >= MAX_SPOKEN) throw new Error(`at most ${MAX_SPOKEN} messages per turn; wait for replies`);
      turn.spoke++;
    };
    switch (name) {
      case "post":
      case "dm": {
        if (!text) throw new Error("text is required");
        const to = name === "dm" ? String(args.to ?? "") : "room";
        if (name === "dm" && (to === agent || (to !== "human" && !this.personas.has(to))))
          throw new Error(`no member "${to}"; members are ${["human", ...this.members()].filter((a) => a !== agent).join(", ")}`);
        let replyTo: number | undefined;
        if (name === "post" && args.reply_to !== undefined) {
          replyTo = Number(args.reply_to);
          const target = this.store.events()[replyTo - 1];
          if (target?.type !== "message" || !visibleTo(agent, target)) throw new Error(`no message #${args.reply_to}`);
        }
        let topic: string | undefined;
        if (name === "post" && args.topic !== undefined && args.topic !== this.focus()) {
          topic = String(args.topic);
          const t = this.topics().find((x) => x.slug === topic);
          if (!t || t.closed) throw new Error(`no open topic "${topic}"; open topics are ${this.topics().filter((x) => !x.closed).map((x) => x.slug).join(", ")}`);
        }
        speak();
        const e = this.log({ type: "message", from: agent, to, text, ...(replyTo ? { replyTo } : {}), ...(topic ? { topic } : {}) });
        this.afterMessage();
        this.kick();
        return `Sent as #${e.seq}.`;
      }
      case "pass":
        if (!turn.spoke && !turn.passed) this.log({ type: "pass", from: agent });
        turn.passed = true;
        return "Passed. You will be woken when there is something new.";
      case "raise_topic": {
        speak();
        const slug = this.raiseTopic(String(args.title ?? ""), agent, typeof args.why === "string" ? args.why : undefined);
        return `Raised as ${slug}. It is parked until the Chair and the human give it focus.`;
      }
      case "doc_draft": {
        const slug = slugify(String(args.name ?? ""));
        if (!text) throw new Error("text is required: the whole document");
        const kind = (["plan", "issue", "decision", "other"].includes(String(args.kind)) ? args.kind : (this.docs().find((d) => d.slug === slug)?.kind ?? "other")) as DocKind;
        speak();
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
      for await (const e of this.o.transports(spec).send(prompt, { cwd: this.o.repo, systemPrompt, readOnly: true, sessionId, signal })) {
        if (e.type === "text") {
          text += e.delta;
          onDelta?.(e.delta);
        } else if (e.type === "usage") this.usage(id, spec.cli, e.quotaUtilization, e.rateLimited);
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
    try {
      await fn();
    } finally {
      this.busy.delete(name);
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
        this.kick();
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
            this.kick();
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

  private assistantContext(): string {
    const pending = this.pending()
      .map((p) => `${p.id}. ${p.action} ${p.args.join(" ")} (from ${p.from}${p.why ? `: ${p.why}` : ""})`)
      .join("\n");
    const budget = [...this.quota].map(([cli, q]) => `${cli} at ${Math.round(q * 100)}% of its quota window`).join("; ");
    const notes = (["decisions.md", "open-questions.md"] as const).flatMap((p): [string, string][] => (this.store.readDoc(p).trim() ? [[p, this.store.readDoc(p)]] : []));
    const recent = renderEvents(this.store.events().filter((e) => e.type !== "docs.updated").slice(-60), this.focus());
    return assistantContext({ view: this.view(), signals: describeSignals(this.signals()), budget, notes, recent, pending });
  }

  /** Applies the assistant's action lines: a pause at once, everything else as a suggestion. */
  private assistantActions(directives: Directive[]): void {
    for (const d of directives) {
      if (d.verb === "pause") this.pause(`assistant: ${d.args[0] || "pausing for you"}`);
      else if (d.args.length && d.args[0]) this.suggest("assistant", d.verb as SuggestionAction, d.args, d.why);
    }
  }

  /** The human asks the assistant something; the answer streams through `onDelta` and is logged as an aside. */
  async ask(question: string, onDelta?: (d: string) => void): Promise<string> {
    if (!question.trim()) throw new Error("ask something first");
    this.log({ type: "aside", from: "human", text: question.trim() });
    const context = this.assistantContext();
    let answer = "";
    await this.job("assistant", async () => {
      const reply = await this.oneShot("assistant", assistantAsk(context, question.trim()), ASSISTANT_SYSTEM, onDelta);
      if (reply === undefined) return;
      const { prose, directives } = parseDirectives(reply, ASSISTANT_VERBS);
      answer = prose;
      this.log({ type: "aside", from: "assistant", text: prose || "(no answer)", kind: "answer" });
      this.assistantActions(directives);
    });
    return answer;
  }

  /** The assistant checks on the room by itself and leaves the human a note when there's something to say. */
  watch(reason: string): Promise<void> {
    return this.job("watch", async () => {
      this.store.setMeta({ watchSeq: this.store.lastSeq });
      const reply = await this.oneShot("assistant", assistantWatch(this.assistantContext(), reason), ASSISTANT_SYSTEM);
      if (reply === undefined) return;
      const { prose, directives } = parseDirectives(reply, ASSISTANT_VERBS);
      if (prose && prose !== "NOTHING") this.log({ type: "aside", from: "assistant", text: prose, kind: "note" });
      this.assistantActions(directives);
    });
  }
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
