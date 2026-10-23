import { roundRobin } from "./roundRobin.js";
import type { Protocol } from "./types.js";

export type { Protocol, RoundState, Turn } from "./types.js";

const REGISTRY = new Map<string, Protocol>([[roundRobin.name, roundRobin]]);

export function registerProtocol(p: Protocol): void {
  REGISTRY.set(p.name, p);
}

export function getProtocol(name: string): Protocol {
  const p = REGISTRY.get(name);
  if (!p) throw new Error(`unknown protocol "${name}" (known: ${[...REGISTRY.keys()].join(", ")})`);
  return p;
}
