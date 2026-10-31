import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliName } from "./config.js";
import { cliInfo, type CliInfo } from "./doctor.js";
import { listModels, type ModelInfo } from "./models.js";
import { applyProviderEnv, readProviders, readRecent, type ProvidersFile } from "./providers.js";

/**
 * Every model Quorum knows of, and how to run each one. Metadata (names, context, prices,
 * capabilities) comes from models.dev, the open catalog opencode uses; what can actually run comes
 * from each installed harness's own list, the keys set in the environment, the human's custom
 * providers, and a local ollama.
 */

/** One way to run a model: a harness and the id its --model flag takes. */
export interface Route {
  harness: CliName;
  id: string;
  /** Shown beside the harness, e.g. an effort level ("high") or "via openrouter". */
  label?: string;
  ready: boolean;
  /** What's missing when not ready, e.g. "set OPENROUTER_API_KEY". */
  needs?: string;
}

export interface CatalogModel {
  /** `provider/model`, as models.dev and opencode name it. */
  key: string;
  provider: string;
  providerName: string;
  model: string;
  name: string;
  family?: string;
  context?: number;
  output?: number;
  /** USD per million tokens. */
  cost?: { input: number; output: number };
  reasoning?: boolean;
  tools?: boolean;
  vision?: boolean;
  openWeights?: boolean;
  released?: string;
  /** Preferred route first. */
  routes: Route[];
  runnable: boolean;
  favourite: boolean;
  /** When the human last picked it (ms since epoch). */
  lastUsed?: number;
}

export interface HarnessInfo {
  cli: CliName;
  usable: boolean;
  error?: string;
  quotaUtilization?: number;
  /** Runs models from any provider with a key (opencode), not just its vendor's. */
  anyProvider: boolean;
  models: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** Env vars models.dev says hold the key. */
  env: string[];
  /** The env var the human set for it, if not the usual one. */
  keyVar?: string;
  keySet: boolean;
  baseUrl?: string;
  custom: boolean;
  hidden: boolean;
  doc?: string;
  models: number;
  runnable: number;
}

export interface Catalog {
  models: CatalogModel[];
  harnesses: HarnessInfo[];
  providers: ProviderInfo[];
  harnessOrder: CliName[];
  /** Where the metadata came from, and how old it is. */
  source: { from: string; at?: number };
}

// ---- models.dev ----

interface DevModel {
  id: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  open_weights?: boolean;
  release_date?: string;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}
interface DevProvider {
  id: string;
  name?: string;
  env?: string[];
  api?: string;
  doc?: string;
  models: Record<string, DevModel>;
}
export type ModelsDev = Record<string, DevProvider>;

const cacheDir = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
const OWN = () => join(cacheDir(), "quorum", "models.dev.json");
const OPENCODE = () => join(cacheDir(), "opencode", "models.json");
const DAY = 24 * 3600_000;

const age = (f: string) => {
  try {
    return Date.now() - statSync(f).mtimeMs;
  } catch {
    return Infinity;
  }
};

/** models.dev's catalog: our own copy or opencode's while fresh, else downloaded, else any stale copy. */
export async function loadModelsDev(doFetch: typeof fetch = fetch): Promise<{ data: ModelsDev; from: string; at?: number }> {
  const read = (f: string) => {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as ModelsDev;
    } catch {
      return undefined;
    }
  };
  const fresh = [OWN(), OPENCODE()].filter((f) => age(f) < (f === OWN() ? DAY : 7 * DAY)).sort((a, b) => age(a) - age(b));
  for (const f of fresh) {
    const d = read(f);
    if (d) return { data: d, from: f, at: Date.now() - age(f) };
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    const res = await doFetch("https://models.dev/api.json", { signal: ctl.signal });
    clearTimeout(t);
    if (res.ok) {
      const text = await res.text();
      const d = JSON.parse(text) as ModelsDev;
      mkdirSync(dirname(OWN()), { recursive: true });
      writeFileSync(OWN(), text);
      return { data: d, from: "https://models.dev/api.json", at: Date.now() };
    }
  } catch {
    // Offline: fall back to whatever copy exists.
  }
  for (const f of [OWN(), OPENCODE()].sort((a, b) => age(a) - age(b))) {
    const d = read(f);
    if (d) return { data: d, from: f, at: Date.now() - age(f) };
  }
  return { data: {}, from: "none" };
}

// ---- local ollama ----

export function parseOllamaList(out: string): string[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n): n is string => Boolean(n));
}

async function ollamaModels(): Promise<string[] | undefined> {
  return new Promise((resolve) =>
    execFile("ollama", ["list"], { timeout: 5000 }, (err, out) => resolve(err ? undefined : parseOllamaList(String(out)))),
  );
}

export const OLLAMA_URL = "http://localhost:11434/v1";

