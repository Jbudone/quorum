/** Normalized events every AgentTransport emits, regardless of vendor stream format. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; summary?: string }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      rateLimited?: boolean;
      /** Subscription quota used in the current window, 0..1, when the CLI reports it. */
      quotaUtilization?: number;
    }
  | { type: "done"; sessionId?: string }
  | { type: "error"; message: string };

/** A stdio MCP server the CLI should launch for this turn (e.g. a room's tool bridge). */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SendOptions {
  /** Vendor session id to resume, if the transport supports it. */
  sessionId?: string;
  /** Working directory the agent runs in (target repo). */
  cwd?: string;
  /** Persona / role instructions appended to the system prompt. */
  systemPrompt?: string;
  /** Read-only repo access (default true). */
  readOnly?: boolean;
  signal?: AbortSignal;
  /** Extra MCP server for this turn; only honored by transports with `supportsMcp`. */
  mcp?: McpServerSpec;
}

export interface AgentTransport {
  readonly id: string;
  /** True when the transport passes SendOptions.mcp through to its CLI. */
  readonly supportsMcp?: boolean;
  send(prompt: string, opts?: SendOptions): AsyncIterable<AgentEvent>;
}
