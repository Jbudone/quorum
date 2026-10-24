import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export type CliName = "claude" | "codex" | "gemini" | "agy" | "opencode" | "mock";
export type PauseMode = "round" | "message" | "auto";

export interface AgentSpec {
  id: string;
  cli: CliName;
  model?: string;
  /** Persona file name (without .md) from the personas directory. */
  persona: string;
}

export interface CouncilConfig {
  name: string;
  description?: string;
  protocol: string;
  rounds: number;
  pause: PauseMode;
  readOnly: boolean;
  requireEvidence: boolean;
  chair: { cli: CliName; model?: string };
  agents: AgentSpec[];
  /** True when a model designs the council from the topic before the session starts. */
  auto?: boolean;
}

export interface Persona {
  name: string;
  role: string;
  /** Persona instructions (markdown body). */
  body: string;
}

/** Repo-level presets/ and personas/ directories shipped with Quorum. */
export const DEFAULT_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where a user's own presets and personas live (`presets/*.toml`, `personas/*.md`). Read from the
 * environment on each call so tests and the TUI can point it elsewhere.
 */
export function userDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "quorum");
}

const CLIS: CliName[] = ["claude", "codex", "gemini", "agy", "opencode", "mock"];
const PAUSES: PauseMode[] = ["round", "message", "auto"];

function fail(msg: string): never {
  throw new Error(`invalid council config: ${msg}`);
}

/** Validates a parsed TOML table into a CouncilConfig, applying defaults. */
export function parseCouncil(raw: Record<string, any>): CouncilConfig {
  const agents = raw.agents;
  if (!Array.isArray(agents) || agents.length === 0) fail("at least one [[agents]] entry is required");
  const seen = new Set<string>();
  for (const a of agents) {
    if (typeof a.id !== "string" || !a.id) fail("every agent needs an id");
    if (seen.has(a.id)) fail(`duplicate agent id "${a.id}"`);
    seen.add(a.id);
    if (!CLIS.includes(a.cli)) fail(`agent "${a.id}" has unknown cli "${a.cli}"`);
    if (typeof a.persona !== "string") fail(`agent "${a.id}" needs a persona`);
  }
  const pause = raw.pause ?? "round";
  if (!PAUSES.includes(pause)) fail(`pause must be one of ${PAUSES.join(", ")}`);
  const chair = raw.chair ?? { cli: agents[0].cli };
  if (!CLIS.includes(chair.cli)) fail(`chair has unknown cli "${chair.cli}"`);
  return {
    name: String(raw.name ?? "custom"),
    description: raw.description,
    protocol: String(raw.protocol ?? "draft-critique-revise"),
    rounds: Number(raw.rounds ?? 3),
    pause,
    readOnly: raw.read_only ?? true,
    requireEvidence: raw.require_evidence ?? false,
    chair: { cli: chair.cli, model: chair.model },
    agents: agents.map((a: any) => ({ id: a.id, cli: a.cli, model: a.model, persona: a.persona })),
    ...(raw.auto === true ? { auto: true } : {}),
  };
}

/** First existing file among the shipped assets and the user's own directory. */
function findAsset(kind: "presets" | "personas", file: string, assetsDir: string, user: string): string {
  for (const dir of [join(assetsDir, kind), join(user, kind)]) {
    if (existsSync(join(dir, file))) return join(dir, file);
  }
  fail(`no ${kind === "presets" ? "preset" : "persona"} named "${file.replace(/\.[^.]+$/, "")}"`);
}

export function loadPreset(name: string, assetsDir = DEFAULT_ASSETS, user = userDir()): CouncilConfig {
  if (!/^[\w-]+$/.test(name)) fail(`bad preset name "${name}"`);
  const c = parseCouncil(parse(readFileSync(findAsset("presets", `${name}.toml`, assetsDir, user), "utf8")));
  return { ...c, name };
}

/** Parses a persona markdown file with simple `key: value` frontmatter. */
export function parsePersona(src: string): Persona {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { name: meta.name ?? "Unnamed", role: meta.role ?? "panelist", body: (m?.[2] ?? src).trim() };
}

