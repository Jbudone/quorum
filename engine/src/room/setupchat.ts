import { listPersonas, type AgentSpec, type CliName } from "../config.js";
import { parseBlocks } from "./directives.js";
import { accessNote, parseSetup, setupPrompt, SETUP_SYSTEM, type PlanQuestion, type SetupProposal } from "./prompts.js";
import { grantableDir, Room, type RoomOptions } from "./room.js";
import type { RoomConfig, SupportSpec } from "./store.js";
import { noteVendorSession } from "./vendorlog.js";
import { readingPath, Workspace } from "./workspace.js";

/**
 * A planning session with the assistant. For a new channel there's no channel until the human
 * approves the plan; for an existing one (`room`), the plan is applied to it. The assistant narrows
 * the problem down with choice-card questions, then proposes a plan: vision, considerations, reading,
 * members (invented for the problem, or workspace members with their memory), starter workstreams.
 */
export class SetupChat {
  readonly history: { from: "human" | "assistant"; text: string }[] = [];
  proposal?: SetupProposal;
  /** Records the assistant wrote before there was a channel to keep them in. */
  private readonly drafts: { name: string; text: string; note?: string }[] = [];
  /** Folders outside the repo the human let the assistant read, before there's a channel to keep them. */
  private readonly granted: string[] = [];

  constructor(
    private readonly o: RoomOptions & { support: Required<RoomConfig["support"]>; clis: string[]; room?: Room },
  ) {}

  /** The channel this session plans, when it isn't planning a new one. */
  get forRoom(): Room | undefined {
    return this.o.room;
  }

  /** Folders outside the repo the assistant (and later the channel) may read. */
  dirs(): string[] {
    return this.o.room?.dirs() ?? this.granted;
  }

  /** The human lets the assistant read a folder outside the repo; a new channel keeps it. */
  allowRead(path: string): string {
    if (this.o.room) return this.o.room.allowRead(path, "human");
    const dir = grantableDir(path, this.o.repo);
    if (!this.granted.includes(dir)) this.granted.push(dir);
    return dir;
  }

  /** The human says something; the assistant's reply streams through `onDelta`. */
  async say(text: string, onDelta?: (d: string) => void, signal?: AbortSignal): Promise<{ text: string; questions: PlanQuestion[]; proposal?: SetupProposal }> {
    if (!text.trim()) throw new Error("say something first");
    this.history.push({ from: "human", text: text.trim() });
    const ws = new Workspace(this.o.repo);
    const room = this.o.room;
    const spec: SupportSpec = this.o.support.assistant;
    const prompt = setupPrompt({
      repo: this.o.repo,
      members: ws.members().filter((m) => !room?.view().members.includes(m.id)),
      channels: ws.channels().map((c) => c.name || c.id),
      clis: this.o.clis,
      personas: listPersonas(this.o.assetsDir).map((p) => p.key),
      history: this.history,
      models: this.o.modelMenu?.(),
      ...(room ? { channel: room.brief() } : {}),
    });
    let reply = "";
    let failed: string | undefined;
    for await (const e of this.o.transports({ id: "assistant", ...spec }).send(prompt, { cwd: this.o.repo, dirs: this.dirs(), systemPrompt: `${SETUP_SYSTEM}\n\n${accessNote(this.o.repo, this.dirs())}`, readOnly: true, signal })) {
      if (e.type === "text") {
        reply += e.delta;
        onDelta?.(e.delta);
      } else if (e.type === "done" && e.sessionId) noteVendorSession(this.o.repo, { ...(room ? { room: room.id } : {}), agent: "assistant", cli: spec.cli, ...(spec.model ? { model: spec.model } : {}), session: e.sessionId });
      else if (e.type === "error") failed = e.message;
    }
    if (!reply.trim()) throw new Error(failed ?? "the assistant didn't answer");
    // Records it writes are kept: in the channel being planned, or until the new one opens.
    const { rest, blocks } = parseBlocks(reply, ["write"]);
    for (const b of blocks) {
      const doc = { name: b.args[0], text: b.args.at(-1) ?? "", ...(b.why ? { note: b.why } : {}) };
      if (!doc.name || !doc.text.trim()) continue;
      if (room) room.writeDoc(doc.name, doc.text, "assistant", doc.note);
      else this.drafts.push(doc);
    }
    const { prose, questions, proposal } = parseSetup(rest);
    if (proposal) {
      // Spell out the model a member would get by default, so the plan shows what will run.
      // A returning member keeps the model it had.
      const known = new Map(new Workspace(this.o.repo).members().map((w) => [w.id, w]));
      for (const m of proposal.members) {
        const model = m.cli && !m.model && !known.get(m.id)?.model ? this.o.defaultModel?.(m.cli) : undefined;
        if (model) m.model = model;
      }
      this.proposal = proposal;
    }
    this.history.push({ from: "assistant", text: reply.trim() });
    return { text: prose, questions, ...(proposal ? { proposal } : {}) };
  }

