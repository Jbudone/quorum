import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NEUTRAL_CWD } from "./claude.js";
import { parseJson, repoNote, SubprocessTransport, type Invocation, type LineMapper } from "./subprocess.js";
import type { AgentEvent, SendOptions } from "./types.js";

/**
 * Kimi Code's `--output-format stream-json` prints one whole message per line: assistant text,
 * assistant tool calls, tool results, and a closing `session.resume_hint` with the session id.
 * Text written before a tool call is narration; the answer is what comes after the last one.
 */
export class KimiMapper implements LineMapper {
  private text = "";
  private sessionId?: string;

  push(line: string): AgentEvent[] {
    const j = parseJson(line);
    if (!j) return [];
    if (j.role === "meta") {
      if (j.type === "session.resume_hint" && typeof j.session_id === "string") this.sessionId = j.session_id;
      return [];
    }
    if (j.role !== "assistant") return [];
    const out: AgentEvent[] = [];
    const content = typeof j.content === "string" ? j.content : Array.isArray(j.content) ? j.content.map((c: any) => (c?.type === "text" ? (c.text ?? "") : "")).join("") : "";
    if (content) this.text += content;
    for (const t of Array.isArray(j.tool_calls) ? j.tool_calls : []) {
      this.text = "";
      out.push({ type: "tool", name: String(t?.function?.name ?? "tool") });
    }
    return out;
  }

  end(): AgentEvent[] {
    return [...(this.text ? [{ type: "text", delta: this.text } as AgentEvent] : []), { type: "done", sessionId: this.sessionId }];
  }
}

/** Linux caps one argv string at 128 KiB; longer prompts go in a file the agent is told to read. */
export const ARG_LIMIT = 100_000;
export function promptArg(prompt: string, dir = join(NEUTRAL_CWD, "prompts")): string {
  if (Buffer.byteLength(prompt) <= ARG_LIMIT) return prompt;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}.md`);
  writeFileSync(file, prompt);
  return `Your message is too long to pass directly; it's in ${file}. Read that whole file first, then do what it says.`;
}

export interface KimiOptions {
  bin?: string;
  /** A model alias from ~/.kimi-code/config.toml, e.g. "openrouter/~moonshotai/kimi-latest". */
  model?: string;
}

/**
 * Drives `kimi -p`. The persona and the read-only tool list go in an agent file, which Kimi binds
 * to the session when it's created, so a resumed turn passes neither.
 */
export class KimiTransport extends SubprocessTransport {
  constructor(
    id = "kimi",
    private readonly o: KimiOptions = {},
  ) {
    super(id);
  }

  protected mapper(): LineMapper {
    return new KimiMapper();
  }

  protected invocation(prompt: string, opts: SendOptions): Invocation {
    const args = ["--output-format", "stream-json"];
    if (this.o.model) args.push("-m", this.o.model);
    if (opts.cwd) args.push("--add-dir", opts.cwd);
    for (const d of opts.dirs ?? []) args.push("--add-dir", d);
    if (opts.sessionId) args.push("-S", opts.sessionId);
    else args.push("--agent-file", agentFile(opts.systemPrompt ?? "", opts.readOnly !== false));
    args.push("-p", promptArg(opts.sessionId ? prompt : repoNote(opts) + prompt));
    return { cmd: this.o.bin ?? "kimi", args };
  }
}

/** Writes the agent file for a persona; the same persona reuses the same file. */
export function agentFile(persona: string, readOnly: boolean, dir = join(NEUTRAL_CWD, "kimi-agents")): string {
  const body = [
    "---",
    "name: quorum",
    "description: A member of a Quorum council",
    ...(readOnly ? ["tools: [Read, Glob, Grep]"] : []),
    "---",
    persona || "You are a member of a Quorum council.",
    "",
  ].join("\n");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash("sha256").update(body).digest("hex").slice(0, 16)}.md`);
  writeFileSync(file, body);
  return file;
}
