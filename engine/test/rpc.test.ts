import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { serve } from "../src/rpc/server.js";
import { MockTransport } from "../src/transports/mock.js";

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  let buf = "";
  output.on("data", (d) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) lines.push(JSON.parse(p));
  });
  const done = serve(input, output, {
    transportFor: () => (id) => new MockTransport(id, { rules: [], fallback: `${id} reply` }),
  });
  const send = (msg: unknown) => input.write(JSON.stringify(msg) + "\n");
  const waitFor = async (pred: (m: any) => boolean, timeoutMs = 1000) => {
    for (let i = 0; i < timeoutMs / 5; i++) {
      const m = lines.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out; saw " + JSON.stringify(lines.map((l) => l.event ?? l.id)));
  };
  return { input, lines, send, waitFor, done };
}

describe("rpc server", () => {
  it("starts a session, streams a round, and pauses for the human", async () => {
    const h = harness();
    h.send({ id: 1, method: "session.start", params: { preset: "solo", protocol: "round-robin", topic: "t", repo: mkdtempSync(join(tmpdir(), "q-")) } });
    const started = await h.waitFor((m) => m.id === 1);
    expect(started.result.agents).toEqual(["architect", "skeptic", "pragmatist"]);

    h.send({ id: 2, method: "session.continue" });
    const paused = await h.waitFor((m) => m.event === "awaiting_human");
    expect(paused.data.round).toBe(1);
    expect(h.lines.filter((m) => m.event === "turn.done")).toHaveLength(3);

    h.send({ id: 3, method: "session.interject", params: { to: "chair", text: "summarize" } });
    await h.waitFor((m) => m.event === "turn.done" && m.data.agent === "chair");
    h.send({ id: 4, method: "session.start", params: { preset: "solo", protocol: "round-robin", rounds: 1, topic: "t", repo: mkdtempSync(join(tmpdir(), "q-")) } });
    await h.waitFor((m) => m.id === 4);
    h.send({ id: 5, method: "session.continue" });
    await h.waitFor((m) => m.event === "awaiting_human" && m.data.finished === true);
    h.send({ id: 6, method: "session.continue" });
    await h.waitFor((m) => m.event === "session.done");
    h.input.end();
    await h.done;
  });

  it("returns errors instead of crashing", async () => {
    const h = harness();
    h.send({ id: 1, method: "session.continue" });
    expect((await h.waitFor((m) => m.id === 1)).error.message).toMatch(/session.start/);
    h.send({ id: 2, method: "nope" });
    expect((await h.waitFor((m) => m.id === 2)).error.message).toMatch(/unknown method/);
    h.input.end();
    await h.done;
  });
});

describe("rpc server: TUI surface", () => {
  it("lists the shipped presets with each member's role", async () => {
    const h = harness();
    h.send({ id: 1, method: "presets.list" });
    const res = (await h.waitFor((m) => m.id === 1)).result;
    expect(res.map((p: any) => p.name)).toEqual(["solo", "trio", "delphi", "deep", "auto"]);
    expect(res[1].agents[0]).toMatchObject({ id: "architect", role: "drafter" });
    h.input.end();
    await h.done;
  });

  it("runs a mock session end to end and reports effective settings, idle, and Chair notes", async () => {
    const h = harness();
    h.send({ id: 1, method: "session.start", params: { preset: "trio", mock: true, rounds: 2, topic: "t", repo: mkdtempSync(join(tmpdir(), "q-")) } });
    const started = (await h.waitFor((m) => m.id === 1)).result;
    expect(started).toMatchObject({ rounds: 2, protocol: "draft-critique-revise", pause: "round", substitutions: [] });

    h.send({ id: 2, method: "session.continue" });
    const summary = await h.waitFor((m) => m.event === "chair.summary", 20_000);
    expect(summary.data).toMatchObject({ round: 1, converged: false });
    expect(summary.data.dissent).toContain("Pragmatist");
    expect(summary.data.questions).toContain("signing-key");
    // plan turns are labelled so the UI can show "updated the plan" instead of dumping the document
    expect(h.lines.find((m) => m.event === "turn.start" && m.data.artifact === "plan")).toBeTruthy();
    expect(h.lines.find((m) => m.event === "turn.start" && m.data.artifact === "chair-report")).toBeTruthy();
    // idle follows every background job so clients can count in-flight work
    await h.waitFor((m) => m.event === "idle", 5000);
    h.input.end();
    await h.done;
  }, 60000);
});

