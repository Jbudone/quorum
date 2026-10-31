import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { CliName } from "./config.js";

/** A model a CLI can run, as its `--model` flag takes it. */
export interface ModelInfo {
  id: string;
  label?: string;
}

/** Claude's CLI takes aliases for the latest of each family, or full model ids. */
const CLAUDE: ModelInfo[] = [
  { id: "sonnet", label: "latest Sonnet" },
  { id: "opus", label: "latest Opus" },
  { id: "haiku", label: "latest Haiku" },
  { id: "fable", label: "latest Fable" },
  { id: "claude-fable-5-1" },
  { id: "claude-opus-5-5" },
  { id: "claude-sonnet-5-5" },
  { id: "claude-haiku-5-5" },
];

const run = (cmd: string, args: string[], timeoutMs = 20_000): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (_err, out) => resolve(String(out ?? ""))));

/** Reads opencode's `opencode models`: one `provider/model` per line, OpenRouter's included. */
export function parseOpencodeModels(out: string): ModelInfo[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/\S+$/.test(l))
    .map((id) => ({ id }));
}

/** Reads `agy models`: `id<TAB>display name` lines after a status line. */
export function parseAgyModels(out: string): ModelInfo[] {
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 2 && /^[\w.-]+$/.test(p[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
}

/** Codex keeps the models its account can use in ~/.codex/models_cache.json. */
export function codexModels(file = join(homedir(), ".codex", "models_cache.json")): ModelInfo[] {
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    return (Array.isArray(d?.models) ? d.models : []).flatMap((m: any) =>
      typeof m?.slug === "string" ? [{ id: m.slug, ...(typeof m.display_name === "string" ? { label: m.display_name } : {}) }] : [],
    );
  } catch {
    return [];
  }
}

/** Kimi Code runs model aliases defined in ~/.kimi-code/config.toml (`[models."alias"]`, each naming a provider and model). */
export function kimiModels(file = join(homedir(), ".kimi-code", "config.toml")): ModelInfo[] {
  try {
    const d = parse(readFileSync(file, "utf8")) as any;
    const out: ModelInfo[] = Object.entries(d?.models ?? {}).map(([id, m]: [string, any]) => ({ id, ...(m?.provider && m?.model ? { label: `${m.model} via ${m.provider}` } : {}) }));
    const def = typeof d?.default_model === "string" ? d.default_model : undefined;
    return def ? [...out.filter((m) => m.id === def), ...out.filter((m) => m.id !== def)] : out;
  } catch {
    return [];
  }
}

/**
 * ZCode runs `provider/model`, and only for providers the user set up (an account login or a key).
 * Its configured providers are in ~/.zcode/v2/provider_config.json; which models each kind of
 * provider offers comes from the built-in table it downloads (`zcode-builtin.json`).
 */
export function zcodeModels(root = join(homedir(), ".zcode", "v2")): ModelInfo[] {
  const read = (f: string): any => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return undefined;
    }
  };
  const cfg = read(join(root, "provider_config.json"))?.config;
  if (!cfg) return [];
  const builtin = findBuiltin(join(root, "runtime", "provider"));
  const table = new Map<string, string[]>();
  for (const r of builtin?.config?.modelConfigRules?.templateModelRules ?? []) {
    if (r?.config?.enabled === false || typeof r?.templateId !== "string" || typeof r?.modelId !== "string") continue;
    table.set(r.templateId, [...(table.get(r.templateId) ?? []), r.modelId]);
  }
  const providers = new Map<string, string | undefined>();
  const def = cfg.defaultModelSelection;
  if (typeof def?.providerId === "string") providers.set(def.providerId, undefined);
  for (const p of cfg.providerConfigRules?.providerRules ?? []) {
    const id = p?.providerId ?? p?.id;
    if (typeof id === "string") providers.set(id, typeof p?.templateId === "string" ? p.templateId : undefined);
  }
  const out: ModelInfo[] = [];
  const add = (id: string, label?: string) => out.some((m) => m.id === id) || out.push({ id, ...(label ? { label } : {}) });
  if (typeof def?.providerId === "string" && typeof def?.modelId === "string") add(`${def.providerId}/${def.modelId}`, "ZCode's default");
  for (const [id, template] of providers) {
    // A Z.AI coding-plan login ("account:zai-…") offers the Z.AI API's models.
    const t = template ?? (id.startsWith("account:zai") ? "zai-api" : id.replace(/^account:/, ""));
    for (const m of table.get(t) ?? []) add(`${id}/${m}`);
  }
  return out;
}

function findBuiltin(dir: string): any {
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      if (n === "zcode-builtin.json") files.push(p);
      else if (depth < 4 && !n.endsWith(".json")) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  // Newest runtime version last when sorted; the dev build ("0.0.0-dev") sorts first.
  for (const f of files.sort().reverse()) {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {}
  }
  return undefined;
}

const cache = new Map<string, { at: number; models: ModelInfo[] }>();
const FRESH_MS = 10 * 60_000;

/** The models a CLI offers, asked of the CLI where it can list them (cached for a few minutes). */
export async function listModels(cli: CliName): Promise<ModelInfo[]> {
  const hit = cache.get(cli);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.models;
  let models: ModelInfo[] = [];
  switch (cli) {
    case "claude":
      models = CLAUDE;
      break;
    case "codex":
      models = codexModels();
      break;
    case "opencode":
      models = parseOpencodeModels(await run("opencode", ["models"]));
      break;
    case "agy":
      models = parseAgyModels(await run("agy", ["models"]));
      break;
    case "kimi":
      models = kimiModels();
      break;
    case "zcode":
      models = zcodeModels();
      break;
    case "mock":
      models = [{ id: "scripted", label: "scripted mock cast" }];
      break;
  }
  cache.set(cli, { at: Date.now(), models });
  return models;
}