  /** Members a plan brings in, as channel specs: new ones join the workspace with their invented persona. */
  private specs(p: SetupProposal): AgentSpec[] {
    const ws = new Workspace(this.o.repo);
    const known = new Map(ws.members().map((m) => [m.id, m]));
    return p.members.map((m) => {
      const old = known.get(m.id);
      const web = m.web ? { web: true } : {};
      if (old && !m.persona) return { id: old.id, persona: old.persona, cli: (m.cli as CliName) ?? old.cli, ...((m.model ?? old.model) ? { model: m.model ?? old.model } : {}), ...web };
      const cli = (m.cli ?? old?.cli) as CliName | undefined;
      if (!cli || !this.o.clis.includes(cli)) throw new Error(`${m.id} needs a CLI from ${this.o.clis.join(", ")}`);
      if (!m.persona && !old) throw new Error(`${m.id} needs a persona`);
      if (m.persona) ws.writePersona(m.id, { name: m.id, role: m.role ?? m.id, body: m.persona });
      const spec: AgentSpec = { id: m.id, persona: m.persona ? m.id : old!.persona, cli, ...(m.model ? { model: m.model } : {}) };
      ws.saveMember({ ...spec, role: m.role ?? old?.role });
      return { ...spec, ...web };
    });
  }

  /** Keeps the reading list entries that exist; reports the rest. */
  private reading(paths: string[]): { reading: string[]; skipped: string[] } {
    const reading: string[] = [];
    const skipped: string[] = [];
    for (const p of paths) {
      try {
        reading.push(readingPath(this.o.repo, p));
      } catch {
        skipped.push(p);
      }
    }
    return { reading, skipped };
  }

  /**
   * Creates a new channel from a plan (the latest by default). Members without a workstream give a
   * first take; the workstreams start right away with their owners.
   */
  create(proposal = this.proposal, tuning: { parallel?: number; turnCap?: number } = {}): { room: Room; skipped: string[] } {
    if (!proposal?.members.length) throw new Error("there's no plan yet; tell the assistant about the problem first");
    const agents = this.specs(proposal);
    const { reading, skipped } = this.reading(proposal.reading);
    const owned = new Set(proposal.topics.flatMap((t) => t.members));
    const topic = proposal.topic ?? this.history.find((h) => h.from === "human")?.text ?? "";
    const room = Room.create({
      ...this.o,
      ...tuning,
      topic,
      name: proposal.name,
      reading,
      dirs: this.granted,
      agents,
      support: this.o.support,
      vision: proposal.vision,
      considerations: proposal.considerations,
      kickoff: agents.filter((a) => !owned.has(a.id)).map((a) => a.id),
    });
    for (const d of this.drafts) room.writeDoc(d.name, d.text, "assistant", d.note);
    // Workstreams and the steer go in once the channel runs, so their owners are woken by them.
    room.onResume(() => {
      for (const t of proposal.topics) room.workstream(t.title, t.done, t.members);
      if (proposal.steer) room.post(proposal.steer);
    });
    return { room, skipped };
  }

  /** Applies a plan to the channel this session was opened for. */
  async apply(proposal = this.proposal): Promise<{ skipped: string[] }> {
    const room = this.o.room;
    if (!room) throw new Error("no channel to apply the plan to");
    if (!proposal) throw new Error("there's no plan yet");
    const { reading, skipped } = this.reading(proposal.reading);
    await room.applyPlan({ ...proposal, reading });
    return { skipped };
  }
}
