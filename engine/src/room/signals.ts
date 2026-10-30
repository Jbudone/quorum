import type { RoomEvent } from "./store.js";

/**
 * Cheap, model-free measures of whether a room is moving. The assistant reads them when deciding
 * whether the room has tunnel vision; nothing pauses on them alone.
 */
export interface Signals {
  /** Member messages since the last sign of progress (a topic change, document revision or acceptance). */
  sinceProgress: number;
  /** Trailing passes in a row. */
  passStreak: number;
  /** How much the latest member message repeats the ten before it, 0..1 (word overlap). */
  repetition: number;
  /** Of the last three member messages, how many repeat earlier ones (repetition >= 0.6). */
  repeats: number;
}

const PROGRESS = new Set(["topic.raised", "topic.focus", "topic.closed", "doc.revised", "doc.accepted"]);
const REPEAT = 0.6;

const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

/** Overlap of a with b relative to the smaller set, so a short echo of a long message still counts. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

const isMember = (e: RoomEvent, members: Set<string>) => e.type === "message" && members.has(e.from);

export function computeSignals(events: readonly RoomEvent[], members: string[]): Signals {
  const who = new Set(members);
  let sinceProgress = 0;
  for (let i = events.length - 1; i >= 0 && !PROGRESS.has(events[i].type); i--) if (isMember(events[i], who)) sinceProgress++;

  let passStreak = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "pass") passStreak++;
    else if (e.type === "message") break;
  }

  const texts = events.filter((e) => isMember(e, who)).map((e) => (e.type === "message" ? words(e.text) : new Set<string>()));
  const rep = (i: number) => Math.max(0, ...texts.slice(Math.max(0, i - 10), i).map((t) => overlap(texts[i], t)));
  const last = texts.length - 1;
  const repetition = last > 0 ? rep(last) : 0;
  let repeats = 0;
  for (let i = Math.max(1, last - 2); i <= last; i++) if (rep(i) >= REPEAT) repeats++;
  return { sinceProgress, passStreak, repetition: Math.round(repetition * 100) / 100, repeats };
}

/** True when the signals alone justify waking the assistant to look. */
export const looksStuck = (s: Signals): boolean => s.repeats >= 2 || (s.sinceProgress > 0 && s.sinceProgress % 20 === 0);

export function describeSignals(s: Signals): string {
  return [
    `${s.sinceProgress} member messages since the last topic change or document revision`,
    `${s.repeats} of the last 3 member messages largely repeat earlier ones (latest overlap ${Math.round(s.repetition * 100)}%)`,
    s.passStreak ? `${s.passStreak} passes in a row` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
