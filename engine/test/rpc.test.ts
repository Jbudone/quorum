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
  const waitFor = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 200; i++) {
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
