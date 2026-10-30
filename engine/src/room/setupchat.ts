import type { AgentSpec, CliName } from "../config.js";
import { parseSetup, setupPrompt, SETUP_SYSTEM, type SetupProposal } from "./prompts.js";
import { Room, type RoomOptions } from "./room.js";
import type { RoomConfig, SupportSpec } from "./store.js";
import { readingPath, Workspace } from "./workspace.js";

/**
 * The conversation that sets up a channel. There is no channel until the human approves a
 * proposal: the assistant learns the problem, finds the docs to read, and invents members for it
 * (or reuses workspace members, who bring their memory).
 */
export class SetupChat {
  readonly history: { from: "human" | "assistant"; text: string }[] = [];
  proposal?: SetupProposal;

  constructor(
    private readonly o: RoomOptions & { support: Required<RoomConfig["support"]>; clis: string[] },
  ) {}

  /** The human says something; the assistant's reply streams through `onDelta`. */
  async say(text: string, onDelta?: (d: string) => void, signal?: AbortSignal): Promise<{ text: string; proposal?: SetupProposal }> {
    if (!text.trim()) throw new Error("say something first");
    this.history.push({ from: "human", text: text.trim() });
    const ws = new Workspace(this.o.repo);
    const spec: SupportSpec = this.o.support.assistant;
    const prompt = setupPrompt({
      repo: this.o.repo,
      members: ws.members(),
      channels: ws.channels().map((c) => c.name || c.id),
      clis: this.o.clis,
      history: this.history,
    });
    let reply = "";
    let failed: string | undefined;
    for await (const e of this.o.transports({ id: "assistant", ...spec }).send(prompt, { cwd: this.o.repo, systemPrompt: SETUP_SYSTEM, readOnly: true, signal })) {
      if (e.type === "text") {
        reply += e.delta;
        onDelta?.(e.delta);
      } else if (e.type === "error") failed = e.message;
    }
    if (!reply.trim()) throw new Error(failed ?? "the assistant didn't answer");
    const { prose, proposal } = parseSetup(reply);
    if (proposal) this.proposal = proposal;
    this.history.push({ from: "assistant", text: reply.trim() });
    return { text: prose, ...(proposal ? { proposal } : {}) };
  }

  /**
   * Creates the channel from a proposal (the latest one by default): invented personas and new
   * members join the workspace, missing reading-list entries are skipped and reported.
   */
  create(proposal = this.proposal, tuning: { parallel?: number; turnCap?: number } = {}): { room: Room; skipped: string[] } {
    if (!proposal?.members.length) throw new Error("there's no lineup yet; tell the assistant about the problem first");
    const ws = new Workspace(this.o.repo);
    const known = new Map(ws.members().map((m) => [m.id, m]));
    const agents: AgentSpec[] = [];
    for (const m of proposal.members) {
      const old = known.get(m.id);
      if (old && !m.persona) {
        agents.push({ id: old.id, persona: old.persona, cli: (m.cli as CliName) ?? old.cli, ...((m.model ?? old.model) ? { model: m.model ?? old.model } : {}) });
        continue;
      }
      const cli = (m.cli ?? old?.cli) as CliName | undefined;
      if (!cli || !this.o.clis.includes(cli)) throw new Error(`${m.id} needs a CLI from ${this.o.clis.join(", ")}`);
      if (!m.persona && !old) throw new Error(`${m.id} needs a persona`);
      if (m.persona) ws.writePersona(m.id, { name: m.id, role: m.role ?? m.id, body: m.persona });
      const spec: AgentSpec = { id: m.id, persona: m.persona ? m.id : old!.persona, cli, ...(m.model ? { model: m.model } : {}) };
      ws.saveMember({ ...spec, role: m.role ?? old?.role });
      agents.push(spec);
    }
    const skipped: string[] = [];
    const reading: string[] = [];
    for (const p of proposal.reading) {
      try {
        reading.push(readingPath(this.o.repo, p));
      } catch {
        skipped.push(p);
      }
    }
    const topic = proposal.topic ?? this.history.find((h) => h.from === "human")?.text ?? "";
    const room = Room.create({ ...this.o, ...tuning, topic, name: proposal.name, reading, agents, support: this.o.support, kickoff: true });
    return { room, skipped };
  }
}
