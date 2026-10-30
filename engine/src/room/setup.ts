import type { CliName } from "../config.js";
import { CHEAP_FIRST, readSettings, type HelperModel, type UserSettings } from "../settings.js";
import { createTransport } from "../transports/index.js";
import { mockRoomTransports } from "./mock.js";
import type { TransportFactory } from "./room.js";
import type { RoomConfig, SupportSpec } from "./store.js";

/** CLIs tried, in order, for the roles that need judgment (assistant, Chair) when settings.toml names none. */
const BEST_FIRST: CliName[] = ["claude", "codex", "gemini", "opencode", "agy"];

/**
 * Who runs the support roles. settings.toml wins; otherwise the assistant and Chair get the most
 * capable CLI available, and the scribe and floor, which run often on low-stakes work, the first
 * cheap one (Claude is never picked silently for those).
 */
export function supportFor(usable: CliName[], settings: UserSettings = readSettings()): Required<RoomConfig["support"]> {
  const pick = (h: HelperModel | undefined, fallback: SupportSpec): SupportSpec =>
    h && h.cli !== "openrouter" && usable.includes(h.cli) ? { cli: h.cli, ...(h.model ? { model: h.model } : {}) } : fallback;
  const best: SupportSpec = { cli: BEST_FIRST.find((c) => usable.includes(c)) ?? usable[0] ?? "mock" };
  const cheapCli = CHEAP_FIRST.find((c) => usable.includes(c));
  const cheap: SupportSpec = cheapCli ? { cli: cheapCli } : best;
  return {
    assistant: pick(settings.assistant, best),
    chair: pick(settings.chair, best),
    scribe: pick(settings.scribe, cheap),
    floor: pick(settings.floor, cheap),
  };
}

export const MOCK_SUPPORT: Required<RoomConfig["support"]> = { assistant: { cli: "mock" }, chair: { cli: "mock" }, scribe: { cli: "mock" }, floor: { cli: "mock" } };

/** Transports for a room: the real CLIs, and the scripted cast (keyed by persona) for the mock CLI. */
export function roomTransports(personaOf: (id: string) => string, delayMs?: number): TransportFactory {
  const mock = mockRoomTransports(personaOf, delayMs);
  return (spec) => (spec.cli === "mock" ? mock(spec) : createTransport({ id: spec.id, cli: spec.cli, model: spec.model }));
}

/** The persona behind a room member, or the role name for support roles. */
export const personaIn =
  (config: () => RoomConfig) =>
  (id: string): string =>
    [...config().agents, ...(config().left ?? [])].find((a) => a.id === id)?.persona ?? id;
