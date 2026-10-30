import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec } from "../config.js";

/** Who a message is for: everyone in the room, or one agent (a DM). */
export type Recipient = "room" | string;

/** What the log records. Everything else in a room (inboxes, digests, docs) is derived from these. */
export type RoomEventBody =
  | { type: "message"; from: string; to: Recipient; text: string }
  | { type: "pass"; from: string }
  | { type: "turn.failed"; agent: string; message: string }
  | { type: "paused"; reason: string }
  | { type: "resumed" };

export type RoomEvent = RoomEventBody & { seq: number; ts: string };

export interface RoomConfig {
  id: string;
  topic: string;
  agents: AgentSpec[];
  /** Most agents running a turn at once. */
  parallel: number;
  /** Agent turns allowed per resume before the room pauses itself. */
  turnCap: number;
}

/** Per-agent state that must survive a restart. */
export interface AgentState {
  /** Vendor CLI session to resume, when the transport reported one. */
  sessionId?: string;
  /** Highest event seq this agent has been shown. */
  lastRead: number;
  turns: number;
}

/**
 * Plain-file room store under `<repo>/.quorum/rooms/<id>/`. `events.jsonl` is append-only and the
 * source of truth; `agents/<id>.json` holds what each agent needs to pick up where it left off.
 */
export class RoomStore {
  readonly dir: string;
  private seq: number;

  private constructor(root: string, readonly id: string) {
    this.dir = join(root, ".quorum", "rooms", id);
    this.seq = this.events().at(-1)?.seq ?? 0;
  }

  static create(root: string, config: Omit<RoomConfig, "id">, now = new Date()): RoomStore {
    const stamp = `${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}-room`;
    let id = stamp;
    for (let n = 2; existsSync(join(root, ".quorum", "rooms", id)); n++) id = `${stamp}-${n}`;
    const dir = join(root, ".quorum", "rooms", id);
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "room.json"), JSON.stringify({ id, ...config }, null, 2));
    return new RoomStore(root, id);
  }

  static open(root: string, id: string): RoomStore {
    if (!existsSync(join(root, ".quorum", "rooms", id, "room.json"))) throw new Error(`no room "${id}"`);
    return new RoomStore(root, id);
  }

  /** Room ids under `root`, newest first. */
  static list(root: string): string[] {
    try {
      return readdirSync(join(root, ".quorum", "rooms")).sort().reverse();
    } catch {
      return [];
    }
  }

  config(): RoomConfig {
    return JSON.parse(readFileSync(join(this.dir, "room.json"), "utf8"));
  }

  updateConfig(patch: Partial<Pick<RoomConfig, "parallel" | "turnCap">>): RoomConfig {
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const c = { ...this.config(), ...set };
    writeFileSync(join(this.dir, "room.json"), JSON.stringify(c, null, 2));
    return c;
  }

  append(body: RoomEventBody): RoomEvent {
    const e = { ...body, seq: ++this.seq, ts: new Date().toISOString() } as RoomEvent;
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(e) + "\n");
    return e;
  }

  events(): RoomEvent[] {
    try {
      return readFileSync(join(this.dir, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  get lastSeq(): number {
    return this.seq;
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
}

/** Whether `agent` may see an event: room messages, DMs to or from it, and room-level events. */
export function visibleTo(agent: string, e: RoomEvent): boolean {
  if (e.type !== "message") return true;
  return e.to === "room" || e.to === agent || e.from === agent;
}