// ---- building ----

export interface CatalogInputs {
  dev: ModelsDev;
  /** Installed harnesses and their health. */
  clis: CliInfo[];
  /** Each installed harness's own model list. */
  lists: Partial<Record<CliName, ModelInfo[]>>;
  config: ProvidersFile;
  recent: Record<string, number>;
  env: NodeJS.ProcessEnv;
  /** Models a local ollama serves, if it's running. */
  ollama?: string[];
}

/** Harnesses that run any provider's models given a key, rather than only their vendor's. */
const ANY_PROVIDER: CliName[] = ["opencode"];
/** The provider each vendor harness runs. */
const VENDOR: Partial<Record<CliName, string>> = { claude: "anthropic", codex: "openai", agy: "google", gemini: "google" };
const EFFORT = /-(minimal|low|medium|high|xhigh|max)$/;

export function buildCatalog(i: CatalogInputs): Omit<Catalog, "source"> {
  const order = i.config.harnesses;
  const rank = (h: CliName) => {
    const n = order.indexOf(h);
    return n < 0 ? order.length : n;
  };
  const usable = new Set(i.clis.filter((c) => c.usable).map((c) => c.cli));
  const installed = new Set(i.clis.map((c) => c.cli));
  const byKey = new Map<string, CatalogModel>();
  const providerNames = new Map<string, string>();
  const hidden = new Set(Object.entries(i.config.providers).filter(([, p]) => p.hidden).map(([id]) => id));

  const entry = (provider: string, m: DevModel): CatalogModel => ({
    key: `${provider}/${m.id}`,
    provider,
    providerName: providerNames.get(provider) ?? provider,
    model: m.id,
    name: m.name ?? m.id,
    ...(m.family ? { family: m.family } : {}),
    ...(m.limit?.context ? { context: m.limit.context } : {}),
    ...(m.limit?.output ? { output: m.limit.output } : {}),
    ...(m.cost && (m.cost.input !== undefined || m.cost.output !== undefined) ? { cost: { input: m.cost.input ?? 0, output: m.cost.output ?? 0 } } : {}),
    ...(m.reasoning ? { reasoning: true } : {}),
    ...(m.tool_call ? { tools: true } : {}),
    ...(m.attachment || m.modalities?.input?.includes("image") ? { vision: true } : {}),
    ...(m.open_weights ? { openWeights: true } : {}),
    ...(m.release_date ? { released: m.release_date } : {}),
    routes: [],
    runnable: false,
    favourite: false,
  });

  for (const p of Object.values(i.dev)) {
    if (!p?.id || hidden.has(p.id)) continue;
    providerNames.set(p.id, p.name ?? p.id);
    for (const m of Object.values(p.models ?? {})) if (m?.id) byKey.set(`${p.id}/${m.id}`, entry(p.id, m));
  }

  // Lower-cased index, for harnesses that spell ids differently (ZCode's "GLM-5.3").
  const loose = new Map<string, CatalogModel>();
  for (const m of byKey.values()) loose.set(m.key.toLowerCase(), m);
  const find = (key: string) => byKey.get(key) ?? loose.get(key.toLowerCase());
  const ensure = (key: string, name?: string): CatalogModel => {
    const hit = find(key);
    if (hit) return hit;
    const slash = key.indexOf("/");
    const provider = slash > 0 ? key.slice(0, slash) : "other";
    const m = entry(provider, { id: slash > 0 ? key.slice(slash + 1) : key, name });
    byKey.set(m.key, m);
    loose.set(m.key.toLowerCase(), m);
    return m;
  };
  const route = (m: CatalogModel, r: Route) => {
    if (!m.routes.some((x) => x.harness === r.harness && x.id === r.id)) m.routes.push(r);
  };

  for (const [cli, list] of Object.entries(i.lists) as [CliName, ModelInfo[]][]) {
    if (!installed.has(cli) || cli === "mock") continue;
    const ready = usable.has(cli);
    const needs = ready ? undefined : `${cli} isn't working (run the doctor)`;
    for (const info of list) {
      if (cli === "claude" && !info.id.includes("-")) continue; // aliases; the full ids are routed below
      let key = info.key ?? (VENDOR[cli] ? `${VENDOR[cli]}/${info.id}` : info.id);
      let label: string | undefined;
      // agy names effort levels as separate models, and runs Claude and GPT-OSS too: one catalog
      // entry per model, a route per effort.
      if (cli === "agy" && !find(key)) {
        const effort = EFFORT.exec(info.id)?.[1];
        const base = info.id.replace(EFFORT, "");
        const hit = ["google", "anthropic", "openai"].map((p) => `${p}/${base}`).find((k) => find(k));
        if (hit) {
          key = hit;
          label = [effort, hit.startsWith("google/") ? undefined : "via Antigravity"].filter(Boolean).join(", ") || undefined;
        }
      }
      const m = ensure(key, info.label);
      route(m, { harness: cli, id: info.id, ready, ...(label ? { label } : {}), ...(needs ? { needs } : {}) });
    }
  }
  // Claude's CLI runs every Anthropic model by full id.
  if (installed.has("claude")) {
    for (const m of byKey.values()) if (m.provider === "anthropic") route(m, { harness: "claude", id: m.model, ready: usable.has("claude") });
  }
  // Gemini's CLI, where it still works, runs Google's models.
  if (installed.has("gemini") && !installed.has("agy")) {
    for (const m of byKey.values()) if (m.provider === "google") route(m, { harness: "gemini", id: m.model, ready: usable.has("gemini") });
  }

  // Custom providers and a local ollama run through opencode, which Quorum configures per turn.
  const custom: [string, { name: string; models: string[]; env?: string }][] = Object.entries(i.config.providers)
    .filter(([, p]) => p.baseUrl)
    .map(([id, p]) => [id, { name: p.name ?? id, models: p.models ?? [], env: p.env }]);
  if (i.ollama?.length && !i.config.providers.ollama?.hidden) custom.push(["ollama", { name: "Ollama (local)", models: i.ollama }]);
  for (const [id, p] of custom) {
    providerNames.set(id, p.name);
    for (const model of p.models) {
      const m = ensure(`${id}/${model}`, model);
      m.providerName = p.name;
      const keyOk = !p.env || Boolean(i.env[p.env]);
      if (installed.has("opencode"))
        route(m, { harness: "opencode", id: m.key, ready: usable.has("opencode") && keyOk, ...(keyOk ? {} : { needs: `set ${p.env}` }) });
    }
  }

  // opencode can run anything else whose key is set; otherwise say which key it needs.
  const keyVar = (provider: string) => i.config.providers[provider]?.env;
  const keyFor = (provider: string): { set: boolean; name?: string } => {
    const names = [keyVar(provider), ...(i.dev[provider]?.env ?? [])].filter((x): x is string => Boolean(x));
    return { set: names.some((n) => Boolean(i.env[n])), name: names[0] };
  };
  if (installed.has("opencode")) {
    for (const m of byKey.values()) {
      if (m.routes.some((r) => r.harness === "opencode") || !i.dev[m.provider]) continue;
      const k = keyFor(m.provider);
      route(m, {
        harness: "opencode",
        id: m.key,
        ready: usable.has("opencode") && k.set,
        ...(k.set ? {} : { needs: k.name ? `set ${k.name}` : "configure this provider in opencode" }),
      });
    }
  }

  const favs = new Set(i.config.favourites);
  const models = [...byKey.values()].filter((m) => !hidden.has(m.provider));
  for (const m of models) {
    m.providerName = providerNames.get(m.provider) ?? m.providerName;
    m.routes.sort((a, b) => Number(b.ready) - Number(a.ready) || rank(a.harness) - rank(b.harness));
    m.runnable = m.routes.some((r) => r.ready);
    m.favourite = favs.has(m.key);
    const used = i.recent[m.key];
    if (used) m.lastUsed = used;
  }
  models.sort((a, b) => Number(b.runnable) - Number(a.runnable) || a.providerName.localeCompare(b.providerName) || (b.released ?? "").localeCompare(a.released ?? "") || a.name.localeCompare(b.name));

  const harnesses: HarnessInfo[] = i.clis
    .filter((c) => c.cli !== "mock")
    .map((c) => ({
      cli: c.cli,
      usable: c.usable,
      ...(c.error ? { error: c.error } : {}),
      ...(c.quotaUtilization !== undefined ? { quotaUtilization: c.quotaUtilization } : {}),
      anyProvider: ANY_PROVIDER.includes(c.cli),
      models: models.filter((m) => m.routes.some((r) => r.harness === c.cli)).length,
    }))
    .sort((a, b) => rank(a.cli) - rank(b.cli));

  const providerIds = new Set([...Object.keys(i.dev), ...custom.map(([id]) => id), ...Object.keys(i.config.providers)]);
  const providers: ProviderInfo[] = [...providerIds]
    .map((id) => {
      const d = i.dev[id];
      const c = i.config.providers[id];
      const own = models.filter((m) => m.provider === id);
      const k = keyFor(id);
      return {
        id,
        name: c?.name ?? providerNames.get(id) ?? d?.name ?? id,
        env: d?.env ?? [],
        ...(c?.env ? { keyVar: c.env } : {}),
        keySet: k.set || (id === "ollama" && Boolean(i.ollama?.length)),
        ...(c?.baseUrl ? { baseUrl: c.baseUrl } : id === "ollama" && i.ollama ? { baseUrl: OLLAMA_URL } : {}),
        custom: Boolean(c?.baseUrl) || (id === "ollama" && !d),
        hidden: Boolean(c?.hidden),
        ...(d?.doc ? { doc: d.doc } : {}),
        models: own.length || (d ? Object.keys(d.models ?? {}).length : 0),
        runnable: own.filter((m) => m.runnable).length,
      };
    })
    .sort((a, b) => b.runnable - a.runnable || Number(b.keySet) - Number(a.keySet) || a.name.localeCompare(b.name));

  return { models, harnesses, providers, harnessOrder: order };
}

