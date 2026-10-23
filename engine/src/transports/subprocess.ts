import { mkdirSync } from "node:fs";
import { NEUTRAL_CWD } from "./claude.js";
import { spawnLines } from "./spawn.js";
import type { AgentEvent, AgentTransport, SendOptions } from "./types.js";

/** Turns a CLI's stdout lines into normalized events; stateful because some CLIs emit whole messages. */
export interface LineMapper {
  push(line: string): AgentEvent[];
  /** Called once stdout closes; emits whatever was held back plus the final `done`. */
  end(): AgentEvent[];
}

export interface Invocation {
  cmd: string;
  args: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

/** Shared plumbing for CLIs driven as one subprocess per turn. */
export abstract class SubprocessTransport implements AgentTransport {
  constructor(readonly id: string) {}

  protected abstract invocation(prompt: string, opts: SendOptions): Invocation;
  protected abstract mapper(): LineMapper;

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentEvent> {
    const inv = this.invocation(prompt, opts);
    const mapper = this.mapper();
    try {
      mkdirSync(NEUTRAL_CWD, { recursive: true });
      for await (const line of spawnLines(inv.cmd, inv.args, {
        cwd: NEUTRAL_CWD,
        stdin: inv.stdin,
        signal: opts.signal,
        env: inv.env ? { ...process.env, ...inv.env } : undefined,
      })) {
        yield* mapper.push(line);
      }
      yield* mapper.end();
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }
}

export function parseJson(line: string): any | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Prepends persona instructions for CLIs with no system-prompt flag; only needed on a fresh session. */
export function withPersona(prompt: string, opts: SendOptions): string {
  if (!opts.systemPrompt || opts.sessionId) return prompt;
  return `<role>\n${opts.systemPrompt}\n</role>\n\n${prompt}`;
}

export function repoNote(opts: SendOptions): string {
  return opts.cwd ? `The project under discussion is at ${opts.cwd}. You may read it but must not modify it.\n\n` : "";
}
