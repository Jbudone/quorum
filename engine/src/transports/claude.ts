import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLines } from "./spawn.js";
import type { QuotaWindow } from "../usage.js";
import type { AgentEvent, AgentTransport, SendOptions, UsageLimit } from "./types.js";

/** Maps one `claude -p --output-format stream-json` line to zero or more normalized events. */
export function mapClaudeLine(line: string): AgentEvent[] {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  switch (j.type) {
    case "stream_event": {
      const ev = j.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        return [{ type: "text", delta: ev.delta.text }];
      }
      if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        return [{ type: "tool", name: ev.content_block.name }];
      }
      return [];
    }
    case "rate_limit_event":
      return [claudeLimit(j.rate_limit_info)];
    case "result": {
      if (j.is_error) return [{ type: "error", message: String(j.result ?? j.subtype) }];
      const u = j.usage ?? {};
      return [
        {
          type: "usage",
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
          ...(typeof j.total_cost_usd === "number" ? { costUsd: j.total_cost_usd } : {}),
        },
        { type: "done", sessionId: j.session_id },
      ];
    }
    default:
      return [];
  }
}

/**
 * Stable neutral cwd. Claude auto-loads CLAUDE.md/memory from the working directory's tree, which
 * would leak the user's own instructions into every council member, so agents run here and reach
 * the target repo through --add-dir instead. Stable because Claude keys saved sessions by cwd.
 */
export const NEUTRAL_CWD = join(tmpdir(), "quorum-agent-cwd");

export interface ClaudeOptions {
  /** CLI binary, overridable for tests. */
  bin?: string;
  model?: string;
}

/**
 * Drives the official `claude` CLI headlessly on the user's subscription.
 * Isolated from the user's global memory/MCP/skills so every council member sees only its persona.
 */
export class ClaudeTransport implements AgentTransport {
  readonly supportsMcp = true;
  readonly model?: string;

  constructor(
    readonly id = "claude",
    private readonly o: ClaudeOptions = {},
  ) {
    this.model = o.model;
  }

  buildArgs(opts: SendOptions = {}): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--setting-sources",
      "project",
      "--disable-slash-commands",
      "--strict-mcp-config",
    ];
    // An empty --tools value disables everything; read-only means search/read tools only.
    args.push("--tools", opts.noTools ? "" : opts.readOnly === false ? "default" : `Read,Grep,Glob${opts.web ? ",WebSearch,WebFetch" : ""}`);
    if (this.o.model) args.push("--model", this.o.model);
    const system = [opts.systemPrompt, opts.cwd && `The project under discussion is at ${opts.cwd}.`]
      .filter(Boolean)
      .join("\n\n");
    if (opts.cwd) args.push("--add-dir", opts.cwd);
    for (const d of opts.dirs ?? []) args.push("--add-dir", d);
    if (system) args.push("--append-system-prompt", system);
    if (opts.sessionId) args.push("--resume", opts.sessionId);
    if (opts.mcp) {
      const { name, command, args: a, env } = opts.mcp;
      args.push("--mcp-config", JSON.stringify({ mcpServers: { [name]: { command, args: a, env } } }));
      // Headless turns can't answer permission prompts, so the server's tools are pre-approved.
      args.push("--allowedTools", `mcp__${name}`);
    }
    return args;
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentEvent> {
    try {
      mkdirSync(NEUTRAL_CWD, { recursive: true });
      for await (const line of spawnLines(this.o.bin ?? "claude", this.buildArgs(opts), {
        cwd: NEUTRAL_CWD,
        stdin: prompt,
        signal: opts.signal,
      })) {
        yield* mapClaudeLine(line);
      }
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }
}

const WINDOW_LABEL: Record<string, string> = { five_hour: "5h", seven_day: "7d" };
const iso = (secs: unknown) => (typeof secs === "number" ? new Date(secs * 1000).toISOString() : undefined);

/**
 * Reads Claude Code's rate_limit_event. Its status is "allowed", "allowed_warning" (close to a
 * limit) or "rejected"; a rejection with errorCode "credits_required" means the model is billed to
 * usage credits that have run out, not that a subscription window is used up.
 */
export function claudeLimit(info: any): AgentEvent {
  const windows: QuotaWindow[] = [];
  for (const [k, w] of Object.entries<any>(info?.unifiedWindows ?? {})) {
    if (typeof w?.utilization !== "number") continue;
    windows.push({ label: WINDOW_LABEL[k] ?? k.replace(/_/g, " "), used: w.utilization, ...(iso(w.resetsAt) ? { resetsAt: iso(w.resetsAt)! } : {}) });
  }
  windows.sort((a, b) => (a.label === "5h" ? -1 : b.label === "5h" ? 1 : 0));
  const status = String(info?.status ?? "allowed");
  const resetsAt = iso(info?.resetsAt);
  const window = info?.rateLimitType ? String(info.rateLimitType) : undefined;
  const limit: UsageLimit | undefined =
    status === "rejected"
      ? info?.errorCode === "credits_required" || (!window && info?.overageDisabledReason === "out_of_credits")
        ? { kind: "credits" }
        : { kind: "window", ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
      : status === "allowed_warning"
        ? { kind: "warning", ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
        : undefined;
  return {
    type: "usage",
    ...(limit && limit.kind !== "warning" ? { rateLimited: true } : {}),
    ...(limit ? { limit } : {}),
    ...(windows.length ? { quotaUtilization: windows[0].used, windows } : {}),
  };
}
