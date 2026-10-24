import type { Prior, RoundState, Turn } from "./types.js";

export interface OpenQuestion {
  text: string;
  /** Suggested answers the human can pick; empty means a free-text question. */
  options: string[];
  /** Several options can be chosen together. */
  multi: boolean;
}

export interface ChairReport {
  summary: string;
  dissent: string;
  /** The open questions as plain bullets (option syntax removed). */
  questions: string;
  openQuestions: OpenQuestion[];
  converged: boolean;
}

const YES_NO = /^(should|do|does|did|is|are|was|can|could|will|would|must|shall|has|have)\b/i;

/**
 * Parses the Chair's open-questions bullets. Each may be `- [multi] Question? :: Option A | Option B`;
 * a plain yes/no question gets Yes / No / Decide later so the human can answer with one key.
 */
export function parseOpenQuestions(section: string): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  for (const raw of section.split("\n")) {
    let line = raw.trim().replace(/^([-*•]|\d+[.)])\s*/, "").trim();
    if (!line || /^none\.?$/i.test(line)) continue;
    let multi = false;
    const flag = /^\[(multi|multiple)\]\s*/i.exec(line);
    if (flag) {
      multi = true;
      line = line.slice(flag[0].length);
    }
    const [text, rest] = line.split(/\s::\s/, 2);
    let options = (rest ?? "")
      .split("|")
      .map((o) => o.trim().replace(/\.$/, ""))
      .filter(Boolean)
      .map((o) => (o.length > 40 ? o.slice(0, 39) + "…" : o));
    options = [...new Set(options)].slice(0, 6);
    if (!options.length && YES_NO.test(text)) options = ["Yes", "No", "Decide later"];
    if (text.trim()) out.push({ text: text.trim(), options, multi: multi && options.length > 1 });
  }
  return out;
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
  const openQuestions = parseOpenQuestions(section("OPEN QUESTIONS"));
  return {
    summary: (first === -1 ? body : body.slice(0, first)).trim(),
    dissent: section("DISSENT"),
    questions: openQuestions.length ? openQuestions.map((q) => `- ${q.text}`).join("\n") : section("OPEN QUESTIONS"),
    openQuestions,
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
        "<bullets: unresolved decisions the plan still needs; write 'none' if none. Give each 2-4 concrete likely answers after ' :: ' separated by ' | ', e.g. '- Who owns key rotation? :: Platform team | Security team | Decide later'. Start the bullet with [multi] when several answers can be chosen together>",
        "CONVERGED: yes|no   (yes only if no substantive disagreement or open question blocks the plan)",
      ]
        .filter((l) => l !== undefined)
        .join("\n"),
  };
}
