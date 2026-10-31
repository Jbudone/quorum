import { parseJson, SubprocessTransport, type Invocation, type LineMapper } from "./subprocess.js";
import { readProviders, type ProvidersFile } from "../providers.js";
import type { AgentEvent, SendOptions } from "./types.js";

/**
 * Opencode streams one `text` part per step. Steps that end in tool calls carry narration;
 * the step that finishes with reason "stop" is the answer.
 */
export class OpencodeMapper implements LineMapper {
  private text = "";
  private answer = "";
  private sessionId?: string;
  private input?: number;
  private output?: number;

  push(line: string): AgentEvent[] {
    const j = parseJson(line);
    if (!j) return [];
    this.sessionId ??= j.sessionID;
    switch (j.type) {
      case "text":
        this.text += j.part?.text ?? "";
        return [];
      case "tool_use":
        this.text = "";
        return [{ type: "tool", name: String(j.part?.tool ?? "tool") }];
      case "step_finish": {
        const t = j.part?.tokens;
        this.input = (this.input ?? 0) + (t?.input ?? 0);
        this.output = (this.output ?? 0) + (t?.output ?? 0);
        if (j.part?.reason === "stop") this.answer += this.text;
        this.text = "";
        return [];
      }
      case "error":
        return [{ type: "error", message: String(j.error?.data?.message ?? j.error?.name ?? "opencode error") }];
      default:
        return [];
    }
  }

  end(): AgentEvent[] {
    const answer = this.answer || this.text;
    return [
      ...(answer ? [{ type: "text", delta: answer } as AgentEvent] : []),
      { type: "usage", inputTokens: this.input, outputTokens: this.output },
      { type: "done", sessionId: this.sessionId },
    ];
  }
}

export interface OpencodeOptions {
  bin?: string;
  /** provider/model, e.g. "anthropic/claude-sonnet-5-5". */
  model?: string;
  /** The human's providers (read from providers.toml when absent). */
  providers?: ProvidersFile;
}

/**
 * Opencode config for the model's provider when opencode doesn't know it: one of the human's custom
 * OpenAI-compatible providers, or a local ollama.
 */
export function customProvider(model: string | undefined, f: ProvidersFile): { provider?: Record<string, unknown> } {
  const slash = model?.indexOf("/") ?? -1;
  if (!model || slash <= 0) return {};
  const id = model.slice(0, slash);
  const name = model.slice(slash + 1);
  const p = f.providers[id];
  const baseURL = p?.baseUrl ?? (id === "ollama" ? "http://localhost:11434/v1" : undefined);
  if (!baseURL) return {};
  return {
    provider: {
      [id]: {
        npm: "@ai-sdk/openai-compatible",
        name: p?.name ?? id,
        options: { baseURL, ...(p?.env ? { apiKey: `{env:${p.env}}` } : {}) },
        models: Object.fromEntries([...new Set([...(p?.models ?? []), name])].map((m) => [m, {}])),
      },
    },
  };
}

/** Drives `opencode run --format json`. The persona becomes a real system prompt via a read-only agent. */
export class OpencodeTransport extends SubprocessTransport {
  readonly supportsMcp = true;

  constructor(
    id = "opencode",
    private readonly o: OpencodeOptions = {},
  ) {
    super(id);
  }

  protected mapper(): LineMapper {
    return new OpencodeMapper();
  }

  protected invocation(prompt: string, opts: SendOptions): Invocation {
    const readOnly = opts.readOnly !== false;
    const agentConfig = {
      mode: "primary",
      ...(opts.systemPrompt ? { prompt: opts.systemPrompt } : {}),
      permission: readOnly ? { edit: "deny", bash: "deny", webfetch: "deny" } : {},
    };
    // --standalone runs a private server, so the inline config below applies to this turn only
    // (the shared background service would ignore it). Opencode 2 has no --dir; the project is the cwd.
    const args = ["run", "--standalone", "--format", "json", "--agent", "quorum"];
    if (this.o.model) args.push("-m", this.o.model);
    if (opts.sessionId) args.push("-s", opts.sessionId);
    args.push(prompt);
    return {
      cmd: this.o.bin ?? "opencode",
      args,
      cwd: opts.cwd,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          agent: { quorum: agentConfig },
          ...customProvider(this.o.model, this.o.providers ?? readProviders()),
          ...(opts.mcp
            ? {
                mcp: {
                  [opts.mcp.name]: {
                    type: "local",
                    command: [opts.mcp.command, ...opts.mcp.args],
                    environment: opts.mcp.env,
                  },
                },
              }
            : {}),
        }),
        // Opencode reads ~/.claude/CLAUDE.md by default, which would leak the user's own instructions.
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      },
    };
  }
}
