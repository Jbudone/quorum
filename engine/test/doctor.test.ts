import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPreset } from "../src/config.js";
import { doctor, installedClis, probe, readHealth, resolveAvailable, usableClis, writeHealth } from "../src/doctor.js";
import { MockTransport } from "../src/transports/mock.js";
import type { AgentTransport } from "../src/transports/types.js";

const failing: AgentTransport = {
  id: "gemini",
  async *send() {
    yield { type: "error", message: "IneligibleTierError: no longer supported\n    at stack..." };
  },
};

describe("probe", () => {
  it("passes a clean reply and reports the quota", async () => {
    const h = await probe(new MockTransport("c", { rules: [], fallback: "ok" }));
    expect(h).toMatchObject({ ok: true });
  });
  it("fails with a one-line error", async () => {
    const h = await probe(failing);
    expect(h.ok).toBe(false);
    expect(h.error).toBe("IneligibleTierError: no longer supported");
  });
  it("fails when the transport hangs past the timeout", async () => {
    const hang: AgentTransport = {
      id: "h",
      async *send(_p, o) {
        await new Promise((r) => o?.signal?.addEventListener("abort", r));
      },
    };
    expect((await probe(hang, 20)).error).toMatch(/timed out/);
  });
});

describe("installedClis", () => {
  it("skips the retired gemini CLI when agy is installed, but keeps it otherwise", () => {
    expect(installedClis(() => true)).toEqual(["claude", "codex", "agy", "opencode"]);
    expect(installedClis((b) => b === "gemini" || b === "claude")).toEqual(["claude", "gemini"]);
  });
});

describe("health + fallback", () => {
  it("round-trips the health cache and merges updates", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "quorum-health-")), "h.json");
    writeHealth(await doctor(["codex"], () => new MockTransport("codex", { rules: [], fallback: "ok" })), path);
    writeHealth(await doctor(["gemini"], () => failing), path);
    const h = readHealth(path);
    expect(h.codex?.ok).toBe(true);
    expect(h.gemini?.ok).toBe(false);
  });

  it("excludes recently-failed CLIs but retries stale failures", () => {
    const now = Date.now();
    const health = {
      gemini: { ok: false, checkedAt: now - 1000 },
      codex: { ok: false, checkedAt: now - 3 * 24 * 3600_000 },
    };
    expect(usableClis(["claude", "codex", "gemini"], health, now)).toEqual(["claude", "codex"]);
  });

  it("swaps unusable CLIs for usable ones, round-robin, and reports it", () => {
    const { config, substitutions } = resolveAvailable(loadPreset("trio"), ["claude", "codex"]);
    expect(config.agents.map((a) => a.cli)).toEqual(["claude", "codex", "claude"]);
    expect(substitutions).toEqual([{ agent: "pragmatist", from: "agy", to: "claude" }]);
    const diverse = resolveAvailable(loadPreset("trio"), ["claude", "codex", "opencode"]);
    expect(diverse.config.agents.map((a) => a.cli)).toEqual(["claude", "codex", "opencode"]);
  });

  it("leaves a healthy preset and mock agents untouched, and fails loudly with nothing usable", () => {
    const solo = loadPreset("solo");
    expect(resolveAvailable(solo, ["claude"]).substitutions).toEqual([]);
    expect(() => resolveAvailable(solo, [])).toThrow(/no agent CLI is usable/);
    const mock = { ...solo, agents: solo.agents.map((a) => ({ ...a, cli: "mock" as const })), chair: { cli: "mock" as const } };
    expect(resolveAvailable(mock, []).substitutions).toEqual([]);
  });
});
