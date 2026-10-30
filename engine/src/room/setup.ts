import type { CliName, CouncilConfig } from "../config.js";
import { CHEAP_FIRST, readSettings, type HelperModel, type UserSettings } from "../settings.js";
import { createTransport } from "../transports/index.js";
import { mockRoomTransports } from "./mock.js";
import type { TransportFactory } from "./room.js";
import type { RoomConfig, SupportSpec } from "./store.js";

/**
 * Who runs the support roles. settings.toml wins; otherwise the assistant and Chair use the
 * council's Chair model and the scribe the first cheap CLI available (Claude is never picked
 * silently for the scribe's frequent, low-stakes work).
 */
export function supportFor(council: CouncilConfig, usable: CliName[], settings: UserSettings = readSettings()): RoomConfig["support"] {
  const chair: SupportSpec = { cli: council.chair.cli, ...(council.chair.model ? { model: council.chair.model } : {}) };
  const pick = (h: HelperModel | undefined, fallback: SupportSpec): SupportSpec =>
    h && h.cli !== "openrouter" && usable.includes(h.cli) ? { cli: h.cli, ...(h.model ? { model: h.model } : {}) } : fallback;
  const cheap = CHEAP_FIRST.find((c) => usable.includes(c));
  return {
    assistant: pick(settings.assistant, chair),
    chair: pick(settings.chair, chair),
    scribe: pick(settings.scribe, cheap ? { cli: cheap } : chair),
  };
}

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
