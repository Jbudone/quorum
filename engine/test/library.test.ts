import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSETS,
  listPersonas,
  listPresets,
  loadPersona,
  loadPreset,
  type CouncilConfig,
} from "../src/config.js";
import { Engine, type EngineEvent } from "../src/engine.js";
import { councilFromWire, councilToToml, savePreset, validateCouncil } from "../src/library.js";
import { cliInfo } from "../src/doctor.js";
import { MockTransport } from "../src/transports/mock.js";

const tmp = () => mkdtempSync(join(tmpdir(), "quorum-lib-"));
const base = (): CouncilConfig => structuredClone(loadPreset("trio", DEFAULT_ASSETS, tmp()));
const errs = (c: CouncilConfig) => validateCouncil(c, DEFAULT_ASSETS, tmp());

describe("validateCouncil", () => {
  it("accepts every shipped preset", () => {
    for (const n of ["solo", "trio", "delphi", "deep", "auto"]) expect(errs(loadPreset(n, DEFAULT_ASSETS, tmp()))).toEqual([]);
  });

  it("explains each kind of mistake in plain words", () => {
    const c = base();
    c.agents[1].id = c.agents[0].id; // duplicate
    c.agents[2].id = "chair"; // reserved
    c.agents[0].cli = "nope" as never;
    c.agents[0].persona = "ghost";
    c.agents[1].model = "-rf";
    c.rounds = 13;
    c.protocol = "vibes";
    const all = errs(c).join(" | ");
    for (const want of ["two members are called", "reserved", 'unknown agent CLI "nope"', 'no persona called "ghost"', "not a valid model", "1 to 12", 'unknown protocol "vibes"']) {
      expect(all).toContain(want);
    }
  });

  it("requires two members for protocols where members respond to each other", () => {
    const c = base();
    c.agents = c.agents.slice(0, 1);
    expect(errs(c).join()).toContain("needs at least two members");
    c.protocol = "round-robin";
    expect(errs(c)).toEqual([]);
    c.agents = [];
    expect(errs(c).join()).toContain("at least one member");
  });
});

describe("councilFromWire", () => {
  it("normalizes blank models and applies defaults", () => {
    const c = councilFromWire({
      protocol: "delphi",
      rounds: 2,
      chair: { cli: "claude", model: "  " },
      agents: [
        { id: "a", cli: "claude", model: "", persona: "architect" },
        { id: "b", cli: "codex", model: "opus ", persona: "skeptic" },
      ],
    }, DEFAULT_ASSETS, tmp());
    expect(c.pause).toBe("round");
    expect(c.readOnly).toBe(true);
    expect(c.chair.model).toBeUndefined();
    expect(c.agents.map((a) => a.model)).toEqual([undefined, "opus"]);
  });

  it("reports every problem in one error", () => {
    expect(() => councilFromWire({ rounds: 0, agents: [{ id: "Bad Name", cli: "claude", persona: "architect" }] }, DEFAULT_ASSETS, tmp())).toThrow(
      /not a valid member name.*1 to 12|1 to 12.*not a valid member name/,
    );
  });
});

