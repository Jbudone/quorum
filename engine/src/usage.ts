import { execFile } from "node:child_process";
import type { CliName } from "./config.js";

/**
 * Quota left on each harness's subscription, and balances on pay-per-token providers, read from
 * OpenUsage (openusage.sh) when it's installed: it already knows how to read every vendor's limits.
 */

export interface QuotaWindow {
  /** The window it counts over, as the vendor names it ("5h", "7d"). */
  label: string;
  /** Fraction used, 0..1. */
  used: number;
  resetsAt?: string;
}

export interface HarnessMeter {
  cli: CliName;
  windows: QuotaWindow[];
}

export interface Balance {
  provider: string;
  name: string;
  remainingUsd: number;
  limitUsd?: number;
}

export interface Meters {
  harnesses: HarnessMeter[];
  balances: Balance[];
  /** "openusage" when it answered; "none" when it isn't installed or failed (see error). */
  source: "openusage" | "none";
  at: string;
  error?: string;
}

/** OpenUsage's provider ids for the harnesses Quorum runs. */
const HARNESS: Record<string, CliName> = {
  claude_code: "claude",
  codex: "codex",
  antigravity: "agy",
  gemini_cli: "gemini",
  kimi_cli: "kimi",
  zcode: "zcode",
  opencode: "opencode",
};

const NAMES: Record<string, string> = { openrouter: "OpenRouter", deepseek: "DeepSeek", moonshot: "Moonshot", zai: "Z.AI", mistral: "Mistral", xai: "xAI", groq: "Groq", opencode: "OpenCode Zen" };

/** Reads `openusage export` JSON: quota windows per harness, and money left per provider. */
export function parseOpenUsage(json: string, at = new Date().toISOString()): Meters {
  const d = JSON.parse(json);
  const harnesses: HarnessMeter[] = [];
  const balances: Balance[] = [];
  for (const s of Array.isArray(d?.snapshots) ? d.snapshots : []) {
    if (s?.status !== "OK") continue;
    const metrics: Record<string, any> = s.metrics ?? {};
    const cli = HARNESS[s.provider_id];
    if (cli) {
      const windows: QuotaWindow[] = [];
      for (const [k, m] of Object.entries(metrics)) {
        if (!/^(usage_|rate_limit_)/.test(k) || m?.unit !== "%" || typeof m.used !== "number") continue;
        const label = String(m.window ?? k);
        if (windows.some((w) => w.label === label)) continue;
        windows.push({ label, used: Math.min(1, Math.max(0, m.used / (m.limit || 100))), ...(s.resets?.[k] ? { resetsAt: String(s.resets[k]) } : {}) });
      }
      // The shortest window first: it's the one that runs out mid-discussion.
      windows.sort((a, b) => hours(a.label) - hours(b.label));
      if (windows.length) harnesses.push({ cli, windows });
    }
    for (const [k, m] of Object.entries(metrics)) {
      if (m?.unit !== "USD" || typeof m.remaining !== "number" || !/balance|credit/.test(k)) continue;
      balances.push({ provider: s.provider_id, name: NAMES[s.provider_id] ?? s.provider_id, remainingUsd: m.remaining, ...(typeof m.limit === "number" ? { limitUsd: m.limit } : {}) });
      break;
    }
  }
  return { harnesses, balances, source: "openusage", at };
}

/** "5h" → 5, "7d" → 168; anything else sorts last. */
function hours(label: string): number {
  const m = /^(\d+)\s*([hd])/.exec(label);
  return m ? Number(m[1]) * (m[2] === "d" ? 24 : 1) : 1e6;
}

let cached: { at: number; meters: Meters } | undefined;
const FRESH_MS = 60_000;

/** The current meters, at most a minute old. OpenUsage answers from its daemon's cache, so this is quick. */
export function meters(refresh = false, bin = "openusage"): Promise<Meters> {
  if (!refresh && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.meters);
  return new Promise((resolve) =>
    execFile(bin, ["export", "--output", "-"], { timeout: 15_000, maxBuffer: 32 << 20 }, (err, out) => {
      const at = new Date().toISOString();
      let m: Meters;
      try {
        if (err) throw err;
        m = parseOpenUsage(String(out), at);
      } catch (e: any) {
        const missing = e?.code === "ENOENT";
        m = { harnesses: [], balances: [], source: "none", at, error: missing ? "install OpenUsage (openusage.sh) to see quotas and balances" : String(e?.message ?? e) };
      }
      cached = { at: Date.now(), meters: m };
      resolve(m);
    }),
  );
}
