import type { CliName } from "../config.js";
import { ClaudeTransport } from "./claude.js";
import { MockTransport, type MockOptions } from "./mock.js";
import type { AgentTransport } from "./types.js";

export type { AgentEvent, AgentTransport, SendOptions } from "./types.js";

export interface TransportRequest {
  id: string;
  cli: CliName;
  model?: string;
  /** Used only for the mock cli. */
  mock?: MockOptions;
}

/** Builds a transport for a CLI. Codex/Gemini/Opencode land in Phase 4. */
export function createTransport(req: TransportRequest): AgentTransport {
  switch (req.cli) {
    case "claude":
      return new ClaudeTransport(req.id, { model: req.model });
    case "mock":
      return new MockTransport(req.id, req.mock ?? { rules: [] });
    default:
      throw new Error(`transport for "${req.cli}" is not implemented yet`);
  }
}