let cached: { at: number; catalog: Catalog } | undefined;
const FRESH_MS = 5 * 60_000;

/** The catalog, built from what's installed now (cached a few minutes; `refresh` rebuilds it). */
export async function getCatalog(refresh = false): Promise<Catalog> {
  if (!refresh && cached && Date.now() - cached.at < FRESH_MS) {
    // Favourites and recents change between builds; re-apply them without re-asking every CLI.
    const config = readProviders();
    const favs = new Set(config.favourites);
    const recent = readRecent();
    for (const m of cached.catalog.models) {
      m.favourite = favs.has(m.key);
      if (recent[m.key]) m.lastUsed = recent[m.key];
    }
    return cached.catalog;
  }
  const clis = cliInfo();
  const [dev, ollama, ...lists] = await Promise.all([
    loadModelsDev(),
    ollamaModels(),
    ...clis.map((c) => listModels(c.cli)),
  ]);
  applyProviderEnv(canonicalEnv(dev.data));
  const built = buildCatalog({
    dev: dev.data,
    clis,
    lists: Object.fromEntries(clis.map((c, n) => [c.cli, lists[n]])),
    config: readProviders(),
    recent: readRecent(),
    env: process.env,
    ...(ollama ? { ollama } : {}),
  });
  const catalog = { ...built, source: { from: dev.from, ...(dev.at ? { at: dev.at } : {}) } };
  cached = { at: Date.now(), catalog };
  return catalog;
}

