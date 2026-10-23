import { parseJson, repoNote, SubprocessTransport, withPersona, type Invocation, type LineMapper } from "./subprocess.js";
import type { AgentEvent, SendOptions } from "./types.js";

/**
 * Codex emits whole messages, including narration before tool calls ("I'll read the file...").
 * Only the messages after the last tool call are the answer, so earlier ones are dropped.
 */
export class CodexMapper implements LineMapper {
  private held: string[] = [];
  private sessionId?: string;
  private usage?: AgentEvent;

  push(line: string): AgentEvent[] {
    const j = parseJson(line);
    if (!j) return [];
    switch (j.type) {
      case "thread.started":
        this.sessionId = j.thread_id;
        return [];
      case "item.started":
        if (j.item?.type === "command_execution") {
          this.held = [];
          return [{ type: "tool", name: "shell", summary: String(j.item.command ?? "").slice(0, 120) }];
        }
        return [];
      case "item.completed":
        if (j.item?.type === "agent_message" && j.item.text) this.held.push(j.item.text);
        return []; // item.type "error" is a config warning, not a failure
      case "turn.completed":
        this.usage = {
          type: "usage",
          inputTokens: j.usage?.input_tokens,
          outputTokens: j.usage?.output_tokens,
        };
        return [];
      case "turn.failed":
        return [{ type: "error", message: String(j.error?.message ?? "codex turn failed") }];
      case "error":
        return [{ type: "error", message: String(j.message ?? "codex error") }];
      default:
        return [];
    }
  }

  end(): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (this.held.length) out.push({ type: "text", delta: this.held.join("\n\n") });
    if (this.usage) out.push(this.usage);
    out.push({ type: "done", sessionId: this.sessionId });
    return out;
  }
}

export interface CodexOptions {
  bin?: string;
  model?: string;
}

/** Drives `codex exec --json` on the user's ChatGPT subscription, read-only sandboxed. */
export class CodexTransport extends SubprocessTransport {
  constructor(
    id = "codex",
    private readonly o: CodexOptions = {},
  ) {
    super(id);
  }

  protected mapper(): LineMapper {
    return new CodexMapper();
  }

  protected invocation(prompt: string, opts: SendOptions): Invocation {
    // The sandbox is set with -c because `exec resume` does not accept -s.
    const sandbox = opts.readOnly === false ? "workspace-write" : "read-only";
    const args = ["exec"];
    if (opts.sessionId) args.push("resume");
    args.push("--json", "--skip-git-repo-check", "-c", `sandbox_mode="${sandbox}"`);
    if (this.o.model) args.push("-m", this.o.model);
    if (opts.sessionId) args.push(opts.sessionId);
    args.push("-"); // prompt on stdin
    return {
      cmd: this.o.bin ?? "codex",
      args,
      stdin: repoNote(opts) + withPersona(prompt, opts),
    };
  }
}
