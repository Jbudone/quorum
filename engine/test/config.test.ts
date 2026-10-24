import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPersona, loadPreset, parseCouncil } from "../src/config.js";
import { Session } from "../src/session.js";

describe("presets", () => {
  it.each(["solo", "trio", "delphi", "deep", "auto"])("%s loads and every persona resolves", (name) => {
    const c = loadPreset(name);
    expect(c.agents.length).toBeGreaterThanOrEqual(3);
    for (const a of c.agents) expect(loadPersona(a.persona).body.length).toBeGreaterThan(20);
  });

  it("rejects bad input", () => {
    expect(() => parseCouncil({ agents: [] })).toThrow(/at least one/);
    expect(() => parseCouncil({ agents: [{ id: "a", cli: "nope", persona: "x" }] })).toThrow(/unknown cli/);
    expect(() =>
      parseCouncil({
        agents: [
          { id: "a", cli: "mock", persona: "x" },
          { id: "a", cli: "mock", persona: "x" },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => loadPreset("../etc/passwd")).toThrow(/bad preset name/);
  });
});

describe("Session", () => {
  it("round-trips transcript and artifacts as plain files", () => {
    const root = mkdtempSync(join(tmpdir(), "quorum-test-"));
    const s = Session.create(root, loadPreset("solo"), "topic");
    s.append({ round: 1, speaker: "architect", text: "draft" });
    s.write("plan.md", "# Plan");
    const again = Session.open(root, s.id);
    expect(again.transcript()).toMatchObject([{ round: 1, speaker: "architect", text: "draft" }]);
    expect(again.read("plan.md")).toBe("# Plan");
    expect(again.meta().topic).toBe("topic");
  });
});
