import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    case "mock":
      models = [{ id: "scripted", label: "scripted mock cast" }];
      break;
  }
  cache.set(cli, { at: Date.now(), models });
  return models;
}
