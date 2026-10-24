import { describe, expect, it } from "vitest";
import { makeIllustrator } from "../src/illustrator.js";
import { makeJev, probTrue, type Decision } from "../src/jev.js";

const reply = (body: unknown, ok = true, status = 200) => async () => ({ ok, status, json: async () => body }) as Response;

describe("makeJev", () => {
  it("is off without a key", () => {
    expect(makeJev({ apiKey: undefined, fetch: reply({}) as never })).toBeUndefined();
  });

  it("posts state and questions with a bearer key and parses decisions", async () => {
    let seen: any;
    const jev = makeJev({
      apiKey: "sk-test",
      fetch: (async (url: string, init: any) => {
        seen = { url, init, body: JSON.parse(init.body) };
        return { ok: true, status: 200, json: async () => ({ decisions: { helps: { value: true, probabilities: { true: 0.9, false: 0.1 } } } }) };
      }) as never,
    })!;
    const out = await jev("some text", { helps: { type: "noul", instructions: "?" } });
    expect(seen.url).toContain("/decisions");
    expect(seen.init.headers.authorization).toBe("Bearer sk-test");
    expect(seen.body).toMatchObject({ model: "typesafe/jev-1.13", state: "some text" });
    expect(probTrue(out.helps)).toBe(0.9);
  });

  it("parses the live shapes: noul as a number, choice with probabilities", async () => {
    const jev = makeJev({ apiKey: "k", fetch: reply({ answers: { q: { type: "noul", noul: 0.98 }, k: { type: "choice", choice: "sequence", probabilities: { sequence: 0.89, none: 0.11 } } } }) as never })!;
    const out = await jev("s", { q: { type: "noul", instructions: "?" }, k: { type: "choice", instructions: "?", criteria: { sequence: "a", none: "b" } } });
    expect(probTrue(out.q)).toBe(0.98);
    expect(out.k.value).toBe("sequence");
  });

  it("accepts the `answers` shape and a bare confidence", async () => {
    const jev = makeJev({ apiKey: "k", fetch: reply({ answers: { q: { type: "noul", value: false, confidence: 0.8 } } }) as never })!;
    expect(probTrue((await jev("s", { q: { type: "noul", instructions: "?" } })).q)).toBeCloseTo(0.2);
  });

  it("throws on HTTP errors and malformed replies", async () => {
    await expect(makeJev({ apiKey: "k", fetch: reply({}, false, 401) as never })!("s", {})).rejects.toThrow("401");
    await expect(makeJev({ apiKey: "k", fetch: reply({ nope: 1 }) as never })!("s", {})).rejects.toThrow("no decisions");
  });
});

const good = JSON.stringify({
  useful: true, kind: "sequence", title: "t",
  actors: [{ id: "a", label: "A", icon: "user" }, { id: "b", label: "B", icon: "server" }],
  steps: [{ from: "a", to: "b", text: "go", evidence: "client sends login request to the API" }, { from: "b", to: "a", text: "ok", evidence: "API answers the client" }],
});
const input = { agent: "x", body: "The client sends login request to the API and the API answers the client." };
const noul = (p: number) => ({ value: p > 0.5, probabilities: { true: p, false: 1 - p } });

describe("illustrator with Jev", () => {
  it("skips the generator when Jev says a diagram would not help", async () => {
    let asked = 0;
    const draw = makeIllustrator(async () => (asked++, good), { jev: async () => ({ helps: noul(0.1), kind: { value: "none", probabilities: {} } }) });
    expect(await draw(input)).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("passes the classified kind to the generator and returns a verified diagram", async () => {
    const prompts: string[] = [];
    const draw = makeIllustrator(async (p) => (prompts.push(p), good), {
      jev: async (_s, q) => ((q.helps ? { helps: noul(0.95), kind: { value: "sequence", probabilities: {} } } : { faithful: noul(0.97) }) as Record<string, Decision>),
    });
    expect(await draw(input)).toBeDefined();
    expect(prompts[0]).toContain('kind "sequence"');
  });

  it("drops a diagram Jev finds unfaithful", async () => {
    const draw = makeIllustrator(async () => good, { jev: async (_s, q) => ((q.helps ? { helps: noul(0.95), kind: { value: "sequence", probabilities: {} } } : { faithful: noul(0.4) }) as Record<string, Decision>) });
    expect(await draw(input)).toBeUndefined();
  });

  it("retries once when Jev finds the diagram unfaithful, then accepts a faithful one", async () => {
    const prompts: string[] = [];
    const verdicts = [0.4, 0.95];
    const draw = makeIllustrator(async (p) => (prompts.push(p), good), {
      jev: async (_s, q) => ((q.helps ? { helps: noul(0.95), kind: { value: "sequence", probabilities: {} } } : { faithful: noul(verdicts.shift()!) }) as Record<string, Decision>),
    });
    expect(await draw(input)).toBeDefined();
    expect(prompts[1]).toContain("fact-checker");
  });

  it("survives a gate outage but never shows an unverified diagram", async () => {
    const draw = makeIllustrator(async () => good, { jev: async () => { throw new Error("offline"); } });
    expect(await draw(input)).toBeUndefined();
  });
});
