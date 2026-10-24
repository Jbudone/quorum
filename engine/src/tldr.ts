/**
 * Every council reply carries a machine-readable TL;DR the TUI shows first. The full reply is kept
 * (minus the block itself) so nothing is lost; the TL;DR is what a human reads.
 */
export type Stance = "agree" | "disagree" | "mixed" | "neutral";

export interface Tldr {
  headline: string;
  bullets: string[];
  stance: Stance;
  /** 0-100, or undefined when the agent did not say. */
  confidence?: number;
}

export const TLDR_INSTRUCTION = [
  "Keep the reply tight: short paragraphs or bullets, no preamble, no restating the question.",
  "End with this block exactly, and put nothing after it:",
  "<tldr>",
  "headline: the point in 10 words or fewer",
  "stance: agree | disagree | mixed | neutral   (toward the current direction of the plan)",
  "confidence: 0-100",
  "- up to three bullets, 12 words each at most",
  "</tldr>",
].join("\n");

const STANCES: Stance[] = ["agree", "disagree", "mixed", "neutral"];
const BLOCK = /<tldr>([\s\S]*?)<\/tldr>\s*$/i;

function clip(s: string, words: number): string {
  const w = s.trim().split(/\s+/);
  return w.length <= words ? w.join(" ") : w.slice(0, words).join(" ") + "…";
}

/** Splits a reply into its body and the TL;DR it declared (if any, and parseable). */
export function splitTldr(text: string): { body: string; tldr?: Tldr } {
  const m = BLOCK.exec(text);
  if (!m) return { body: text.replace(/<tldr>[\s\S]*$/i, "").trimEnd() };
  const body = text.slice(0, m.index).trimEnd();
  let headline = "";
  let stance: Stance = "neutral";
  let confidence: number | undefined;
  const bullets: string[] = [];
  for (const line of m[1].split("\n").map((l) => l.trim())) {
    const kv = /^(headline|stance|confidence)\s*:\s*(.*)$/i.exec(line);
    if (kv) {
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === "headline") headline = val;
      else if (key === "stance") stance = STANCES.find((s) => val.toLowerCase().startsWith(s)) ?? "neutral";
      else if (/^\d+/.test(val)) confidence = Math.min(100, Number.parseInt(val, 10));
    } else if (/^[-*•]\s+/.test(line)) bullets.push(clip(line.replace(/^[-*•]\s+/, ""), 14));
  }
  if (!headline && !bullets.length) return { body };
  return { body, tldr: { headline: clip(headline || bullets[0], 12), bullets: bullets.slice(0, 3), stance, confidence } };
}

/** A best-effort digest for replies that skipped the block: lead sentence plus the first list items. */
export function fallbackTldr(body: string): Tldr {
  const plain = body.replace(/[*_`#>]/g, "").trim();
  const items = plain
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(\d+[.)]|[-•])\s+/.test(l))
    .map((l) => clip(l.replace(/^(\d+[.)]|[-•])\s+/, ""), 14));
  const first = /^(.+?[.!?])(\s|$)/s.exec(plain.replace(/\n+/g, " "))?.[1] ?? plain.split("\n")[0] ?? "";
  return { headline: clip(first, 12), bullets: items.slice(0, 3), stance: "neutral" };
}
