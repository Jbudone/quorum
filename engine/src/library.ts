import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import {
  DEFAULT_ASSETS,
  isShippedPreset,
  loadPersona,
  userDir,
  type CliName,
  type CouncilConfig,
  type PauseMode,
} from "./config.js";
import { getProtocol } from "./protocols/index.js";

const CLIS: CliName[] = ["claude", "codex", "gemini", "agy", "opencode", "mock"];
const PAUSES: PauseMode[] = ["round", "message", "auto"];

/** Everything wrong with a council config, as human-readable sentences (empty when valid). */
export function validateCouncil(c: CouncilConfig, assetsDir = DEFAULT_ASSETS, user = userDir()): string[] {
  const errs: string[] = [];
  if (c.agents.length < 1) errs.push("add at least one member");
  if (c.agents.length > 8) errs.push("a council can have at most 8 members");

  const seen = new Set<string>();
  for (const a of c.agents) {
    if (!/^[a-z][a-z0-9-]{0,24}$/.test(a.id)) errs.push(`"${a.id}" is not a valid member name (lowercase letters, digits and dashes)`);
    else if (a.id === "chair") errs.push('"chair" is reserved for the Chair');
    if (seen.has(a.id)) errs.push(`two members are called "${a.id}"`);
    seen.add(a.id);
    if (!CLIS.includes(a.cli)) errs.push(`${a.id}: unknown agent CLI "${a.cli}"`);
    if (a.model !== undefined && !/^[\w./:@][\w./:@-]*$/.test(a.model)) errs.push(`${a.id}: "${a.model}" is not a valid model name`);
    try {
      loadPersona(a.persona, assetsDir, user);
    } catch {
      errs.push(`${a.id}: there is no persona called "${a.persona}"`);
    }
  }
  if (!CLIS.includes(c.chair.cli)) errs.push(`the Chair has unknown agent CLI "${c.chair.cli}"`);
  if (c.chair.model !== undefined && !/^[\w./:@][\w./:@-]*$/.test(c.chair.model)) errs.push(`the Chair's model "${c.chair.model}" is not valid`);
  if (!Number.isInteger(c.rounds) || c.rounds < 1 || c.rounds > 12) errs.push("rounds must be a whole number from 1 to 12");
  if (!PAUSES.includes(c.pause)) errs.push(`pause must be one of ${PAUSES.join(", ")}`);

  try {
    getProtocol(c.protocol);
    // Protocols that pit members against each other need someone to talk to.
    if ((c.protocol === "draft-critique-revise" || c.protocol === "delphi") && c.agents.length < 2) {
      errs.push(`${c.protocol} needs at least two members`);
    }
  } catch {
    errs.push(`unknown protocol "${c.protocol}"`);
  }
  return errs;
}

/** Builds a council from the camelCase JSON the TUI sends, throwing one error listing every problem. */
export function councilFromWire(raw: any, assetsDir = DEFAULT_ASSETS, user = userDir()): CouncilConfig {
  const clean = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const config: CouncilConfig = {
    name: clean(raw?.name) ?? "custom",
    description: clean(raw?.description),
    protocol: String(raw?.protocol ?? "draft-critique-revise"),
    rounds: Number(raw?.rounds ?? 3),
    pause: (raw?.pause ?? "round") as PauseMode,
    readOnly: raw?.readOnly ?? true,
    requireEvidence: raw?.requireEvidence ?? false,
    chair: { cli: (raw?.chair?.cli ?? "claude") as CliName, model: clean(raw?.chair?.model) },
    agents: Array.isArray(raw?.agents)
      ? raw.agents.map((a: any) => ({
          id: String(a?.id ?? ""),
          cli: a?.cli as CliName,
          model: clean(a?.model),
          persona: String(a?.persona ?? ""),
        }))
      : [],
  };
  const errs = validateCouncil(config, assetsDir, user);
  if (errs.length) throw new Error(errs.join("; "));
  return config;
}

/** Serializes a council to the same TOML shape the shipped presets use. */
export function councilToToml(c: CouncilConfig): string {
  const chair: Record<string, string> = { cli: c.chair.cli };
  if (c.chair.model) chair.model = c.chair.model;
  const table: Record<string, unknown> = {
    name: c.name,
    ...(c.description ? { description: c.description } : {}),
    protocol: c.protocol,
    rounds: c.rounds,
    pause: c.pause,
    read_only: c.readOnly,
    require_evidence: c.requireEvidence,
    chair,
    agents: c.agents.map((a) => ({
      id: a.id,
      cli: a.cli,
      ...(a.model ? { model: a.model } : {}),
      persona: a.persona,
    })),
  };
  return stringify(table) + "\n";
}

/** Saves a preset into the user's directory. Shipped preset names cannot be overwritten. */
export function savePreset(
  name: string,
  config: CouncilConfig,
  assetsDir = DEFAULT_ASSETS,
  user = userDir(),
): string {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) {
    throw new Error("a preset name starts with a letter and uses lowercase letters, digits and dashes");
  }
  if (isShippedPreset(name, assetsDir)) throw new Error(`"${name}" is a built-in council; choose another name`);
  const errs = validateCouncil(config, assetsDir, user);
  if (errs.length) throw new Error(errs.join("; "));
  const dir = join(user, "presets");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.toml`);
  writeFileSync(file, councilToToml({ ...config, name }));
  return file;
}
