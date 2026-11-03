import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkReply, fingerprint, type Purpose } from "./purposes.js";

/**
 * Every model call a channel makes, kept with the channel (`calls.jsonl` in its folder): the full
 * prompt and reply, which prompt it was and which version of that prompt, what it cost and how long
 * it took, and whether the reply kept to the format the prompt asked for. Nothing leaves the machine.
 * The improvement report (report.ts) reads these across channels to find the prompts that need work
 * and to show whether a prompt change helped.
 */

export interface CallRow {
  n: number;
  /** When the call started and how long it ran. */
  ts: number;
  ms: number;
  agent: string;
  role: "member" | "support";
  purpose: Purpose;
  /** Fingerprint of the code that builds this purpose's prompt; changes only when that prompt does. */
  version: string;
  cli: string;
  model?: string;
  /** Hash of the system prompt, whose text is in prompts/<hash>.txt (personas repeat on every turn). */
  system: string;
  prompt: string;
  /** The call continued a vendor session, so the prompt is only what's new since its last turn. */
  resumed?: boolean;
  reply: string;
  tools?: number;
  in?: number;
  out?: number;
  usd?: number;
  failed?: string;
  /** Where the reply broke the prompt's own rules ("5 bullets, asked for 2-3"). */
  problems?: string[];
}

/** A member call that became a message: the message's number. */
export interface LinkRow {
  link: number;
  seq: number;
}

export interface CallHandle {
  usage(u: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void;
  tool(): void;
  end(text: string, failed?: string): void;
  /** The message this call's reply became. */
  produced(seq: number): void;
}

const NOOP: CallHandle = { usage() {}, tool() {}, end() {}, produced() {} };

export const stateDir = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "quorum");
const indexPath = () => join(stateDir(), "rooms.json");
export const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);

/** Channel folders that have logged calls, so a report can find them across projects. */
export function knownRooms(): string[] {
  try {
    const v = JSON.parse(readFileSync(indexPath(), "utf8"));
    return Array.isArray(v) ? v.filter((d) => typeof d === "string" && existsSync(join(d, "calls.jsonl"))) : [];
  } catch {
    return [];
  }
}

function remember(dir: string): void {
  try {
    const have = knownRooms();
    if (have.includes(dir)) return;
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(indexPath(), JSON.stringify([...have, dir], null, 1));
  } catch {
    // The index is a convenience; a report can still be pointed at a folder.
  }
}

export class CallLog {
  private n = 0;
  private registered = false;
  private systems = new Set<string>();

  /** `dir` is the channel's folder; undefined logs nothing. */
  constructor(private readonly dir: string | undefined) {
    if (!dir) return;
    this.n = readCalls(dir).calls.reduce((m, c) => Math.max(m, c.n), 0);
  }

  call(o: { agent: string; role: "member" | "support"; purpose: Purpose; cli: string; model?: string; system: string; prompt: string; resumed?: boolean }): CallHandle {
    const dir = this.dir;
    if (!dir) return NOOP;
    const n = ++this.n;
    const ts = Date.now();
    let tools = 0;
    let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
    const write = (row: object) => {
      try {
        appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(row) + "\n");
        if (!this.registered) (this.registered = true), remember(dir);
      } catch {
        // Logging never breaks a turn.
      }
    };
    return {
      usage: (u) => {
        usage = { ...usage, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) };
      },
      tool: () => {
        tools++;
      },
      end: (text, failed) => {
        const system = hash(o.system);
        try {
          if (!this.systems.has(system)) {
            this.systems.add(system);
            const f = join(dir, "prompts", `${system}.txt`);
            if (!existsSync(f)) {
              mkdirSync(dirname(f), { recursive: true });
              writeFileSync(f, o.system);
            }
          }
        } catch {}
        const problems = failed ? [] : checkReply(o.purpose, text);
        const row: CallRow = {
          n,
          ts,
          ms: Date.now() - ts,
          agent: o.agent,
          role: o.role,
          purpose: o.purpose,
          version: fingerprint(o.purpose),
          cli: o.cli,
          ...(o.model ? { model: o.model } : {}),
          system,
          prompt: o.prompt,
          ...(o.resumed ? { resumed: true } : {}),
          reply: text,
          ...(tools ? { tools } : {}),
          ...(usage.inputTokens !== undefined ? { in: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { out: usage.outputTokens } : {}),
          ...(usage.costUsd !== undefined ? { usd: usage.costUsd } : {}),
          ...(failed ? { failed: failed.slice(0, 300) } : {}),
          ...(problems.length ? { problems } : {}),
        };
        write(row);
      },
      produced: (seq) => write({ link: n, seq } satisfies LinkRow),
    };
  }
}

/** A channel's calls, with each linked message number filled in. */
export function readCalls(dir: string): { calls: (CallRow & { seq?: number })[] } {
  let text = "";
  try {
    text = readFileSync(join(dir, "calls.jsonl"), "utf8");
  } catch {
    return { calls: [] };
  }
  const calls: (CallRow & { seq?: number })[] = [];
  const links = new Map<number, number>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.link === "number") links.set(r.link, r.seq);
      else if (typeof r.n === "number") calls.push(r);
    } catch {
      // A torn last line from a crash is skipped.
    }
  }
  for (const c of calls) if (links.has(c.n)) c.seq = links.get(c.n);
  return { calls };
}

export function systemText(dir: string, h: string): string | undefined {
  try {
    return readFileSync(join(dir, "prompts", `${h}.txt`), "utf8");
  } catch {
    return undefined;
  }
}
