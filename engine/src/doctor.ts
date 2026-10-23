import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliName, CouncilConfig } from "./config.js";
import { createTransport, type AgentTransport } from "./transports/index.js";

export const REAL_CLIS: CliName[] = ["claude", "codex", "agy", "opencode", "gemini"];
const HEALTH_TTL_MS = 24 * 3600_000;

export interface CliHealth {
  ok: boolean;
  checkedAt: number;
  ms?: number;
  error?: string;
  /** Subscription quota used in the current window, 0..1, if the CLI reports it. */
  quotaUtilization?: number;
}
export type HealthReport = Partial<Record<CliName, CliHealth>>;

export const defaultHealthPath = (): string =>
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "quorum", "health.json");

export function installedClis(which = (bin: string) => spawnSync("which", [bin]).status === 0): CliName[] {
  const found = REAL_CLIS.filter((c) => which(c));
  // Gemini CLI was replaced by agy (Antigravity); it only still works for enterprise licenses, so
  // when agy is present, probing it just reports a failure nobody can act on.
  return found.includes("agy") ? found.filter((c) => c !== "gemini") : found;
}

/** Sends one tiny read-only turn through a transport; healthy only if it answers cleanly. */
export async function probe(transport: AgentTransport, timeoutMs = 90_000): Promise<CliHealth> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let text = "";
  let error: string | undefined;
  let done = false;
  let quota: number | undefined;
  try {
    for await (const e of transport.send("Reply with exactly the word: ok", { readOnly: true, signal: ac.signal })) {
      if (e.type === "text") text += e.delta;
      else if (e.type === "error") error ??= e.message;
      else if (e.type === "done") done = true;
      else if (e.type === "usage" && e.quotaUtilization !== undefined) quota = e.quotaUtilization;
    }
  } catch (e) {
    error ??= e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  if (ac.signal.aborted) error ??= `timed out after ${timeoutMs / 1000}s`;
  const ok = !error && done && text.trim().length > 0;
  return {
    ok,
    checkedAt: Date.now(),
    ms: Date.now() - t0,
    quotaUtilization: quota,
    error: ok ? undefined : (error ?? "no reply").split("\n")[0].slice(0, 240),
  };
}

export async function doctor(
  clis: CliName[] = installedClis(),
  make: (cli: CliName) => AgentTransport = (cli) => createTransport({ id: cli, cli }),
): Promise<HealthReport> {
  const entries = await Promise.all(clis.map(async (c) => [c, await probe(make(c))] as const));
  return Object.fromEntries(entries);
}

export function readHealth(path = defaultHealthPath()): HealthReport {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function writeHealth(report: HealthReport, path = defaultHealthPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...readHealth(path), ...report }, null, 2));
}

/**
 * CLIs we should use: installed, and not known broken. A recent failed probe excludes a CLI;
 * anything never probed (or probed long ago) is trusted if it is installed.
 */
export function usableClis(installed: CliName[], health: HealthReport, now = Date.now()): CliName[] {
  return installed.filter((c) => {
    const h = health[c];
    return !(h && !h.ok && now - h.checkedAt < HEALTH_TTL_MS);
  });
}

export interface Substitution {
  agent: string;
  from: CliName;
  to: CliName;
}

/**
 * Replaces agents whose CLI is unusable with usable ones, preferring CLIs not yet in the council
 * and spreading the rest round-robin. Mock agents are left alone. Throws if nothing is usable.
 */
export function resolveAvailable(
  config: CouncilConfig,
  usable: CliName[],
): { config: CouncilConfig; substitutions: Substitution[] } {
  const substitutions: Substitution[] = [];
  if (!usable.length && config.agents.some((a) => a.cli !== "mock")) {
    throw new Error("no agent CLI is usable: install and sign in to claude, codex, opencode or gemini (see `doctor`)");
  }
  // Prefer CLIs the council is not already using, to keep vendor diversity.
  const inUse = new Set<CliName>([...config.agents.map((a) => a.cli), config.chair.cli]);
  const fresh = usable.filter((c) => !inUse.has(c));
  const pool = fresh.length ? fresh : usable;
  let next = 0;
  const pick = (id: string, cli: CliName): CliName => {
    if (cli === "mock" || usable.includes(cli)) return cli;
    const to = pool[next++ % pool.length];
    substitutions.push({ agent: id, from: cli, to });
    return to;
  };
  return {
    config: {
      ...config,
      agents: config.agents.map((a) => {
        const cli = pick(a.id, a.cli);
        return cli === a.cli ? a : { ...a, cli, model: undefined };
      }),
      chair: { ...config.chair, cli: pick("chair", config.chair.cli) },
    },
    substitutions,
  };
}
