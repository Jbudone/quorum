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
  /** The most recently revised document, and what the room said and decided after that version. */
  docLag?: DocLag;
  /** Member messages about a probe or experiment since mail last went to the project's agents. */
  unsentProbes: number;
}

export interface DocLag {
  slug: string;
  version: number;
  /** Member messages since that version was saved. */
  messages: number;
  /** Decisions the floor tagged since then. */
  decisions: number;
}

const PROGRESS = new Set(["topic.raised", "topic.focus", "topic.closed", "doc.revised", "doc.accepted"]);
const REPEAT = 0.6;

export const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

/** Overlap of a with b relative to the smaller set, so a short echo of a long message still counts. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

/** Words that mark a message as proposing or describing a test of a claim, rather than arguing it. */
export const PROBE = /\b(probes?|experiments?|ablations?|pilot runs?|spike)\b/i;

/** What has happened since the latest version of each document (or only the most recent one). */
export function docLags(events: readonly RoomEvent[], members: string[]): DocLag[] {
  const who = new Set(members);
  const latest = new Map<string, { version: number; i: number }>();
  events.forEach((e, i) => {
    if (e.type === "doc.revised") latest.set(e.slug, { version: e.version, i });
  });
  return [...latest].map(([slug, { version, i }]) => {
    let messages = 0;
    let decisions = 0;
    for (const e of events.slice(i + 1)) {
      if (isMember(e, who)) messages++;
      if (e.type === "tags") decisions += e.items.filter((t) => t.kind === "decision" && who.has(t.from)).length;
    }
    return { slug, version, messages, decisions };
  });
}

/** Member messages that talk about a probe since the last mail went out. */
export function unsentProbes(events: readonly RoomEvent[], members: string[]): number {
  const who = new Set(members);
  let n = 0;
  for (let i = events.length - 1; i >= 0 && events[i].type !== "mail.out"; i--) {
    const e = events[i];
    if (e.type === "message" && who.has(e.from) && PROBE.test(e.text)) n++;
  }
  return n;
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
  let docLag: DocLag | undefined;
  for (let i = events.length - 1; i >= 0 && !docLag; i--) {
    const e = events[i];
    if (e.type === "doc.revised") docLag = docLags(events, members).find((d) => d.slug === e.slug);
  }
  return {
    sinceProgress,
    passStreak,
    repetition: Math.round(repetition * 100) / 100,
    repeats,
    ...(docLag ? { docLag } : {}),
    unsentProbes: unsentProbes(events, members),
  };
}

/** True when the signals alone justify waking the assistant to look. */
export const looksStuck = (s: Signals): boolean => s.repeats >= 2 || (s.sinceProgress > 0 && s.sinceProgress % 20 === 0);

/**
 * True when the room is talking past its own record: decisions piling up after the document was
 * last saved, or probes discussed and never sent. The caller limits how often this wakes anyone.
 */
export const looksAdrift = (s: Signals): boolean => (s.docLag?.decisions ?? 0) >= 3 || s.unsentProbes >= 4;

export function describeSignals(s: Signals): string {
  return [
    `${s.sinceProgress} member messages since the last topic change or document revision`,
    `${s.repeats} of the last 3 member messages largely repeat earlier ones (latest overlap ${Math.round(s.repetition * 100)}%)`,
    s.passStreak ? `${s.passStreak} passes in a row` : "",
    s.docLag && (s.docLag.decisions || s.docLag.messages >= 4)
      ? `${s.docLag.slug} v${s.docLag.version} was saved ${s.docLag.messages} member messages ago and ${s.docLag.decisions} decisions since aren't in it`
      : "",
    s.unsentProbes ? `${s.unsentProbes} member messages discuss a probe or experiment and no mail has gone to the project's agents since` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
