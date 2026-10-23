import { delphi } from "./delphi.js";
import { draftCritique } from "./draftCritique.js";
import { roundRobin } from "./roundRobin.js";
import type { Protocol } from "./types.js";

export type { Prior, Protocol, RoundState, Turn } from "./types.js";

const REGISTRY = new Map<string, Protocol>([roundRobin, draftCritique, delphi].map((p) => [p.name, p]));

export function registerProtocol(p: Protocol): void {
  REGISTRY.set(p.name, p);
}

export function getProtocol(name: string): Protocol {
  const p = REGISTRY.get(name);
  if (!p) throw new Error(`unknown protocol "${name}" (known: ${[...REGISTRY.keys()].join(", ")})`);
  return p;
}
