import type { AgentSpec } from "../config.js";
import type { RoundState } from "./types.js";

export const directivesBlock = (s: RoundState): string =>
  s.directives.length ? `Human directives (honor these):\n- ${s.directives.join("\n- ")}` : "";

export const evidenceLine = (s: RoundState): string =>
  s.requireEvidence
    ? "Back every substantive claim with evidence: cite file paths and lines from the repo, or name the concrete precedent. Unsupported claims will be discounted."
    : "";

export const planBlock = (s: RoundState): string => (s.plan.trim() ? `Current plan:\n\n${s.plan.trim()}` : "");

export const join = (...parts: (string | undefined)[]): string => parts.filter(Boolean).join("\n\n");

/** Agents with the given persona role; falls back to `fallback` when none have it. */
export function withRole(s: RoundState, role: string, fallback: AgentSpec[] = []): AgentSpec[] {
  const hit = s.agents.filter((a) => s.roles[a.id] === role);
  return hit.length ? hit : fallback;
}
