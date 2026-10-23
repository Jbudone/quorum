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
  it("lists the four presets with each member's role", async () => {
    const h = harness();
    h.send({ id: 1, method: "presets.list" });
    const res = (await h.waitFor((m) => m.id === 1)).result;
    expect(res.map((p: any) => p.name)).toEqual(["solo", "trio", "delphi", "deep"]);
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
  });
});
