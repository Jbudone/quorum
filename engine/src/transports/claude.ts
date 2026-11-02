import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLines } from "./spawn.js";
import type { AgentEvent, AgentTransport, SendOptions } from "./types.js";

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
    case "rate_limit_event": {
      const info = j.rate_limit_info;
      return [
        {
          type: "usage",
          rateLimited: info?.status !== "allowed",
          quotaUtilization: info?.unifiedWindows?.five_hour?.utilization,
        },
      ];
    }
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
    args.push("--tools", opts.noTools ? "" : opts.readOnly === false ? "default" : "Read,Grep,Glob");
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
