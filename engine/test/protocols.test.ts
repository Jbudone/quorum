import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPreset } from "../src/config.js";
import { Engine, type EngineEvent } from "../src/engine.js";
import { parseChairReport } from "../src/protocols/chairReport.js";
import { anonymize } from "../src/protocols/delphi.js";
import { MockTransport, type MockRule } from "../src/transports/mock.js";

const REPORT = (converged: boolean) =>
  `They agree on tokens but split on rotation.\n## DISSENT\n- skeptic: reuse detection is mandatory\n## OPEN QUESTIONS\n- Who owns revocation?\nCONVERGED: ${converged ? "yes" : "no"}`;

function run(preset: string, rules: Record<string, MockRule[]>, rounds: number) {
  const prompts: Record<string, string[]> = {};
  const events: EngineEvent[] = [];
  const engine = new Engine({
    config: { ...loadPreset(preset), pause: "auto", rounds },
    topic: "migrate auth",
    repo: mkdtempSync(join(tmpdir(), "quorum-proto-")),
    transportFor: (id) => {
      const t = new MockTransport(id, { rules: rules[id] ?? [], fallback: `${id} says something` });
      const send = t.send.bind(t);
      t.send = (p, o) => ((prompts[id] ??= []).push(p), send(p, o));
      return t;
    },
  });
  engine.on((e) => events.push(e));
  return { engine, prompts, events };
}

describe("parseChairReport", () => {
  it("extracts summary, dissent, questions and the verdict", () => {
    const r = parseChairReport(REPORT(true));
    expect(r.summary).toBe("They agree on tokens but split on rotation.");
    expect(r.dissent).toContain("reuse detection");
    expect(r.questions).toContain("revocation");
    expect(r.converged).toBe(true);
    expect(parseChairReport(REPORT(false)).converged).toBe(false);
  });
  it("tolerates a bare reply", () => {
    expect(parseChairReport("just text")).toMatchObject({ summary: "just text", dissent: "", converged: false });
  });
});

describe("draft-critique-revise", () => {
  const rules = {
    architect: [
      { match: /first full draft/, reply: "DRAFT-V1" },
      { match: /Independent critiques/, reply: "REVISED-PLAN" },
    ],
    skeptic: [{ reply: "SKEPTIC-CRITIQUE" }],
    pragmatist: [{ reply: "PRAGMATIST-CRITIQUE" }],
    chair: [{ reply: REPORT(true) }],
  };

  it("drafts, critiques blind, revises, and the Chair closes the round", async () => {
    const { engine, prompts } = run("solo", rules, 3);
    await engine.continue();
    expect(prompts.skeptic[0]).toContain("DRAFT-V1");
    expect(prompts.skeptic[0]).not.toContain("PRAGMATIST-CRITIQUE");
    expect(prompts.pragmatist[0]).not.toContain("SKEPTIC-CRITIQUE");
    expect(prompts.architect[1]).toContain("SKEPTIC-CRITIQUE");
    expect(prompts.architect[1]).toContain("PRAGMATIST-CRITIQUE");
    expect(engine.session.read("plan.md")).toBe("REVISED-PLAN");
    expect(engine.session.read("dissent.md")).toContain("## Round 1");
    expect(engine.session.read("open-questions.md")).toContain("revocation");
  });

  it("stops early when the Chair reports convergence", async () => {
    const { engine, events } = run("solo", rules, 3);
    await engine.continue();
    expect(events.filter((e) => e.event === "round.done")).toHaveLength(1);
    expect(engine.finished).toBe(true);
    expect(events.find((e) => e.event === "chair.summary")).toMatchObject({ data: { converged: true } });
  });

  it("keeps going and critiques the existing plan in later rounds when not converged", async () => {
    const { engine, prompts } = run("solo", { ...rules, chair: [{ reply: REPORT(false) }] }, 2);
    await engine.continue();
    expect(prompts.architect.filter((p) => p.includes("first full draft"))).toHaveLength(1);
    expect(prompts.skeptic[1]).toContain("REVISED-PLAN");
    expect(engine.finished).toBe(true);
  });
});

describe("delphi", () => {
  it("anonymizes feedback differently each round and synthesizes via the Chair", async () => {
    const { engine, prompts } = run(
      "delphi",
      { chair: [{ match: /Synthesize the panel/, reply: "SYNTH-PLAN" }, { reply: REPORT(false) }] },
      2,
    );
    await engine.continue();
    for (const id of ["architect", "skeptic", "pragmatist", "security", "operator"]) {
      expect(prompts[id][0]).not.toContain("Panelist");
      expect(prompts[id][1]).toContain("Panelist A");
      expect(prompts[id][1]).not.toMatch(/^(architect|skeptic|pragmatist|security|operator):/m);
    }
    expect(engine.session.read("plan.md")).toBe("SYNTH-PLAN");
  });

  it("labels are a stable bijection per round but vary across rounds", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const r1 = anonymize(ids, 1);
    expect(new Set(r1.values()).size).toBe(5);
    expect([...anonymize(ids, 1)]).toEqual([...r1]);
    expect([...anonymize(ids, 2)]).not.toEqual([...r1]);
  });
});
