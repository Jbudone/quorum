import { promptArg } from "./kimi.js";
import { repoNote, SubprocessTransport, withPersona, type Invocation, type LineMapper } from "./subprocess.js";
import type { AgentEvent, SendOptions } from "./types.js";

/**
 * ZCode's `-p --json` prints nothing until the turn ends, then one pretty-printed JSON object
 * (`response`, `sessionId`, `usage`), sometimes after warning lines.
 */
export class ZcodeMapper implements LineMapper {
  private lines: string[] = [];

  push(line: string): AgentEvent[] {
    this.lines.push(line);
    return [];
  }

  end(): AgentEvent[] {
    const start = this.lines.findIndex((l) => l.trimStart().startsWith("{"));
    let j: any;
    try {
      j = start >= 0 ? JSON.parse(this.lines.slice(start).join("\n")) : undefined;
    } catch {
      j = undefined;
    }
    if (!j) return [{ type: "error", message: this.lines.join(" ").trim().slice(0, 240) || "zcode printed no result" }];
    if (j.error) return [{ type: "error", message: String(j.error?.message ?? j.error) }];
    const text = typeof j.response === "string" ? j.response : "";
    return [
      ...(text ? [{ type: "text", delta: text } as AgentEvent] : []),
      { type: "usage", inputTokens: j.usage?.inputTokens, outputTokens: j.usage?.outputTokens },
      { type: "done", sessionId: typeof j.sessionId === "string" ? j.sessionId : undefined },
    ];
  }
}

/**
 * Everything that could change files or reach past the read tools. `Agent` matters most: without
 * it removed, the model hands a write to a subagent that still has every tool.
 */
export const ZCODE_WRITE_TOOLS = [
  "Agent", "Bash", "Edit", "Write", "Skill", "TodoWrite", "SendMessage",
  "CreateWorkflow", "AmendWorkflow", "SaveWorkflow", "EvalWorkflowSnippet", "ResumeWorkflowRun", "ResolveWorkflowQuestion",
  "mcp__node_repl__js", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion",
];

/** The read tools, also removed when a call needs no tools at all. */
export const ZCODE_READ_TOOLS = ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"];

export interface ZcodeOptions {
  bin?: string;
  /** provider/model as ZCode's registry names it, e.g. "account:zai-individual-coding-plan/GLM-5.3". */
  model?: string;
}

/** Drives `zcode -p --json` (Z.AI's coding agent). It has no system-prompt flag, so the persona leads the first prompt. */
export class ZcodeTransport extends SubprocessTransport {
  readonly model?: string;

  constructor(
    id = "zcode",
    private readonly o: ZcodeOptions = {},
  ) {
    super(id);
    this.model = o.model;
  }

  protected mapper(): LineMapper {
    return new ZcodeMapper();
  }

  protected invocation(prompt: string, opts: SendOptions): Invocation {
    const args = ["--json", "--no-color"];
    if (this.o.model) args.push("--model", this.o.model);
    if (opts.sessionId) args.push("--resume", opts.sessionId);
    // Tool removal applies to one run only, so every turn repeats it.
    if (opts.readOnly !== false || opts.noTools) args.push("--disallowed-tools", [...ZCODE_WRITE_TOOLS, ...(opts.noTools ? ZCODE_READ_TOOLS : [])].join(" "));
    args.push("-p", promptArg(opts.sessionId ? prompt : repoNote(opts) + withPersona(prompt, opts)));
    return { cmd: this.o.bin ?? "zcode", args };
  }
}