describe("rpc server: customizing a council", () => {
  const goodConfig = {
    name: "pair",
    protocol: "draft-critique-revise",
    rounds: 1,
    pause: "round",
    agents: [
      { id: "writer", cli: "mock", persona: "architect" },
      { id: "reviewer", cli: "mock", persona: "skeptic" },
    ],
    chair: { cli: "mock" },
  };

  it("starts a session from a full custom config instead of a preset name", async () => {
    const h = harness();
    h.send({ id: 1, method: "session.start", params: { config: goodConfig, mock: true, topic: "t", repo: mkdtempSync(join(tmpdir(), "q-")) } });
    const r = (await h.waitFor((m) => m.id === 1)).result;
    expect(r).toMatchObject({ agents: ["writer", "reviewer"], rounds: 1 });
    h.input.end();
    await h.done;
  });

  it("designs a council from the topic (mock) and rejects an empty topic", async () => {
    const h = harness();
    h.send({ id: 1, method: "council.design", params: { topic: "Add SSO", mock: true, repo: "/tmp" } });
    const r = (await h.waitFor((m) => m.id === 1)).result;
    expect(r).toMatchObject({ source: "model", designer: "mock" });
    expect(r.config.agents.map((a: any) => a.id)).toEqual(["architect", "skeptic", "security", "operator"]);
    expect(r.rationale.length).toBeGreaterThan(10);
    h.send({ id: 2, method: "council.design", params: { topic: "  ", mock: true } });
    expect((await h.waitFor((m) => m.id === 2)).error.message).toContain("what the council will work on");
    h.input.end();
    await h.done;
  });

  it("streams a diagram for a reply after the reply itself (mock)", async () => {
    const h = harness();
    h.send({ id: 1, method: "session.start", params: { preset: "trio", mock: true, rounds: 1, topic: "t", repo: mkdtempSync(join(tmpdir(), "q-")) } });
    await h.waitFor((m) => m.id === 1);
    h.send({ id: 2, method: "session.continue" });
    const ev = await h.waitFor((m) => m.event === "turn.diagram" && m.data.agent === "skeptic", 15000);
    expect(ev.data.diagram).toMatchObject({ kind: "attack" });
    const doneAt = h.lines.findIndex((m) => m.event === "turn.done" && m.data.agent === "skeptic");
    expect(doneAt).toBeGreaterThan(-1);
    expect(h.lines.indexOf(ev)).toBeGreaterThan(doneAt);
    h.input.end();
    await h.done;
  }, 20000);

  it("records an answer to an open question in decisions.md and steers the next round with it", async () => {
    const h = harness();
    const repo = mkdtempSync(join(tmpdir(), "q-"));
    h.send({ id: 1, method: "session.start", params: { preset: "solo", mock: true, rounds: 1, topic: "t", repo } });
    const started = (await h.waitFor((m) => m.id === 1)).result;
    h.send({ id: 2, method: "session.steer", params: { text: "Use a 14 day window.", question: "What ends the dual-read window?" } });
    await h.waitFor((m) => m.id === 2);
    const { readFileSync } = await import("node:fs");
    const decisions = readFileSync(join(started.dir, "decisions.md"), "utf8");
    expect(decisions).toContain("**Q:** What ends the dual-read window?");
    expect(decisions).toContain("**A:** Use a 14 day window.");
    h.input.end();
    await h.done;
  });

  it("returns every validation problem to the client", async () => {
    const h = harness();
    h.send({ id: 1, method: "session.start", params: { config: { ...goodConfig, rounds: 0, agents: [] }, topic: "t", repo: "/tmp" } });
    const err = (await h.waitFor((m) => m.id === 1)).error.message;
    expect(err).toContain("at least one member");
    expect(err).toContain("1 to 12");
    h.input.end();
    await h.done;
  });

  it("lists personas (without the Chair), CLIs and saves presets", async () => {
    const h = harness();
    h.send({ id: 1, method: "personas.list" });
    const personas = (await h.waitFor((m) => m.id === 1)).result;
    expect(personas.map((p: any) => p.key)).toEqual(expect.arrayContaining(["architect", "skeptic", "pragmatist"]));
    expect(personas.some((p: any) => p.key === "chair")).toBe(false);

    h.send({ id: 2, method: "clis.list" });
    const clis = (await h.waitFor((m) => m.id === 2)).result;
    expect(Array.isArray(clis)).toBe(true);
    for (const c of clis) expect(c).toHaveProperty("models");

    const name = `pair-${Date.now().toString(36)}`;
    h.send({ id: 3, method: "presets.save", params: { name, config: goodConfig } });
    const saved = (await h.waitFor((m) => m.id === 3)).result;
    expect(saved.file).toContain(`${name}.toml`);
    h.send({ id: 4, method: "presets.list" });
    const presets = (await h.waitFor((m) => m.id === 4)).result;
    expect(presets.find((p: any) => p.name === name)).toMatchObject({ custom: true, protocol: "draft-critique-revise" });

    h.send({ id: 5, method: "presets.save", params: { name: "trio", config: goodConfig } });
    expect((await h.waitFor((m) => m.id === 5)).error.message).toMatch(/built-in/);
    h.input.end();
    await h.done;
  });

  it("retunes a running session and announces it", async () => {
    const h = harness();
    h.send({ id: 1, method: "session.start", params: { preset: "solo", mock: true, topic: "t", repo: mkdtempSync(join(tmpdir(), "q-")) } });
    await h.waitFor((m) => m.id === 1);
    h.send({ id: 2, method: "session.configure", params: { pause: "auto", rounds: 4 } });
    expect((await h.waitFor((m) => m.id === 2)).result).toEqual({ pause: "auto", rounds: 4 });
    expect(h.lines.find((m) => m.event === "config.changed")).toMatchObject({ data: { pause: "auto", rounds: 4 } });
    h.send({ id: 3, method: "session.configure", params: { rounds: 500 } });
    expect((await h.waitFor((m) => m.id === 3)).error.message).toMatch(/1 to 12/);
    h.input.end();
    await h.done;
  });

  it("runs a room: setup chat, channel, ask the assistant, approve a suggestion, reopen", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: any[] = [];
    let buf = "";
    output.on("data", (d) => {
      buf += d;
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const p of parts) lines.push(JSON.parse(p));
    });
    const done = serve(input, output, { mockDelayMs: 0 });
    const send = (msg: unknown) => input.write(JSON.stringify(msg) + "\n");
    const waitFor = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 400; i++) {
        const m = lines.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("timed out; saw " + JSON.stringify(lines.map((l) => l.event ?? l.id)));
    };
    const repo = mkdtempSync(join(tmpdir(), "q-room-"));

    send({ id: 1, method: "room.resume" });
    expect((await waitFor((m) => m.id === 1)).error.message).toMatch(/no room/);

    // First launch: no channels, so the TUI runs the setup chat.
    send({ id: 2, method: "workspace.open", params: { repo } });
    expect((await waitFor((m) => m.id === 2)).result).toEqual({ channels: [], members: [] });
    send({ id: 3, method: "setup.start", params: { repo, mock: true } });
    await waitFor((m) => m.id === 3);
    send({ id: 4, method: "setup.say", params: { text: "Should we add a cache?" } });
    expect((await waitFor((m) => m.event === "setup.reply")).data.proposal).toBeUndefined();
    expect(lines.some((m) => m.event === "setup.delta")).toBe(true);
    send({ id: 5, method: "setup.say", params: { text: "no docs yet" } });
    const proposal = (await waitFor((m) => m.event === "setup.reply" && m.data.proposal)).data.proposal;
    expect(proposal.members.map((x: any) => x.id)).toEqual(["perf-researcher", "reliability-scientist", "product-engineer"]);
    send({ id: 6, method: "setup.create", params: { proposal, turnCap: 20 } });
    const started = (await waitFor((m) => m.id === 6)).result;
    expect(started).toMatchObject({ name: "product-cache", state: "paused", skipped: ["docs"], tuning: { independent: false } });

    send({ id: 7, method: "room.resume" });
    await waitFor((m) => m.event === "room.state" && m.data.state === "paused");
    expect(lines.some((m) => m.event === "room.turn.start")).toBe(true);
    expect(lines.some((m) => m.event === "room.support" && m.data.role === "floor")).toBe(true);
    expect(lines.some((m) => m.event === "room.event" && m.data.type === "tags")).toBe(true);
    expect(lines.some((m) => m.event === "room.event" && m.data.type === "doc.revised")).toBe(true);

    send({ id: 8, method: "room.ask", params: { text: "where are we?" } });
    await waitFor((m) => m.event === "room.event" && m.data.type === "aside" && m.data.kind === "answer");
    expect(lines.some((m) => m.event === "room.assistant.delta")).toBe(true);
    const sug = await waitFor((m) => m.event === "room.event" && m.data.type === "suggestion");
    send({ id: 9, method: "room.resolve", params: { id: sug.data.id, accept: true } });
    await waitFor((m) => m.event === "room.event" && m.data.type === "suggestion.resolved");

    send({ id: 10, method: "room.doc", params: { name: "plan" } });
    expect((await waitFor((m) => m.id === 10)).result.text).toContain("# Plan");
    send({ id: 11, method: "workspace.open", params: { repo } });
    const ws = (await waitFor((m) => m.id === 11)).result;
    expect(ws.channels).toHaveLength(1);
    // Members belong to the workspace (plus anyone the approved suggestion hired).
    expect(ws.members.map((x: any) => x.id)).toEqual(expect.arrayContaining(["perf-researcher", "reliability-scientist", "product-engineer"]));
    send({ id: 12, method: "room.open", params: { repo, id: ws.channels[0].id } });
    expect((await waitFor((m) => m.id === 12)).result.id).toBe(ws.channels[0].id);
    input.end();
    await done;
  });
});

