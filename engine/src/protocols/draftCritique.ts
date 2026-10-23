import { chairReportTurn } from "./chairReport.js";
import { directivesBlock, evidenceLine, join, planBlock, withRole } from "./common.js";
import type { Protocol, RoundState, Turn } from "./types.js";

/**
 * Draft -> blind critique -> revise. Round 1 starts with a draft; every round then has the critics
 * review the current plan independently (they never see each other), and the drafter revises it.
 */
export const draftCritique: Protocol = {
  name: "draft-critique-revise",
  planRound(s: RoundState): Turn[][] {
    const drafter = withRole(s, "drafter", s.agents.slice(0, 1))[0];
    const critics = withRole(
      s,
      "critic",
      s.agents.filter((a) => a.id !== drafter.id),
    );
    const steps: Turn[][] = [];

    if (!s.plan.trim()) {
      steps.push([
        {
          agent: drafter.id,
          key: "draft",
          artifact: "plan",
          prompt: join(
            `Topic: ${s.topic}`,
            directivesBlock(s),
            evidenceLine(s),
            "Write the first full draft of the plan in markdown: goals, non-goals, design, sequencing, risks, and open questions. Be concrete enough to be criticized.",
          ),
        },
      ]);
    }

    steps.push(
      critics.map((c) => ({
        agent: c.id,
        prompt: (prior: Record<string, string>) =>
          join(
            `Topic: ${s.topic}`,
            `Plan under review:\n\n${(prior.draft ?? s.plan).trim()}`,
            directivesBlock(s),
            evidenceLine(s),
            `Round ${s.round} of ${s.totalRounds}. Critique this plan from your role. Rank objections by severity, and for each say what change or evidence would resolve it. Do not rewrite the plan.`,
          ),
      })),
    );

    steps.push([
      {
        agent: drafter.id,
        key: "revision",
        artifact: "plan",
        prompt: (prior) =>
          join(
            `Topic: ${s.topic}`,
            `Your current plan:\n\n${(prior.draft ?? s.plan).trim()}`,
            `Independent critiques:\n\n${critics.map((c) => `### ${c.id}\n${prior[c.id] ?? "(no reply)"}`).join("\n\n")}`,
            directivesBlock(s),
            "Produce the full revised plan in markdown. Fix what the critiques got right; for what you reject, keep the plan as is but add a short 'Rejected objections' section with your reasons. Output only the plan.",
          ),
      },
    ]);

    steps.push([chairReportTurn(s, (prior) => `Revised plan:\n\n${(prior.revision ?? s.plan).trim()}\n\nCritiques:\n${critics.map((c) => `${c.id}: ${prior[c.id] ?? ""}`).join("\n")}`)]);
    return steps;
  },
};
