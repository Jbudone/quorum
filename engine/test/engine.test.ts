import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPreset, type PauseMode } from "../src/config.js";
import { Engine, type EngineEvent } from "../src/engine.js";
import { MockTransport } from "../src/transports/mock.js";

function setup(pause: PauseMode, rounds = 2) {
  const config = { ...loadPreset("solo"), protocol: "round-robin", pause, rounds };
  const repo = mkdtempSync(join(tmpdir(), "quorum-engine-"));
  const prompts: string[] = [];
  const engine = new Engine({
    config,
    topic: "design X",
    repo,
    transportFor: (id) => {
      const t = new MockTransport(id, { rules: [], fallback: `${id} says hi` });
      const send = t.send.bind(t);
      t.send = (p, o) => (prompts.push(`${id}: ${p}`), send(p, o));
      return t;
    },
  });
  const events: EngineEvent[] = [];
  engine.on((e) => events.push(e));
  return { engine, events, prompts };
}

const names = (evs: EngineEvent[]) => evs.map((e) => e.event);

describe("Engine", () => {
  it("pauses after each round by default", async () => {
    const { engine, events } = setup("round");
    await engine.continue();
    expect(names(events).filter((n) => n === "turn.done")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ event: "awaiting_human", data: { round: 1, finished: false } });
    await engine.continue();
    expect(events.at(-1)).toMatchObject({ event: "awaiting_human", data: { round: 2, finished: true } });
  });

  it("runs all rounds in auto mode, then pauses once", async () => {
    const { engine, events } = setup("auto");
    await engine.continue();
    expect(names(events).filter((n) => n === "round.done")).toHaveLength(2);
    expect(names(events).filter((n) => n === "awaiting_human")).toHaveLength(1);
    expect(engine.finished).toBe(true);
  });

  it("pauses after every message in message mode", async () => {
    const { engine, events } = setup("message", 1);
    await engine.continue();
    expect(names(events).filter((n) => n === "turn.done")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ event: "awaiting_human", data: { finished: false } });
    await engine.continue();
    await engine.continue();
    expect(events.at(-1)).toMatchObject({ data: { finished: true } });
  });

  it("feeds steering into the next round and records everything to the session", async () => {
    const { engine, prompts } = setup("round");
    await engine.continue();
    engine.steer("drop SSO from scope");
    await engine.continue();
    expect(prompts.filter((p) => p.includes("drop SSO from scope")).length).toBeGreaterThan(0);
    const speakers = engine.session.transcript().map((e) => e.speaker);
    expect(speakers).toContain("human");
    expect(speakers.filter((s) => s === "architect")).toHaveLength(2);
  });

  it("lets the human talk to the Chair or an agent at a pause", async () => {
    const { engine, prompts } = setup("round");
    await engine.continue();
    const reply = await engine.interject("chair", "why do they disagree?");
    expect(reply).toBe("chair says hi");
    expect(prompts.at(-1)).toContain("why do they disagree?");
    expect(prompts.at(-1)).toContain("architect:");
  });
});
