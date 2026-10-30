import { loadPersona, type AgentSpec, type Persona } from "../config.js";
import type { TransportFor } from "../engine.js";
import { RoomStore, visibleTo, type AgentState, type Recipient, type RoomEvent } from "./store.js";

/** What a Room tells whoever drives it. `room.event` mirrors the log; the rest is live-only. */
export type RoomEmit =
  | { event: "room.event"; data: RoomEvent }
  | { event: "room.state"; data: { state: RoomState; reason?: string } }
  | { event: "room.turn.start"; data: { agent: string } }
  | { event: "room.turn.delta"; data: { agent: string; delta: string } }
  | { event: "room.turn.tool"; data: { agent: string; name: string } }
  | { event: "room.usage"; data: { agent: string; quotaUtilization?: number; rateLimited?: boolean } };

/** paused: nobody is woken. running: turns underway. idle: running, but nobody has anything new to answer. */
export type RoomState = "paused" | "running" | "idle";

export interface RoomOptions {
  /** Target repo; the room is stored in its .quorum/ directory. */
  repo: string;
  transportFor: TransportFor;
  assetsDir?: string;
  readOnly?: boolean;
}

export interface NewRoom extends RoomOptions {
  topic: string;
  agents: AgentSpec[];
  parallel?: number;
  turnCap?: number;
}

/** How many recent messages an agent without a live vendor session is shown. */
const RECENT = 40;
/** A reply that is exactly this means "nothing new to add" and wakes nobody. */
const PASS = "PASS";

/**
 * A long-running discussion. Agents are not processes: each is an identity with persisted state,
 * and the scheduler runs a turn for it whenever something it can see arrives that it hasn't read.
 * That makes pause, resume after a restart, and changing the roster all the same operation:
 * deciding whom to wake next.
 */
export class Room {
  private readonly personas = new Map<string, Persona>();
  private readonly running = new Map<string, AbortController>();
  private listeners: ((e: RoomEmit) => void)[] = [];
  private waiters: (() => void)[] = [];
  private turnsThisResume = 0;
  private _state: RoomState = "paused";

  private constructor(
    readonly store: RoomStore,
    private readonly o: RoomOptions,
  ) {
    for (const a of store.config().agents) this.personas.set(a.id, loadPersona(a.persona, o.assetsDir));
  }

  /** Creates a paused room whose first message is the topic; call resume() to start it. */
  static create(o: NewRoom): Room {
    const store = RoomStore.create(o.repo, {
      topic: o.topic,
      agents: o.agents,
      parallel: o.parallel ?? 2,
      turnCap: o.turnCap ?? 40,
    });
    store.append({ type: "message", from: "human", to: "room", text: o.topic });
    return new Room(store, o);
  }

  /** Reopens a saved room, paused. Agents pick up from their saved state on resume(). */
  static open(id: string, o: RoomOptions): Room {
    return new Room(RoomStore.open(o.repo, id), o);
  }

  get id(): string {
    return this.store.id;
  }

  get state(): RoomState {
    return this._state;
  }

  on(listener: (e: RoomEmit) => void): () => void {
    this.listeners.push(listener);
    return () => (this.listeners = this.listeners.filter((l) => l !== listener));
  }

  private emit(e: RoomEmit): void {
    for (const l of this.listeners) l(e);
  }

  private log(body: Parameters<RoomStore["append"]>[0]): RoomEvent {
    const e = this.store.append(body);
    this.emit({ event: "room.event", data: e });
    return e;
  }

  private setState(state: RoomState, reason?: string): void {
    if (state === this._state) return;
    this._state = state;
    this.emit({ event: "room.state", data: { state, ...(reason ? { reason } : {}) } });
  }