describe("saving presets and personas", () => {
  it("round-trips through TOML and shows up as a custom preset with full settings", () => {
    const user = tmp();
    const c = base();
    c.agents[0].model = "sonnet";
    c.pause = "message";
    c.requireEvidence = true;
    const file = savePreset("my-review", c, DEFAULT_ASSETS, user);
    expect(file).toBe(join(user, "presets", "my-review.toml"));
    expect(parse(readFileSync(file, "utf8")).name).toBe("my-review");

    const back = loadPreset("my-review", DEFAULT_ASSETS, user);
    expect(back).toMatchObject({ name: "my-review", pause: "message", requireEvidence: true, protocol: c.protocol });
    expect(back.agents).toEqual(c.agents);

    const list = listPresets(DEFAULT_ASSETS, user);
    expect(list.map((p) => p.name)).toEqual(["solo", "trio", "delphi", "deep", "auto", "my-review"]);
    const mine = list.at(-1)!;
    expect(mine).toMatchObject({ custom: true, pause: "message", requireEvidence: true });
    expect(mine.agents[0]).toMatchObject({ model: "sonnet", role: "drafter" });
    expect(list.slice(0, 4).every((p) => !p.custom)).toBe(true);
  });

  it("refuses shipped names, bad names and invalid councils", () => {
    const user = tmp();
    expect(() => savePreset("trio", base(), DEFAULT_ASSETS, user)).toThrow(/built-in/);
    expect(() => savePreset("Not Ok", base(), DEFAULT_ASSETS, user)).toThrow(/starts with a letter/);
    const bad = base();
    bad.rounds = 0;
    expect(() => savePreset("fine", bad, DEFAULT_ASSETS, user)).toThrow(/1 to 12/);
  });

  it("ignores a broken user preset instead of breaking the picker", () => {
    const user = tmp();
    mkdirSync(join(user, "presets"));
    writeFileSync(join(user, "presets", "busted.toml"), "this is = not [valid");
    expect(listPresets(DEFAULT_ASSETS, user).map((p) => p.name)).toEqual(["solo", "trio", "delphi", "deep", "auto"]);
  });

  it("lets a user persona add to or override the shipped ones", () => {
    const user = tmp();
    mkdirSync(join(user, "personas"));
    writeFileSync(join(user, "personas", "gadfly.md"), "---\nname: Gadfly\nrole: critic\n---\nPoke holes.");
    writeFileSync(join(user, "personas", "skeptic.md"), "---\nname: Skeptic\nrole: critic\n---\nMine.");
    expect(loadPersona("skeptic", DEFAULT_ASSETS, user).body).toBe("Mine.");
    const list = listPersonas(DEFAULT_ASSETS, user);
    expect(list.find((p) => p.key === "gadfly")).toMatchObject({ name: "Gadfly", role: "critic", custom: true });
    expect(list.find((p) => p.key === "skeptic")?.custom).toBe(true);
    expect(list.find((p) => p.key === "architect")?.custom).toBe(false);
    expect(list.some((p) => p.key === "chair")).toBe(false); // the Chair is not a pickable member
    // a council can use it
    const c = base();
    c.agents[1].persona = "gadfly";
    expect(validateCouncil(c, DEFAULT_ASSETS, user)).toEqual([]);
  });

  it("writes TOML shaped like the shipped presets", () => {
    const toml = councilToToml(base());
    expect(toml).toContain("read_only = true");
    expect(toml).toContain("[chair]");
    expect(toml).toContain("[[agents]]");
  });
});

describe("Engine.configure", () => {
  function engine(rounds: number) {
    const e = new Engine({
      config: { ...loadPreset("solo", DEFAULT_ASSETS, tmp()), protocol: "round-robin", pause: "round", rounds },
      topic: "t",
      repo: tmp(),
      transportFor: (id) => new MockTransport(id, { rules: [], fallback: "ok" }),
    });
    const events: EngineEvent[] = [];
    e.on((x) => events.push(x));
    return { e, events };
  }

  it("changes pacing live and announces it", async () => {
    const { e, events } = engine(2);
    expect(e.configure({ pause: "auto" })).toEqual({ pause: "auto", rounds: 2 });
    await e.continue();
    expect(events.filter((x) => x.event === "round.done")).toHaveLength(2); // auto ran every round
    expect(events.find((x) => x.event === "config.changed")).toMatchObject({ data: { pause: "auto", rounds: 2 } });
  });

  it("lets a finished council keep going by raising rounds, and never drops below the current round", async () => {
    const { e } = engine(1);
    await e.continue();
    expect(e.finished).toBe(true);
    e.configure({ rounds: 3 });
    expect(e.finished).toBe(false);
    await e.continue();
    expect(e.currentRound).toBe(2);
    expect(e.configure({ rounds: 1 }).rounds).toBe(2); // clamped to the round underway
  });

  it("rejects nonsense", () => {
    const { e } = engine(2);
    expect(() => e.configure({ pause: "sometimes" as never })).toThrow(/pause must be/);
    expect(() => e.configure({ rounds: 0 })).toThrow(/1 to 12/);
    expect(() => e.configure({ rounds: 99 })).toThrow(/1 to 12/);
  });
});

describe("cliInfo", () => {
  it("reports usability and model suggestions from cached health without probing", () => {
    const info = cliInfo(["claude", "agy"], { agy: { ok: false, checkedAt: Date.now(), error: "signed out" } });
    expect(info.find((i) => i.cli === "claude")).toMatchObject({ usable: true });
    expect(info.find((i) => i.cli === "claude")?.models).toContain("sonnet");
    expect(info.find((i) => i.cli === "agy")).toMatchObject({ usable: false, error: "signed out" });
    expect(info.find((i) => i.cli === "agy")?.models.some((m) => m.startsWith("gemini-"))).toBe(true);
  });
});
