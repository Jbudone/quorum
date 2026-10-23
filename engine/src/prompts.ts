import type { TranscriptEntry } from "./session.js";

/** Renders the transcript for inclusion in a prompt, keeping only the most recent entries. */
export function renderTranscript(entries: TranscriptEntry[], max = 12): string {
  if (!entries.length) return "";
  const shown = entries.slice(-max);
  const omitted = entries.length - shown.length;
  return [
    "Discussion so far:",
    omitted > 0 ? `(${omitted} earlier messages omitted)` : "",
    ...shown.map((e) => `[round ${e.round}] ${e.speaker}: ${e.text}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}