  /** Retunes pacing; a higher parallel cap takes effect at once. */
  configure(patch: { parallel?: number; turnCap?: number }): { parallel: number; turnCap: number } {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && !(Number.isInteger(v) && v >= 1)) throw new Error(`${k} must be a whole number of at least 1`);
    }
    const { parallel, turnCap } = this.store.updateConfig(patch);
    this.kick();
    return { parallel, turnCap };
  }

  resume(): void {
    if (this._state !== "paused") return;
    this.turnsThisResume = 0;
    this.log({ type: "resumed" });
    this.setState("running");
    this.kick();
  }

  /** Stops waking agents and aborts turns underway; aborted turns are redone after resume(). */
  pause(reason = "paused by the human"): void {
    if (this._state === "paused") return;
    this.setState("paused", reason);
    this.log({ type: "paused", reason });
    for (const c of this.running.values()) c.abort();
    this.settle();
  }

  /** The human speaks: to the whole room, or privately to one agent. */
  post(text: string, to: Recipient = "room"): RoomEvent {
    if (to !== "room" && !this.personas.has(to)) throw new Error(`unknown agent "${to}"`);
    const e = this.log({ type: "message", from: "human", to, text });
    this.kick();
    return e;
  }

  /** Resolves once no turn is running and the room is paused or idle. */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.settle();
    });
  }

  private settle(): void {
    if (this.running.size || this._state === "running") return;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  /** Agents not mid-turn with an unread message from someone else that they are allowed to see. */
  private wakeable(): string[] {
    const events = this.store.events();
    return [...this.personas.keys()].filter((agent) => {
      if (this.running.has(agent)) return false;
      const { lastRead } = this.store.agentState(agent);
      return events.some((e) => e.seq > lastRead && e.type === "message" && e.from !== agent && visibleTo(agent, e));
    });
  }

  /** Fills free slots with woken agents; pauses the room when the turn cap stops work that's waiting. */
  private kick(): void {
    if (this._state === "paused") return;
    const { parallel, turnCap } = this.store.config();
    const waiting = this.wakeable();
    for (const agent of waiting) {
      if (this.running.size >= parallel || this.turnsThisResume >= turnCap) break;
      this.turnsThisResume++;
      const ctrl = new AbortController();
      this.running.set(agent, ctrl);
      void this.turn(agent, ctrl);
    }
    if (this.running.size) return this.setState("running");
    if (waiting.length && this.turnsThisResume >= turnCap) return this.pause(`turn cap reached (${turnCap} turns)`);
    this.setState("idle");
    this.settle();
  }

  private async turn(agent: string, ctrl: AbortController): Promise<void> {
    const st = this.store.agentState(agent);
    const upTo = this.store.lastSeq;
    this.emit({ event: "room.turn.start", data: { agent } });
    let text = "";
    let failed: string | undefined;
    let sessionId = st.sessionId;
    try {
      for await (const e of this.o.transportFor(agent).send(this.prompt(agent, st, upTo), {
        cwd: this.o.repo,
        systemPrompt: this.personas.get(agent)!.body,
        readOnly: this.o.readOnly ?? true,
        sessionId: st.sessionId,
        signal: ctrl.signal,
      })) {
        if (e.type === "text") {
          text += e.delta;
          this.emit({ event: "room.turn.delta", data: { agent, delta: e.delta } });
        } else if (e.type === "tool") this.emit({ event: "room.turn.tool", data: { agent, name: e.name } });
        else if (e.type === "usage" && (e.quotaUtilization !== undefined || e.rateLimited))
          this.emit({ event: "room.usage", data: { agent, quotaUtilization: e.quotaUtilization, rateLimited: e.rateLimited } });
        else if (e.type === "done" && e.sessionId) sessionId = e.sessionId;
        else if (e.type === "error") failed = e.message;
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    this.running.delete(agent);
    // An aborted turn leaves lastRead alone, so the agent is woken for the same messages on resume.
    if (ctrl.signal.aborted) return this.settle();
    const reply = text.trim();
    if (failed && !reply) {
      this.log({ type: "turn.failed", agent, message: failed });
      // A vendor session that broke the turn is dropped; the next wake rebuilds context from the log.
      sessionId = undefined;
    } else if (reply === PASS) this.log({ type: "pass", from: agent });
    else this.log({ type: "message", from: agent, to: "room", text: reply });
    // Advancing lastRead even on failure keeps a broken agent from being re-woken in a hot loop.
    this.store.saveAgentState(agent, { sessionId, lastRead: upTo, turns: st.turns + 1 });
    this.kick();
  }

  /**
   * With a live vendor session the agent already remembers the room, so it gets only what's new.
   * Without one (first turn, or after a failure) it is rebuilt from the log.
   */
  private prompt(agent: string, st: AgentState, upTo: number): string {
    const { topic } = this.store.config();
    const seen = this.store.events().filter((e) => e.seq <= upTo && e.type === "message" && visibleTo(agent, e));
    const render = (es: RoomEvent[]) => es.map((e) => (e.type === "message" ? renderMessage(e) : "")).join("\n\n");
    const rules = [
      `Each time you speak, add something: a claim, evidence (cite files and lines), a question, or a disagreement.`,
      `Keep it short, a few paragraphs at most. Name the member you are answering.`,
      `If you have nothing new to add, reply with exactly ${PASS}.`,
    ].join(" ");
    if (st.sessionId) {
      return [`New in the room since your last turn:`, render(seen.filter((e) => e.seq > st.lastRead)), rules].join("\n\n");
    }
    const others = [...this.personas.keys()].filter((a) => a !== agent);
    return [
      `You are ${agent}, one member of a Quorum room: a standing discussion between AI agents and a human.`,
      `Other members: ${others.join(", ") || "none yet"}. Members speak in parallel; you are woken whenever there is something new for you.`,
      `Topic: ${topic}`,
      seen.length > RECENT ? `The room so far (latest ${RECENT} of ${seen.length} messages):` : `The room so far:`,
      render(seen.slice(-RECENT)),
      rules,
    ].join("\n\n");
  }
}

function renderMessage(e: Extract<RoomEvent, { type: "message" }>): string {
  const to = e.to === "room" ? "" : ` → ${e.to} (private)`;
  return `[#${e.seq}] ${e.from}${to}:\n${e.text}`;
}
