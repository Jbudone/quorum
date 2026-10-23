import { renderTranscript } from "../prompts.js";
import type { Protocol, RoundState } from "./types.js";

/** Each agent speaks in turn, seeing everything said before it. */
export const roundRobin: Protocol = {
  name: "round-robin",
  planRound(s: RoundState) {
    return s.agents.map((a) => [
      {
        agent: a.id,
        prompt: [
          `Topic: ${s.topic}`,
          renderTranscript(s.transcript),
          s.directives.length ? `Human directives:\n- ${s.directives.join("\n- ")}` : "",
          `Round ${s.round}. Respond from your role, building on or challenging what was said.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ]);
  },
};