describe("rpc catalog and providers", () => {
  it("serves the mock catalog, stars models, and saves providers and harness order", async () => {
    const prev = { config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME };
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "q-config-"));
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "q-state-"));
    try {
      const h = harness();
      h.send({ id: 1, method: "catalog.list", params: { mock: true } });
      const cat = (await h.waitFor((m) => m.id === 1)).result;
      expect(cat.models.length).toBeGreaterThan(3);
      expect(cat.source.from).toBe("mock");

      h.send({ id: 2, method: "catalog.favourite", params: { key: "anthropic/claude-opus-5-5" } });
      expect((await h.waitFor((m) => m.id === 2)).result.favourites).toEqual(["anthropic/claude-opus-5-5"]);
      h.send({ id: 3, method: "catalog.used", params: { key: "openai/gpt-6-astra" } });
      await h.waitFor((m) => m.id === 3);
      h.send({ id: 4, method: "catalog.list", params: { mock: true } });
      const again = (await h.waitFor((m) => m.id === 4)).result;
      expect(again.models.find((m: any) => m.key === "anthropic/claude-opus-5-5").favourite).toBe(true);
      expect(again.models.find((m: any) => m.key === "openai/gpt-6-astra").lastUsed).toBeGreaterThan(0);

      h.send({ id: 5, method: "providers.set", params: { id: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", models: "a b" } });
      expect((await h.waitFor((m) => m.id === 5)).result.providers.lmstudio).toEqual({ name: "LM Studio", baseUrl: "http://localhost:1234/v1", models: ["a", "b"] });
      h.send({ id: 6, method: "providers.set", params: { id: "bad id!" } });
      expect(JSON.stringify((await h.waitFor((m) => m.id === 6)).error)).toMatch(/provider id/);
      h.send({ id: 7, method: "harnesses.order", params: { order: ["opencode", "claude"] } });
      expect((await h.waitFor((m) => m.id === 7)).result.harnesses.slice(0, 2)).toEqual(["opencode", "claude"]);
      h.send({ id: 8, method: "providers.set", params: { id: "lmstudio", remove: true } });
      expect((await h.waitFor((m) => m.id === 8)).result.providers).toEqual({});
      h.input.end();
      await h.done;
    } finally {
      process.env.XDG_CONFIG_HOME = prev.config;
      process.env.XDG_STATE_HOME = prev.state;
    }
  });
});