/** The provider env var harnesses look for, from models.dev (for `applyProviderEnv`). */
export function canonicalEnv(dev: ModelsDev): (provider: string) => string | undefined {
  return (p) => dev[p]?.env?.[0];
}

/** Drops the cached catalog, after the human changes providers or the harness order. */
export function resetCatalog(): void {
  cached = undefined;
}

/** A small fixed catalog for mock mode and tests: no CLI is asked, nothing is downloaded. */
export function mockCatalog(config: ProvidersFile = { harnesses: ["claude", "codex", "opencode"], favourites: [], providers: {} }, recent: Record<string, number> = {}): Catalog {
  const m = (id: string, name: string, context: number, input: number, output: number, extra: Partial<DevModel> = {}): DevModel => ({
    id, name, limit: { context, output: 64_000 }, cost: { input, output }, tool_call: true, release_date: "2026-09-01", ...extra,
  });
  const dev: ModelsDev = {
    anthropic: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: {
      "claude-opus-5-5": m("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 5, 25, { reasoning: true, attachment: true }),
      "claude-sonnet-5-5": m("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, 3, 15, { reasoning: true }),
      "claude-haiku-5-5": m("claude-haiku-5-5", "Claude Haiku 5.5", 200_000, 1, 5),
    } },
    openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], models: {
      "gpt-6-astra": m("gpt-6-astra", "GPT-6 Astra", 400_000, 2, 12, { reasoning: true }),
    } },
    openrouter: { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"], models: {
      "moonshotai/kimi-k3": m("moonshotai/kimi-k3", "Kimi K3", 256_000, 0.6, 2.5, { open_weights: true }),
      "qwen/qwen3.8-max": m("qwen/qwen3.8-max", "Qwen3.8 Max", 256_000, 1.2, 6),
      "deepseek/deepseek-v4-pro": m("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 128_000, 0.3, 1.1, { open_weights: true, reasoning: true }),
    } },
    mistral: { id: "mistral", name: "Mistral", env: ["MISTRAL_API_KEY"], models: {
      "mistral-large-3": m("mistral-large-3", "Mistral Large 3", 256_000, 2, 6),
    } },
  };
  const ok = (cli: CliName): CliInfo => ({ cli, usable: true, models: [] });
  const built = buildCatalog({
    dev,
    clis: [ok("claude"), ok("codex"), ok("opencode")],
    lists: {
      claude: [{ id: "claude-opus-5-5" }],
      codex: [{ id: "gpt-6-astra" }],
      opencode: [{ id: "openrouter/moonshotai/kimi-k3" }, { id: "openrouter/qwen/qwen3.8-max" }, { id: "openrouter/deepseek/deepseek-v4-pro" }],
    },
    config,
    recent,
    env: { OPENROUTER_API_KEY: "x" },
  });
  return { ...built, source: { from: "mock" } };
}
