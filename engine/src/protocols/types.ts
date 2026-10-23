import type { AgentSpec } from "../config.js";
import type { TranscriptEntry } from "../session.js";

export interface RoundState {
  round: number;
  topic: string;
  agents: AgentSpec[];
  /** Everything said so far, oldest first. */
  transcript: TranscriptEntry[];
  /** Human/Chair steering to honor this round. */
  directives: string[];
}

export interface Turn {
  agent: string;
  prompt: string;
}

/**
 * A protocol decides who speaks in a round and what they are asked.
 * A round is a list of steps run in order; turns inside one step run in parallel (blind to each other).
 */
export interface Protocol {
  readonly name: string;
  planRound(state: RoundState): Turn[][];
}
