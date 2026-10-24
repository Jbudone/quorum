// Records mock council sessions as raw wire traffic, used as golden files by the Go client tests.
// Usage: pnpm -C engine exec tsx ../scripts/record-session.ts <session.ndjson> <settings.ndjson>
//
// Request ids must match the order the TUI makes its calls in, because the Go replay tests answer
// each request with the recorded response of the same id: presets.list, personas.list, clis.list
// at startup, then session.start, session.continue, and so on.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// Never touch the developer's real config while recording a preset save.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "rec-config-"));
const { serve } = await import("../engine/src/rpc/server.js");

async function record(out: string, script: (c: Client) => Promise<void>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buf = "";
  const waiters: (() => void)[] = [];
  output.on("data", (d) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) lines.push(p);
    waiters.splice(0).forEach((w) => w());
  });
  const done = serve(input, output);
  const client: Client = {
    send: (id, method, params = {}) => input.write(JSON.stringify({ id, method, params }) + "\n"),
    count: (pred) => lines.filter((l) => pred(JSON.parse(l))).length,
    until: async (pred) => {
      for (;;) {
        if (lines.some((l) => pred(JSON.parse(l)))) return;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
  };
  await script(client);
  input.end();
  await done;
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`recorded ${lines.length} lines to ${out}`);
}

interface Client {
  send(id: number, method: string, params?: unknown): void;
  count(pred: (m: any) => boolean): number;
  until(pred: (m: any) => boolean): Promise<void>;
}

const repo = () => mkdtempSync(join(tmpdir(), "rec-"));
mkdirSync(join(process.env.XDG_CONFIG_HOME!, "quorum"), { recursive: true });

// 1. A whole session: pick a preset, run rounds, steer, ask the Chair, retune, finish.
await record(process.argv[2], async (c) => {
  c.send(1, "presets.list");
  c.send(2, "personas.list");
  c.send(3, "clis.list");
  c.send(4, "session.start", { preset: "trio", mock: true, rounds: 2, topic: "Replace session cookies with JWTs", repo: repo() });
  await c.until((m) => m.id === 4);
  const paused = () => c.count((m) => m.event === "awaiting_human");
  c.send(5, "session.continue");
  await c.until(() => paused() === 1);
  c.send(6, "session.steer", { text: "Prefer the smallest shippable slice." });
  c.send(7, "session.interject", { to: "chair", text: "Why do they disagree?" });
  await c.until((m) => m.event === "idle" && c.count((x) => x.event === "idle") >= 2);
  c.send(8, "session.configure", { rounds: 2 });
  await c.until((m) => m.id === 8);
  c.send(9, "session.continue");
  await c.until(() => paused() === 2);
  c.send(10, "session.continue");
  await c.until((m) => m.event === "session.done");
});

// 2. The settings drawer's traffic: saving a preset, a rejected config, and starting from a custom one.
await record(process.argv[3], async (c) => {
  const custom = {
    name: "pair",
    protocol: "draft-critique-revise",
    rounds: 1,
    pause: "round",
    readOnly: true,
    requireEvidence: false,
    chair: { cli: "mock" },
    agents: [
      { id: "writer", cli: "mock", persona: "architect" },
      { id: "reviewer", cli: "mock", model: "sonnet", persona: "skeptic" },
    ],
  };
  c.send(1, "presets.save", { name: "pair", config: custom });
  await c.until((m) => m.id === 1);
  c.send(2, "presets.list");
  await c.until((m) => m.id === 2);
  c.send(3, "presets.save", { name: "trio", config: custom });
  await c.until((m) => m.id === 3);
  c.send(4, "session.start", { config: { ...custom, rounds: 0, agents: [] }, mock: true, topic: "t", repo: repo() });
  await c.until((m) => m.id === 4);
  c.send(5, "session.start", { config: custom, mock: true, topic: "t", repo: repo() });
  await c.until((m) => m.id === 5);
  c.send(6, "session.configure", { pause: "message", rounds: 3 });
  await c.until((m) => m.id === 6);
  c.send(7, "session.configure", { rounds: 99 });
  await c.until((m) => m.id === 7);
  // The Auto council: a model designs the council from the topic.
  c.send(8, "council.design", { topic: "Replace session cookies with JWTs", mock: true, repo: repo() });
  await c.until((m) => m.id === 8);
  c.send(9, "council.design", { topic: "  ", mock: true });
  await c.until((m) => m.id === 9);
});
