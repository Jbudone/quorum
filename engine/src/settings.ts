import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { userDir, type CliName } from "./config.js";
import type { CliInfo } from "./doctor.js";
import { askVia } from "./designer.js";
import { makeIllustrator, type Ask, type Illustrate } from "./illustrator.js";
import { JEV_ENDPOINT, JEV_MODEL, makeJev } from "./jev.js";

export interface HelperModel {
  /** An agent CLI, or "openrouter" for a direct one-shot call to a model through OpenRouter (fast, needs OPENROUTER_API_KEY). */
  cli: CliName | "openrouter";
  model?: string;
}
export interface UserSettings {
  /** The cheap model that draws a diagram for each reply. */
  illustrator?: HelperModel;
  /** An optional second model that checks the diagram is faithful to the reply. */
  verifier?: HelperModel;
  /** Opt-in: send reply text to Jev (via OpenRouter) to gate and verify diagrams. The key comes from OPENROUTER_API_KEY. */
  jev?: { enabled: boolean; model?: string; endpoint?: string };
  /** Room support roles: the human's assistant, the Chair, and the scribe who keeps the shared notes. */
  assistant?: HelperModel;
  chair?: HelperModel;
  scribe?: HelperModel;
  /** Decides who speaks next in a room; runs after most messages, so a cheap fast model fits. */
  floor?: HelperModel;
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
      assistant: helper(raw.assistant),
      chair: helper(raw.chair),
      scribe: helper(raw.scribe),
      floor: helper(raw.floor),
      jev: j && j.enabled === true ? { enabled: true, model: typeof j.model === "string" ? j.model : undefined, endpoint: typeof j.endpoint === "string" ? j.endpoint : undefined } : undefined,
    };
  } catch {
    return {};
  }
}

/** One-shot JSON completion through OpenRouter, with no agent loop around it. */
export function askOpenRouter(model: string, system: string, timeoutMs = 30_000, doFetch: typeof fetch = fetch): Ask {
  return async (prompt) => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);
      const body: any = await res.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("OpenRouter reply had no content");
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** CLIs tried, in order, for drawing diagrams when settings.toml names none. Claude is left out so its quota is not spent silently. */
export const CHEAP_FIRST: CliName[] = ["opencode", "agy", "codex"];

/** The diagram drawer for a session, or undefined when no suitable model is available. */
export function buildIllustrator(clis: CliInfo[], repo: string, settings = readSettings()): Illustrate | undefined {
  const usable = new Set<string>(clis.filter((c) => c.usable).map((c) => c.cli));
  if (process.env.OPENROUTER_API_KEY) usable.add("openrouter");
  const chosen: HelperModel | undefined = settings.illustrator ?? (() => {
    const cli = CHEAP_FIRST.find((c) => usable.has(c));
    return cli ? ({ cli } as HelperModel) : undefined;
  })();
  if (!chosen || !usable.has(chosen.cli)) return undefined;
  const sys = "You turn design-discussion messages into small structured diagrams. Answer with JSON only.";
  const via = (h: HelperModel): Ask =>
    h.cli === "openrouter" ? askOpenRouter(h.model ?? "qwen/qwen3-30b-a3b-instruct-2507", sys) : askVia(h.cli, h.model, repo, sys, 60_000);
  const ask = via(chosen);
  const v = settings.verifier && usable.has(settings.verifier.cli) ? via(settings.verifier) : undefined;
  const jev = settings.jev?.enabled ? makeJev({ model: settings.jev.model ?? JEV_MODEL, endpoint: settings.jev.endpoint ?? JEV_ENDPOINT }) : undefined;
  if (settings.jev?.enabled && !jev) {
    // Jev was asked for but cannot run; showing unverified diagrams would defeat the point.
    console.error("quorum: [jev] is enabled in settings.toml but OPENROUTER_API_KEY is not set; diagrams are off");
    return undefined;
  }
  return makeIllustrator(ask, { verify: v, jev, log: (line) => console.error(`quorum: diagram: ${line}`) });
}
