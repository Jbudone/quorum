import { parseJson, repoNote, SubprocessTransport, withPersona, type Invocation, type LineMapper } from "./subprocess.js";
import type { AgentEvent, SendOptions } from "./types.js";

/**
 * Maps `agy --output-format stream-json`. Text arrives as `agent_response` steps; steps that lead
 * into a tool call are narration ("I will now read..."), so only text after the last tool is the
 * answer. (The final `result.response` concatenates the narration too, so it is not used.)
 */
export class AgyMapper implements LineMapper {
  private answer = "";
  private conversationId?: string;
  private usage?: AgentEvent;
  private failure?: string;

  push(line: string): AgentEvent[] {
    const j = parseJson(line);
    if (!j) return [];
    if (j.event === "init") {
      this.conversationId = j.conversation_id;
      return [];
    }
    if (j.event === "step_update") {
      const s = j.step_update ?? {};
      if (s.step_type === "agent_response" && typeof s.text_delta === "string") this.answer += s.text_delta;
      if (s.step_type === "tool" && s.state === "ACTIVE") {
        this.answer = "";
        return [{ type: "tool", name: String(s.tool_name ?? "tool") }];
      }
      return [];
    }
    if (j.event === "result") {
      const r = j.result ?? {};
      this.conversationId ??= r.conversation_id;
      if (r.status && r.status !== "SUCCESS") {
        this.failure = String(r.error ?? `agy ${r.status}`);
        return [{ type: "error", message: this.failure }];
      }
      this.usage = { type: "usage", inputTokens: r.usage?.input_tokens, outputTokens: r.usage?.output_tokens };
    }
    return [];
  }

  end(): AgentEvent[] {
    if (this.failure) return [];
    const text = this.answer.trim();
    return [
      ...(text ? [{ type: "text", delta: text } as AgentEvent] : []),
      ...(this.usage ? [this.usage] : []),
      { type: "done", sessionId: this.conversationId },
    ];
  }
}

export interface AgyOptions {
  bin?: string;
  /** Model slug from `agy models`, e.g. "gemini-4-argon-medium". */
  model?: string;
}

/**
 * Drives Google's Antigravity CLI (`agy`), the successor to Gemini CLI, on the user's Google
 * subscription. The prompt goes in as a stream-json user event on stdin (no argument-size limit).
 *
 * Read-only relies on `--mode plan`, which agy only honors while slash-command expansion is on, so
 * `--disable-slash-commands` must not be passed. Our prompts never start with "/".
 */
export class AgyTransport extends SubprocessTransport {
  constructor(
    id = "agy",
    private readonly o: AgyOptions = {},
  ) {
    super(id);
  }

  protected mapper(): LineMapper {
    return new AgyMapper();
  }

  protected invocation(prompt: string, opts: SendOptions): Invocation {
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--mode",
      opts.readOnly === false ? "accept-edits" : "plan",
    ];
    if (opts.cwd) args.push("--add-dir", opts.cwd);
    if (this.o.model) args.push("--model", this.o.model);
    if (opts.sessionId) args.push("--conversation", opts.sessionId);
    const persona = opts.systemPrompt
      ? `${opts.systemPrompt}\n\nAnswer directly in your reply. Never create plan artifacts or ask for approval.`
      : undefined;
    const content = repoNote(opts) + withPersona(prompt, { ...opts, systemPrompt: persona });
    return {
      cmd: this.o.bin ?? "agy",
      args,
      stdin: JSON.stringify({ event: "user", message: { content } }) + "\n",
    };
  }
}
