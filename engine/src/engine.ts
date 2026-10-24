import { loadPersona, type CouncilConfig, type PauseMode, type Persona } from "./config.js";
import { renderTranscript } from "./prompts.js";
import { parseChairReport } from "./protocols/chairReport.js";
import { getProtocol, type Prior, type Turn } from "./protocols/index.js";
import { Session } from "./session.js";
import type { AgentTransport } from "./transports/index.js";

/** Events the engine emits to whoever drives it (RPC server, headless runner, tests). */
export type EngineEvent =
  | { event: "config.changed"; data: { pause: PauseMode; rounds: number } }
  | { event: "round.start"; data: { round: number } }
  | { event: "turn.start"; data: { round: number; agent: string; artifact?: "plan" | "chair-report" } }
  | { event: "turn.delta"; data: { agent: string; delta: string } }
  | { event: "turn.tool"; data: { agent: string; name: string } }
  | { event: "turn.done"; data: { round: number; agent: string; text: string } }
  | { event: "usage"; data: { agent: string; quotaUtilization?: number; rateLimited?: boolean } }
  | { event: "plan.updated"; data: { round: number; text: string } }
  | {
      event: "chair.summary";
      data: { round: number; summary: string; converged: boolean; dissent: string; questions: string };
    }
  | { event: "round.done"; data: { round: number } }
  | { event: "awaiting_human"; data: { round: number; finished: boolean } }
  | { event: "error"; data: { agent?: string; message: string } };

export type TransportFor = (agentId: string) => AgentTransport;

export interface EngineOptions {
  config: CouncilConfig;
  topic: string;
  /** Target repo; the session is stored in its .quorum/ directory. */
  repo: string;
  transportFor: TransportFor;
  assetsDir?: string;
}

export class Engine {
  readonly session: Session;
  private readonly personas = new Map<string, Persona>();
  private readonly vendorSessions = new Map<string, string>();
  private readonly directives: string[] = [];
  private round = 0;
  private converged = false;
  /** What each turn produced this round, keyed by Turn.key, so later steps can build on it. */
  private roundOutputs: Prior = {};
  /** Steps of the current round not yet run (for pause = "message"). */
  private pending: Turn[][] = [];
  private abort = new AbortController();
  private listeners: ((e: EngineEvent) => void)[] = [];

