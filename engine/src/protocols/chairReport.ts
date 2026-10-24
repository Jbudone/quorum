import type { Prior, RoundState, Turn } from "./types.js";

export interface ChairReport {
  summary: string;
  dissent: string;
  questions: string;
  converged: boolean;
}

/** Splits the Chair's end-of-round report into the human summary, dissent, open questions and verdict. */
export function parseChairReport(text: string): ChairReport {
  const converged = /^\s*CONVERGED:\s*yes\b/im.test(text);
  const body = text.replace(/^\s*CONVERGED:.*$/gim, "");
  const section = (name: string) => {
    const m = new RegExp(`^##\\s*${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im").exec(body);
    return m ? m[1].trim() : "";
  };
  const first = body.search(/^##\s/m);
  return {
    summary: (first === -1 ? body : body.slice(0, first)).trim(),
    dissent: section("DISSENT"),
    questions: section("OPEN QUESTIONS"),
    converged,
  };
}

/** The Chair's end-of-round turn, shared by every protocol. */
export function chairReportTurn(s: RoundState, evidence: (prior: Prior) => string = () => ""): Turn {
  return {
    agent: "chair",
    key: "chair-report",
    artifact: "chair-report",
    prompt: (prior) =>
      [
        `Topic: ${s.topic}`,
        evidence(prior),
        `You are closing round ${s.round} of ${s.totalRounds}. Write a report in exactly this format:`,
        "",
        "<2-4 plain sentences, 70 words at most, for the human: where members agree, where they disagree and why it matters, and what the human might steer>",
        "## DISSENT",
        "<bullets: reasoned positions the current plan did NOT adopt, with who holds them; write 'none' if none>",
        "## OPEN QUESTIONS",
        "<bullets: unresolved decisions the plan still needs; write 'none' if none>",
        "CONVERGED: yes|no   (yes only if no substantive disagreement or open question blocks the plan)",
      ]
        .filter((l) => l !== undefined)
        .join("\n"),
  };
}
