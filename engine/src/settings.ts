import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { userDir, type CliName } from "./config.js";
import type { CliInfo } from "./doctor.js";
import { askVia } from "./designer.js";
import { makeIllustrator, type Illustrate } from "./illustrator.js";
import { JEV_ENDPOINT, JEV_MODEL, makeJev } from "./jev.js";

export interface HelperModel {
  cli: CliName;
  model?: string;
}
export interface UserSettings {
  /** The cheap model that draws a diagram for each reply. */
  illustrator?: HelperModel;
  /** An optional second model that checks the diagram is faithful to the reply. */
  verifier?: HelperModel;
  /** Opt-in: send reply text to Jev (via OpenRouter) to gate and verify diagrams. The key comes from OPENROUTER_API_KEY. */
  jev?: { enabled: boolean; model?: string; endpoint?: string };
}

const helper = (v: any): HelperModel | undefined =>
  v && typeof v.cli === "string" ? { cli: v.cli as CliName, model: typeof v.model === "string" && v.model ? v.model : undefined } : undefined;

/** Reads `<config>/quorum/settings.toml`; a missing or broken file means defaults. */
export function readSettings(user = userDir()): UserSettings {
  const file = join(user, "settings.toml");
  if (!existsSync(file)) return {};
  try {
    const raw = parse(readFileSync(file, "utf8")) as any;
    const j = raw.jev;
    return {
      illustrator: helper(raw.illustrator),
      verifier: helper(raw.verifier),
      jev: j && j.enabled === true ? { enabled: true, model: typeof j.model === "string" ? j.model : undefined, endpoint: typeof j.endpoint === "string" ? j.endpoint : undefined } : undefined,
    };
  } catch {
    return {};
  }
}

/** CLIs tried, in order, for drawing diagrams when settings.toml names none. Claude is left out so its quota is not spent silently. */
const CHEAP_FIRST: CliName[] = ["opencode", "agy", "codex"];

/** The diagram drawer for a session, or undefined when no suitable model is available. */
export function buildIllustrator(clis: CliInfo[], repo: string, settings = readSettings()): Illustrate | undefined {
  const usable = new Set(clis.filter((c) => c.usable).map((c) => c.cli));
  const chosen: HelperModel | undefined = settings.illustrator ?? (() => {
    const cli = CHEAP_FIRST.find((c) => usable.has(c));
    return cli ? ({ cli } as HelperModel) : undefined;
  })();
  if (!chosen || !usable.has(chosen.cli)) return undefined;
  const sys = "You turn design-discussion messages into small structured diagrams. Answer with JSON only.";
  const ask = askVia(chosen.cli, chosen.model, repo, sys, 60_000);
  const v = settings.verifier && usable.has(settings.verifier.cli) ? askVia(settings.verifier.cli, settings.verifier.model, repo, sys, 60_000) : undefined;
  const jev = settings.jev?.enabled ? makeJev({ model: settings.jev.model ?? JEV_MODEL, endpoint: settings.jev.endpoint ?? JEV_ENDPOINT }) : undefined;
  if (settings.jev?.enabled && !jev) {
    // Jev was asked for but cannot run; showing unverified diagrams would defeat the point.
    console.error("quorum: [jev] is enabled in settings.toml but OPENROUTER_API_KEY is not set; diagrams are off");
    return undefined;
  }
  return makeIllustrator(ask, { verify: v, jev });
}
