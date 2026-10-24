import { describe, expect, it } from "vitest";
import { designCouncil, mockDesigner } from "../src/designer.js";
import type { CliInfo } from "../src/doctor.js";

const clis: CliInfo[] = [
  { cli: "claude", usable: true, models: ["sonnet", "opus"] },
  { cli: "codex", usable: true, models: [] },
  { cli: "opencode", usable: false, models: [] },
];
const input = { topic: "Add SSO to the admin console", clis };

const good = JSON.stringify({
  rationale: "Security-sensitive, so add a security lens.",
  protocol: "draft-critique-revise",
  rounds: 3,
  pause: "round",
  readOnly: true,
  requireEvidence: true,
  chair: { cli: "claude" },
  agents: [
    { persona: "architect", cli: "claude", model: "opus" },
    { persona: "security", cli: "codex" },
    { persona: "skeptic", cli: "claude", model: "sonnet" },
  ],
});

describe("designCouncil", () => {
  it("uses a valid proposal, wrapped in prose or fences", async () => {
    const d = await designCouncil(async () => "Here you go:\n```json\n" + good + "\n```", input);
    expect(d.source).toBe("model");
    expect(d.config.agents.map((a) => a.id)).toEqual(["architect", "security", "skeptic"]);
    expect(d.config.agents[0]).toMatchObject({ cli: "claude", model: "opus" });
    expect(d.rationale).toContain("Security");
  });

  it("derives unique ids when a persona repeats", async () => {
    const dup = JSON.stringify({ ...JSON.parse(good), agents: [{ persona: "skeptic", cli: "claude" }, { persona: "skeptic", cli: "codex" }] });
    const d = await designCouncil(async () => dup, input);
    expect(d.config.agents.map((a) => a.id)).toEqual(["skeptic", "skeptic-2"]);
  });

  it("swaps an unusable CLI for a usable one instead of failing", async () => {
    const bad = JSON.stringify({ ...JSON.parse(good), agents: [{ persona: "architect", cli: "opencode" }, { persona: "skeptic", cli: "codex" }] });
    const d = await designCouncil(async () => bad, input);
    expect(d.config.agents[0].cli).toBe("claude");
  });

  it("retries once with the validation errors, then succeeds", async () => {
    const prompts: string[] = [];
    const answers = [JSON.stringify({ ...JSON.parse(good), agents: [{ persona: "wizard", cli: "claude" }, { persona: "skeptic", cli: "claude" }] }), good];
    const d = await designCouncil(async (p) => (prompts.push(p), answers.shift()!), input);
    expect(d.source).toBe("model");
    expect(prompts[1]).toContain('no persona called "wizard"');
  });

  it("falls back to the standard council when the model never produces JSON", async () => {
    const d = await designCouncil(async () => "I think three is a nice number.", input);
    expect(d.source).toBe("fallback");
    expect(d.config.agents).toHaveLength(3);
    expect(d.rationale).toContain("standard");
  });

  it("falls back when asking throws", async () => {
    const d = await designCouncil(async () => { throw new Error("timed out"); }, input);
    expect(d.source).toBe("fallback");
    expect(d.rationale).toContain("timed out");
  });

  it("lists only usable CLIs and the topic in the prompt", async () => {
    let seen = "";
    await designCouncil(async (p) => ((seen = p), good), input);
    expect(seen).toContain("Add SSO to the admin console");
    expect(seen).toContain("- claude (models: sonnet, opus)");
    expect(seen).not.toContain("- opencode");
  });

  it("mock designer yields a valid mock council", async () => {
    const d = await designCouncil(mockDesigner, { topic: "t", clis: [{ cli: "mock", usable: true, models: [] }] });
    expect(d.source).toBe("model");
    expect(d.config.agents).toHaveLength(4);
  });
});
