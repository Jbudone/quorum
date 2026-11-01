import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuotaWindow } from "../usage.js";
import type { Spend } from "./store.js";

/**
 * What a channel used, turn by turn, and the sittings it was used in. A sitting starts each time the
 * channel is opened. Every turn is priced twice: what it was billed (pay-per-token harnesses only) and
 * what it would cost at API list prices (every harness, so subscription use is on the same scale).
 */

/** One turn of one member or support role. */
export interface UsageRow {
  ts: string;
  agent: string;
  role: "member" | "support";
  cli: string;
  model?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** What it was billed, on a pay-per-token harness. */
  usd?: number;
  /** What it would cost at API list prices, when the model's price is known. */
  listUsd?: number;
}

export interface Sitting {
  start: string;
  /** Each harness's quota windows when the sitting started, to show how far they moved since. */
  quota?: Record<string, QuotaWindow[]>;
}

export interface Tally {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  usd: number;
  listUsd: number;
}

export interface UsageLine extends Tally {
  id: string;
  role?: "member" | "support";
  cli?: string;
  model?: string;
}

export interface UsageScope {
  total: Tally;
  byAgent: UsageLine[];
  byModel: UsageLine[];
  /** Project scope: one line per channel. */
  byChannel?: UsageLine[];
  /** Totals recorded before sittings were tracked, already counted in `total`. */
  legacy?: Tally;
}

export interface UsageReport {
  sitting: UsageScope & Sitting & { n: number };
  channel: UsageScope;
  sittings: { n: number; start: string; usd: number; listUsd: number }[];
  project?: UsageScope;
}

export const zero = (): Tally => ({ turns: 0, input: 0, output: 0, cacheRead: 0, usd: 0, listUsd: 0 });

function add<T extends Tally>(t: T, r: UsageRow): T {
  t.turns++;
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead ?? 0;
  t.usd += r.usd ?? 0;
  t.listUsd += r.listUsd ?? r.usd ?? 0;
  return t;
}

function merge(a: Tally, b: Tally): Tally {
  return { turns: a.turns + b.turns, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, usd: a.usd + b.usd, listUsd: a.listUsd + b.listUsd };
}

/** Spend.json's running totals, from before turns were recorded one by one. */
export function legacyTally(spend: Record<string, Spend>): Tally | undefined {
  const t = zero();
  for (const s of Object.values(spend)) {
    t.input += s.input;
    t.output += s.output;
    t.usd += s.usd ?? 0;
    t.listUsd += s.usd ?? 0;
  }
  return t.input || t.output || t.usd ? t : undefined;
}

const costliest = (a: UsageLine, b: UsageLine) => b.listUsd - a.listUsd || b.input + b.output - (a.input + a.output);

/** Totals for some rows, by member or role and by model. */
export function scope(rows: UsageRow[], legacy?: Tally): UsageScope {
  const total = zero();
  const agents = new Map<string, UsageLine>();
  const models = new Map<string, UsageLine>();
  for (const r of rows) {
    add(total, r);
    const a = agents.get(r.agent) ?? { id: r.agent, role: r.role, cli: r.cli, model: r.model, ...zero() };
    // A member moved to another model shows where it runs now.
    a.cli = r.cli;
    a.model = r.model;
    agents.set(r.agent, add(a, r));
    const key = `${r.cli} ${r.model ?? ""}`.trim();
    models.set(key, add(models.get(key) ?? { id: key, cli: r.cli, model: r.model, ...zero() }, r));
  }
  return {
    total: legacy ? merge(total, legacy) : total,
    byAgent: [...agents.values()].sort(costliest),
    byModel: [...models.values()].sort(costliest),
    ...(legacy ? { legacy } : {}),
  };
}

export function readJsonl<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export const appendJsonl = (path: string, v: unknown) => appendFileSync(path, `${JSON.stringify(v)}\n`);

/** The report for a channel: this sitting, the whole channel, and each sitting's total. */
export function report(rows: UsageRow[], sittings: Sitting[], legacy?: Tally): UsageReport {
  const cur = sittings.at(-1) ?? { start: rows[0]?.ts ?? new Date().toISOString() };
  const starts = sittings.map((s) => s.start);
  return {
    sitting: { ...scope(rows.filter((r) => r.ts >= cur.start)), ...cur, n: Math.max(sittings.length, 1) },
    channel: scope(rows, legacy),
    sittings: sittings.map((s, i) => {
      const t = zero();
      for (const r of rows) if (r.ts >= s.start && (i + 1 >= starts.length || r.ts < starts[i + 1])) add(t, r);
      return { n: i + 1, start: s.start, usd: t.usd, listUsd: t.listUsd };
    }),
  };
}

/** Every channel under the project, together and one line each. */
export function projectScope(root: string): UsageScope {
  let ids: string[] = [];
  try {
    ids = readdirSync(join(root, ".quorum", "rooms"));
  } catch {
    // no channels yet
  }
  const all: UsageRow[] = [];
  const channels: UsageLine[] = [];
  let legacy: Tally | undefined;
  for (const id of ids) {
    const dir = join(root, ".quorum", "rooms", id);
    let name = id;
    try {
      name = JSON.parse(readFileSync(join(dir, "room.json"), "utf8")).name || id;
    } catch {
      continue;
    }
    const rows = readJsonl<UsageRow>(join(dir, "usage.jsonl"));
    let old: Tally | undefined;
    try {
      old = legacyTally(JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")));
    } catch {
      // never spent anything
    }
    const s = scope(rows, old);
    if (!s.total.turns && !old) continue;
    all.push(...rows);
    if (old) legacy = legacy ? merge(legacy, old) : old;
    channels.push({ id: name, ...s.total });
  }
  return { ...scope(all, legacy), byChannel: channels.sort(costliest) };
}
