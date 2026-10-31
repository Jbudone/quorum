import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { CLIS, userDir, type CliName } from "./config.js";

/**
 * The human's providers, harness preferences and favourite models, in `<config>/quorum/providers.toml`.
 * Quorum writes this file from its Providers & models screen; it's plain TOML so it can be edited
 * by hand too. Keys are never stored: a provider names the environment variable that holds its key.
 */
export interface ProviderConfig {
  /** Display name, for a custom provider. */
  name?: string;
  /** The env var holding the key, when it isn't the one models.dev names (e.g. a personal `MY_OPENROUTER_KEY`). */
  env?: string;
  /** An OpenAI-compatible endpoint, for a custom provider (LM Studio, vLLM, a proxy). Run through opencode. */
  baseUrl?: string;
  /** Models a custom provider serves. */
  models?: string[];
  /** Hidden from the model search. */
  hidden?: boolean;
}

export interface ProvidersFile {
  /** Preferred harness first, when a model can run on several. */
  harnesses: CliName[];
  /** Catalog keys (`provider/model`) starred in the model search. */
  favourites: string[];
  providers: Record<string, ProviderConfig>;
}

/** Harness order when the human hasn't set one: vendor CLIs on their subscriptions first. */
export const DEFAULT_HARNESS_ORDER: CliName[] = ["claude", "codex", "agy", "kimi", "zcode", "opencode", "gemini"];

const HEADER = `# Quorum's providers, harness order and favourite models.
# Written by the Providers & models screen (alt+m); safe to edit by hand.
# Keys are never stored here: each provider names the env var that holds its key.
`;

export const providersPath = (user = userDir()) => join(user, "providers.toml");

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function readProviders(user = userDir()): ProvidersFile {
  let raw: any = {};
  try {
    if (existsSync(providersPath(user))) raw = parse(readFileSync(providersPath(user), "utf8"));
  } catch {
    raw = {};
  }
  const order = strings(raw.harnesses).filter((c): c is CliName => (CLIS as string[]).includes(c) && c !== "mock");
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries<any>(raw.providers ?? {})) {
    if (!p || typeof p !== "object") continue;
    providers[id] = {
      ...(typeof p.name === "string" ? { name: p.name } : {}),
      ...(typeof p.env === "string" && p.env ? { env: p.env } : {}),
      ...(typeof p.base_url === "string" && p.base_url ? { baseUrl: p.base_url } : {}),
      ...(Array.isArray(p.models) ? { models: strings(p.models) } : {}),
      ...(p.hidden === true ? { hidden: true } : {}),
    };
  }
  return {
    harnesses: [...order, ...DEFAULT_HARNESS_ORDER.filter((c) => !order.includes(c))],
    favourites: strings(raw.favourites),
    providers,
  };
}

export function writeProviders(f: ProvidersFile, user = userDir()): void {
  const providers: Record<string, any> = {};
  for (const [id, p] of Object.entries(f.providers)) {
    const t: Record<string, unknown> = {};
    if (p.name) t.name = p.name;
    if (p.env) t.env = p.env;
    if (p.baseUrl) t.base_url = p.baseUrl;
    if (p.models?.length) t.models = p.models;
    if (p.hidden) t.hidden = true;
    if (Object.keys(t).length) providers[id] = t;
  }
  const body = stringify({ harnesses: f.harnesses, favourites: f.favourites, ...(Object.keys(providers).length ? { providers } : {}) });
  mkdirSync(user, { recursive: true });
  writeFileSync(providersPath(user), `${HEADER}\n${body}\n`);
}

export function updateProviders(fn: (f: ProvidersFile) => void, user = userDir()): ProvidersFile {
  const f = readProviders(user);
  fn(f);
  writeProviders(f, user);
  return f;
}

/**
 * Makes a key the human keeps under their own env var name visible under the name harnesses look
 * for (the first one models.dev lists). Run once at startup; never overrides a variable already set.
 */
export function applyProviderEnv(canonical: (provider: string) => string | undefined, f = readProviders(), env = process.env): void {
  for (const [id, p] of Object.entries(f.providers)) {
    const want = canonical(id);
    if (p.env && want && want !== p.env && !env[want] && env[p.env]) env[want] = env[p.env];
  }
}

// ---- recently used models (state, not config) ----

const recentPath = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "quorum", "recent-models.json");
const RECENT_MAX = 30;

/** Catalog key → when it was last picked (ms since epoch). */
export function readRecent(file = recentPath()): Record<string, number> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export function noteRecent(key: string, file = recentPath(), now = Date.now()): void {
  const r = { ...readRecent(file), [key]: now };
  const kept = Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .slice(0, RECENT_MAX);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(kept), null, 1));
  } catch {
    // Recents are a convenience; never fail a pick over them.
  }
}