/** A user's persona file of the same name overrides the shipped one. */
export function loadPersona(name: string, assetsDir = DEFAULT_ASSETS, user = userDir()): Persona {
  if (!/^[\w-]+$/.test(name)) fail(`bad persona name "${name}"`);
  const mine = join(user, "personas", `${name}.md`);
  if (existsSync(mine)) return parsePersona(readFileSync(mine, "utf8"));
  return parsePersona(readFileSync(findAsset("personas", `${name}.md`, assetsDir, user), "utf8"));
}

/** Swaps every agent and the Chair to the scripted mock CLI (no tokens spent). */
export function mockify(config: CouncilConfig): CouncilConfig {
  return {
    ...config,
    agents: config.agents.map((a) => ({ ...a, cli: "mock" as const })),
    chair: { cli: "mock" },
  };
}

export interface PresetSummary {
  name: string;
  description: string;
  protocol: string;
  rounds: number;
  pause: PauseMode;
  readOnly: boolean;
  requireEvidence: boolean;
  chair: { cli: CliName; model?: string };
  /** True for presets the user saved, as opposed to the ones shipped with Quorum. */
  custom: boolean;
  /** True for the preset whose council is designed by a model once the topic is known. */
  auto: boolean;
  agents: { id: string; cli: CliName; model?: string; role: string; persona: string }[];
}

const SHIPPED = ["solo", "trio", "delphi", "deep", "auto"];

function tomlNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".toml"))
      .map((f) => f.slice(0, -5))
      .filter((n) => /^[\w-]+$/.test(n));
  } catch {
    return [];
  }
}

export function isShippedPreset(name: string, assetsDir = DEFAULT_ASSETS): boolean {
  return tomlNames(join(assetsDir, "presets")).includes(name);
}

/** Every preset available: the shipped ones first, then the user's own, with full settings for editing. */
export function listPresets(assetsDir = DEFAULT_ASSETS, user = userDir()): PresetSummary[] {
  const shipped = tomlNames(join(assetsDir, "presets"));
  const mine = tomlNames(join(user, "presets")).filter((n) => !shipped.includes(n));
  const order = (n: string) => (SHIPPED.includes(n) ? SHIPPED.indexOf(n) : SHIPPED.length);
  const names = [...shipped.sort((a, b) => order(a) - order(b) || a.localeCompare(b)), ...mine.sort()];
  const out: PresetSummary[] = [];
  for (const name of names) {
    try {
      const c = loadPreset(name, assetsDir, user);
      out.push({
        name,
        description: c.description ?? "",
        protocol: c.protocol,
        rounds: c.rounds,
        pause: c.pause,
        readOnly: c.readOnly,
        requireEvidence: c.requireEvidence,
        chair: c.chair,
        custom: !shipped.includes(name),
        auto: c.auto === true,
        agents: c.agents.map((a) => ({
          id: a.id,
          cli: a.cli,
          model: a.model,
          persona: a.persona,
          role: loadPersona(a.persona, assetsDir, user).role,
        })),
      });
    } catch {
      // A broken user preset must not take the picker down; it simply does not appear.
    }
  }
  return out;
}

export interface PersonaSummary {
  key: string;
  name: string;
  role: string;
  custom: boolean;
}

/** Shipped personas plus the user's own (a user file with a shipped name overrides it). */
export function listPersonas(assetsDir = DEFAULT_ASSETS, user = userDir()): PersonaSummary[] {
  const names = (dir: string) => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
        .filter((n) => /^[\w-]+$/.test(n));
    } catch {
      return [];
    }
  };
  const shipped = names(join(assetsDir, "personas"));
  const mine = names(join(user, "personas"));
  return [...new Set([...shipped, ...mine])]
    .filter((key) => key !== "chair")
    .map((key) => {
      const p = loadPersona(key, assetsDir, user);
      return { key, name: p.name, role: p.role, custom: mine.includes(key) };
    })
    .sort((a, b) => Number(a.custom) - Number(b.custom) || a.key.localeCompare(b.key));
}
