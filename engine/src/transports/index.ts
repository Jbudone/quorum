import type { CliName } from "../config.js";
import { AgyTransport } from "./agy.js";
import { ClaudeTransport } from "./claude.js";
import { CodexTransport } from "./codex.js";
import { GeminiTransport } from "./gemini.js";
import { OpencodeTransport } from "./opencode.js";
import { MockTransport, type MockOptions } from "./mock.js";
import type { AgentTransport } from "./types.js";

export type { AgentEvent, AgentTransport, McpServerSpec, SendOptions } from "./types.js";

export interface TransportRequest {
  id: string;
  cli: CliName;
  model?: string;
  /** Used only for the mock cli. */
  mock?: MockOptions;
}

/** Builds a transport for a CLI. */
export function createTransport(req: TransportRequest): AgentTransport {
  switch (req.cli) {
    case "claude":
      return new ClaudeTransport(req.id, { model: req.model });
    case "mock":
      return new MockTransport(req.id, req.mock ?? { rules: [] });
    case "codex":
      return new CodexTransport(req.id, { model: req.model });
    case "gemini":
      return new GeminiTransport(req.id, { model: req.model });
    case "agy":
      return new AgyTransport(req.id, { model: req.model });
    case "opencode":
      return new OpencodeTransport(req.id, { model: req.model });
  }
}
