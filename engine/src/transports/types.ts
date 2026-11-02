import type { QuotaWindow } from "../usage.js";

/**
 * A limit the vendor reported. "warning": still allowed, but close to a limit, so slow down.
 * "window": a quota window is used up until `resetsAt`. "credits": this model draws on usage credits
 * (not the subscription) and they're used up, so it's out until someone adds credits or switches model.
 */
export interface UsageLimit {
  kind: "warning" | "window" | "credits";
  /** The vendor's name for the window, e.g. "five_hour". */
  window?: string;
  resetsAt?: string;
}

/** Normalized events every AgentTransport emits, regardless of vendor stream format. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; summary?: string }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      /** Input read from the prompt cache, not counted in inputTokens. */
      cacheReadTokens?: number;
      /** Input written to the prompt cache, not counted in inputTokens. */
      cacheWriteTokens?: number;
      /** True when the vendor refused the turn for a limit (see `limit` for which). */
      rateLimited?: boolean;
      limit?: UsageLimit;
      /** Subscription quota used in the current window, 0..1, when the CLI reports it. */
      quotaUtilization?: number;
      /** Every quota window the CLI reported (e.g. 5h and 7d), shortest first. */
      windows?: QuotaWindow[];
      /** What the turn cost in USD, when the CLI reports it: billed on a pay-per-token harness, at list price on a subscription. */
      costUsd?: number;
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
  /** Other folders the agent may read, besides cwd (absolute paths). */
  dirs?: string[];
  /** Persona / role instructions appended to the system prompt. */
  systemPrompt?: string;
  /** Read-only repo access (default true). */
  readOnly?: boolean;
  /**
   * No tools at all: for support calls that work only from their prompt. Honored where the CLI can
   * turn tools off; elsewhere it falls back to read-only.
   */
  noTools?: boolean;
  /** Web search and fetch on top of the read tools, where the CLI can do it; off otherwise. */
  web?: boolean;
  signal?: AbortSignal;
  /** Extra MCP server for this turn; only honored by transports with `supportsMcp`. */
  mcp?: McpServerSpec;
}

export interface AgentTransport {
  readonly id: string;
  /** True when the transport passes SendOptions.mcp through to its CLI. */
  readonly supportsMcp?: boolean;
  /** The model identifier this transport uses (e.g., "claude-3-5-sonnet", "gpt-4o"). */
  readonly model?: string;
  send(prompt: string, opts?: SendOptions): AsyncIterable<AgentEvent>;
}
