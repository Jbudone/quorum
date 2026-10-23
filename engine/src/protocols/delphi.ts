import { chairReportTurn } from "./chairReport.js";
import { directivesBlock, evidenceLine, join } from "./common.js";
import type { Prior, Protocol, RoundState, Turn } from "./types.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Deterministic per-round shuffle so panelist labels change between rounds and cannot be tracked. */
export function anonymize(ids: string[], round: number): Map<string, string> {
  // mulberry32: small, well-mixed, deterministic.
  let a = (round * 0x9e3779b9) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return new Map(order.map((id, i) => [id, `Panelist ${LETTERS[i]}`]));
}

const FORMAT =
  "Reply in this format:\nPOSITION: <your recommended approach in one or two sentences>\nREASONS: <the 2-4 strongest reasons>\nRISKS: <what could make you wrong>\nCONFIDENCE: <0-100>";

/**
 * Delphi: panelists answer independently and blind; each later round they see the previous round's
 * answers anonymized and may revise. The Chair synthesizes the plan and reports convergence.
 */
export const delphi: Protocol = {
  name: "delphi",
  planRound(s: RoundState): Turn[][] {
    const panel = s.agents;
    const previous = s.transcript.filter((e) => e.round === s.round - 1 && panel.some((a) => a.id === e.speaker));
    const labels = anonymize(
      panel.map((a) => a.id),
      s.round - 1,
    );
    const feedback = previous.length
      ? `Last round's answers, anonymized:\n\n${previous.map((e) => `${labels.get(e.speaker)}:\n${e.text}`).join("\n\n")}`
      : "";

    const ask = panel.map((a) => ({
      agent: a.id,
      prompt: join(
        `Topic: ${s.topic}`,
        feedback,
        directivesBlock(s),
        evidenceLine(s),
        s.round === 1
          ? "Give your independent answer."
          : "Reconsider in light of the other panelists' answers. Change your position only for reasons you find persuasive, and say what moved you.",
        FORMAT,
      ),
    }));

    const synthesize: Turn = {
      agent: "chair",
      key: "synthesis",
      artifact: "plan",
      prompt: (prior: Prior) =>
        join(
          `Topic: ${s.topic}`,
          `Panel answers this round:\n\n${panel.map((a) => `### ${a.id}\n${prior[a.id] ?? "(no reply)"}`).join("\n\n")}`,
          s.plan.trim() ? `Previous plan:\n\n${s.plan.trim()}` : "",
          "Synthesize the panel into a full plan in markdown, following the strongest-supported positions and weighting by stated confidence. Record unresolved disagreements in a 'Disagreements' section. Output only the plan.",
        ),
    };

    return [
      ask,
      [synthesize],
      [chairReportTurn(s, (prior) => `Synthesized plan:\n\n${prior.synthesis ?? ""}\n\nPanel answers:\n${panel.map((a) => `${a.id}: ${prior[a.id] ?? ""}`).join("\n")}`)],
    ];
  },
};