  constructor(private readonly o: EngineOptions) {
    this.session = Session.create(o.repo, o.config, o.topic);
    for (const a of o.config.agents) this.personas.set(a.id, loadPersona(a.persona, o.assetsDir));
    this.personas.set("chair", loadPersona("chair", o.assetsDir));
  }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.push(listener);
    return () => (this.listeners = this.listeners.filter((l) => l !== listener));
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }

  get currentRound(): number {
    return this.round;
  }

  get finished(): boolean {
    return (this.converged || this.round >= this.o.config.rounds) && this.pending.length === 0;
  }

  /** Runs until the next pause point per config.pause, then emits awaiting_human. */
  async continue(): Promise<void> {
    this.abort = new AbortController();
    const { pause } = this.o.config;
    {
      while (!this.abort.signal.aborted) {
        if (this.pending.length === 0) {
          if (this.finished) break;
          this.startRound();
        }
        if (pause === "message") {
          // One turn at a time so the human can step in between any two messages.
          const step = this.pending[0];
          const turn = step.shift()!;
          if (step.length === 0) this.pending.shift();
          await this.runTurn(this.round, turn);
        } else {
          await Promise.all(this.pending.shift()!.map((t) => this.runTurn(this.round, t)));
        }
        const roundOver = this.pending.length === 0;
        if (roundOver && !this.abort.signal.aborted) this.emit({ event: "round.done", data: { round: this.round } });
        if (pause === "message" || (pause === "round" && roundOver)) break;
      }
    }
    // Only reached on success: a throw above surfaces to the caller instead of looking like a pause.
    if (!this.abort.signal.aborted) {
      this.emit({ event: "awaiting_human", data: { round: this.round, finished: this.finished } });
    }
  }

  private startRound(): void {
    this.round++;
    this.emit({ event: "round.start", data: { round: this.round } });
    this.roundOutputs = {};
    this.pending = getProtocol(this.o.config.protocol).planRound({
      round: this.round,
      totalRounds: this.o.config.rounds,
      topic: this.o.topic,
      agents: this.o.config.agents,
      roles: Object.fromEntries(this.o.config.agents.map((a) => [a.id, this.personas.get(a.id)?.role ?? "panelist"])),
      plan: this.session.read("plan.md"),
      transcript: this.session.transcript(),
      directives: [...this.directives],
      requireEvidence: this.o.config.requireEvidence,
    });
    this.directives.length = 0;
  }

  /**
   * Retunes pacing mid-session. Rounds can be raised or lowered but never below the round already
   * underway, so a finished council can be given more rounds and carry on.
   */
  configure(patch: { pause?: PauseMode; rounds?: number }): { pause: PauseMode; rounds: number } {
    const c = this.o.config;
    if (patch.pause !== undefined) {
      if (!["round", "message", "auto"].includes(patch.pause)) throw new Error('pause must be "round", "message" or "auto"');
      c.pause = patch.pause;
    }
    if (patch.rounds !== undefined) {
      const n = Math.trunc(Number(patch.rounds));
      if (!(n >= 1 && n <= 12)) throw new Error("rounds must be a whole number from 1 to 12");
      c.rounds = Math.max(n, this.round);
    }
    const now = { pause: c.pause, rounds: c.rounds };
    this.emit({ event: "config.changed", data: now });
    return now;
  }

  /** Human steering that the next round's protocol must honor. */
  steer(text: string): void {
    this.directives.push(text);
    this.session.append({ round: this.round, speaker: "human", text });
  }

  /** Free chat with one agent (or the Chair) at a pause; the exchange is recorded in the transcript. */
  async interject(to: string, text: string): Promise<string> {
    this.abort = new AbortController();
    this.session.append({ round: this.round, speaker: "human", text: `@${to} ${text}` });
    const chairExtra =
      to === "chair" ? `\n\n${renderTranscript(this.session.transcript(), 30)}\n\nThe human asks: ${text}` : "";
    const prompt = to === "chair" ? `Topic: ${this.o.topic}${chairExtra}` : `The human says to you: ${text}`;
    return this.runTurn(this.round, { agent: to, prompt });
  }

  stop(): void {
    this.abort.abort();
  }

  private async runTurn(round: number, turn: Turn): Promise<string> {
    const persona = this.personas.get(turn.agent);
    if (!persona) throw new Error(`unknown agent "${turn.agent}"`);
    const transport = this.o.transportFor(turn.agent);
    const prompt = typeof turn.prompt === "function" ? turn.prompt(this.roundOutputs) : turn.prompt;
    this.emit({ event: "turn.start", data: { round, agent: turn.agent, artifact: turn.artifact } });
    let text = "";
    for await (const e of transport.send(prompt, {
      cwd: this.o.repo,
      systemPrompt: persona.body,
      readOnly: this.o.config.readOnly,
      sessionId: this.vendorSessions.get(turn.agent),
      signal: this.abort.signal,
    })) {
      switch (e.type) {
        case "text":
          text += e.delta;
          this.emit({ event: "turn.delta", data: { agent: turn.agent, delta: e.delta } });
          break;
        case "tool":
          this.emit({ event: "turn.tool", data: { agent: turn.agent, name: e.name } });
          break;
        case "usage":
          if (e.quotaUtilization !== undefined || e.rateLimited)
            this.emit({
              event: "usage",
              data: { agent: turn.agent, quotaUtilization: e.quotaUtilization, rateLimited: e.rateLimited },
            });
          break;
        case "done":
          if (e.sessionId) this.vendorSessions.set(turn.agent, e.sessionId);
          break;
        case "error":
          this.emit({ event: "error", data: { agent: turn.agent, message: e.message } });
          break;
      }
    }
    if (text) {
      this.session.append({ round, speaker: turn.agent, text });
      this.roundOutputs[turn.key ?? turn.agent] = text;
      this.emit({ event: "turn.done", data: { round, agent: turn.agent, text } });
      this.applyArtifact(round, turn, text);
    }
    return text;
  }

  private applyArtifact(round: number, turn: Turn, text: string): void {
    if (turn.artifact === "plan") {
      this.session.write("plan.md", text);
      this.session.writeHistory(`plan-round-${round}.md`, text);
      this.emit({ event: "plan.updated", data: { round, text } });
    } else if (turn.artifact === "chair-report") {
      const r = parseChairReport(text);
      if (r.dissent && !/^none\.?$/i.test(r.dissent)) {
        this.session.write("dissent.md", `${this.session.read("dissent.md")}## Round ${round}\n\n${r.dissent}\n\n`);
      }
      this.session.write("open-questions.md", /^none\.?$/i.test(r.questions) ? "" : r.questions);
      this.converged = r.converged;
      this.emit({
        event: "chair.summary",
        data: { round, summary: r.summary, converged: r.converged, dissent: r.dissent, questions: r.questions },
      });
    }
  }
}
