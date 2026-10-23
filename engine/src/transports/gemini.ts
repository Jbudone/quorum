import { parseJson, repoNote, SubprocessTransport, withPersona, type Invocation, type LineMapper } from "./subprocess.js";
import type { AgentEvent, SendOptions } from "./types.js";

/**
 * Maps `gemini -o stream-json` events: init, message (role + content, delta chunks), tool_use,
 * tool_result, error, result.
 *
 * UNVERIFIED against a live stream: Gemini CLI sign-in is currently rejected for this account
 * (IneligibleTierError), so this follows the documented event shape and is tolerant of variants.
 */
export class GeminiMapper implements LineMapper {
  private sessionId?: string;
  private input?: number;
  private output?: number;

  push(line: string): AgentEvent[] {
    const j = parseJson(line);
    if (!j) return [];
    switch (j.type) {
      case "init":
        this.sessionId = j.session_id;
        return [];
      case "message":
        return j.role === "assistant" && typeof j.content === "string" && j.content
          ? [{ type: "text", delta: j.content }]
          : [];
      case "tool_use":
        return [{ type: "tool", name: String(j.tool_name ?? j.name ?? "tool") }];
      case "error":
        return [{ type: "error", message: String(j.message ?? j.error ?? "gemini error") }];
      case "result":
        this.input = j.stats?.input_tokens ?? j.stats?.input;
        this.output = j.stats?.output_tokens ?? j.stats?.output;
        return j.status && j.status !== "success"
          ? [{ type: "error", message: String(j.error?.message ?? `gemini result: ${j.status}`) }]
          : [];
      default:
        return [];
    }
  }

  end(): AgentEvent[] {
    return [
      { type: "usage", inputTokens: this.input, outputTokens: this.output },
      { type: "done", sessionId: this.sessionId },
    ];
  }
}

export interface GeminiOptions {
  bin?: string;
  model?: string;
}

/** Drives `gemini -p -o stream-json` in plan (read-only) mode. Stateless: each turn is self-contained. */
export class GeminiTransport extends SubprocessTransport {
  constructor(
    id = "gemini",
    private readonly o: GeminiOptions = {},
  ) {
    super(id);
  }

  protected mapper(): LineMapper {
    return new GeminiMapper();
  }

  protected invocation(prompt: string, opts: SendOptions): Invocation {
    const args = ["-o", "stream-json", "--approval-mode", opts.readOnly === false ? "auto_edit" : "plan", "-p", " "];
    if (this.o.model) args.push("-m", this.o.model);
    if (opts.cwd) args.push("--include-directories", opts.cwd);
    return { cmd: this.o.bin ?? "gemini", args, stdin: repoNote(opts) + withPersona(prompt, { ...opts, sessionId: undefined }) };
  }
}
