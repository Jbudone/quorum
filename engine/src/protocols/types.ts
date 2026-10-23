import type { AgentSpec } from "../config.js";
import type { TranscriptEntry } from "../session.js";

export interface RoundState {
  round: number;
  /** Total rounds configured (lets prompts say "final round"). */
  totalRounds: number;
  topic: string;
  agents: AgentSpec[];
  /** Persona role per agent id: drafter | critic | panelist. */
  roles: Record<string, string>;
  /** Current plan.md contents (empty before the first draft). */
  plan: string;
  /** Everything said so far, oldest first. */
  transcript: TranscriptEntry[];
  /** Human/Chair steering to honor this round. */
  directives: string[];
  requireEvidence: boolean;
}

/** Text produced earlier in the same round, keyed by Turn.key (default: the agent id). */
export type Prior = Record<string, string>;

export interface Turn {
  agent: string;
  /** A function lets later steps build on earlier ones (e.g. a revision seeing the critiques). */
  prompt: string | ((prior: Prior) => string);
  key?: string;
  /** What the engine does with the reply: "plan" overwrites plan.md; "chair-report" updates dissent/questions. */
  artifact?: "plan" | "chair-report";
}

/**
 * A protocol decides who speaks in a round and what they are asked.
 * A round is a list of steps run in order; turns inside one step run in parallel (blind to each other).
 */
export interface Protocol {
  readonly name: string;
  planRound(state: RoundState): Turn[][];
}
