import { readFileSync } from "node:fs";
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
}

export interface Persona {
  name: string;
  role: string;
  /** Persona instructions (markdown body). */
  body: string;
}

/** Repo-level presets/ and personas/ directories shipped with Quorum. */
export const DEFAULT_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  };
}

export function loadPreset(name: string, assetsDir = DEFAULT_ASSETS): CouncilConfig {
  if (!/^[\w-]+$/.test(name)) fail(`bad preset name "${name}"`);
  return parseCouncil(parse(readFileSync(join(assetsDir, "presets", `${name}.toml`), "utf8")));
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

export function loadPersona(name: string, assetsDir = DEFAULT_ASSETS): Persona {
  if (!/^[\w-]+$/.test(name)) fail(`bad persona name "${name}"`);
  return parsePersona(readFileSync(join(assetsDir, "personas", `${name}.md`), "utf8"));
}
