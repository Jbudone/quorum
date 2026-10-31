import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every vendor CLI session Quorum starts, appended to `<repo>/.quorum/vendor-sessions.jsonl`.
 * Agent state keeps only the session being resumed and drops it on refresh, so without this the
 * members' own transcripts (in each vendor's store) can't be found again. `scripts/history-sync.ts`
 * reads it to copy them into the history.
 */
export interface VendorSession {
  ts: string;
  /** The channel's room id; absent for planning a channel that doesn't exist yet. */
  room?: string;
  agent: string;
  cli: string;
  model?: string;
  session: string;
}

const seen = new Set<string>();

export function noteVendorSession(repo: string, s: Omit<VendorSession, "ts">): void {
  const key = `${s.cli}:${s.session}`;
  if (seen.has(key)) return;
  seen.add(key);
  try {
    mkdirSync(join(repo, ".quorum"), { recursive: true });
    appendFileSync(join(repo, ".quorum", "vendor-sessions.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...s })}\n`);
  } catch {
    // History is best effort; a turn never fails over it.
  }
}
