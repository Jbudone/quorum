// Records a full mock council session as raw wire traffic, used as a golden file by the Go client tests.
// Usage: pnpm -C engine exec tsx ../scripts/record-session.ts <out.ndjson>
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serve } from "../engine/src/rpc/server.js";

const out = process.argv[2];
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
const send = (id: number, method: string, params: unknown = {}) =>
  input.write(JSON.stringify({ id, method, params }) + "\n");
const until = async (pred: (m: any) => boolean) => {
  for (;;) {
    if (lines.some((l) => pred(JSON.parse(l)))) return;
    await new Promise<void>((r) => waiters.push(r));
  }
};

send(1, "presets.list");
send(2, "session.start", { preset: "trio", mock: true, rounds: 2, topic: "Replace session cookies with JWTs", repo: mkdtempSync(join(tmpdir(), "rec-")) });
await until((m) => m.id === 2);
const seen = () => lines.filter((l) => JSON.parse(l).event === "awaiting_human").length;
send(3, "session.continue");
await until(() => seen() === 1);
send(4, "session.steer", { text: "Prefer the smallest shippable slice." });
send(5, "session.interject", { to: "chair", text: "Why do they disagree?" });
await until((m) => m.event === "idle" && lines.filter((l) => JSON.parse(l).event === "idle").length >= 2);
send(6, "session.continue");
await until(() => seen() === 2);
send(7, "session.continue");
await until((m) => m.event === "session.done");
input.end();
await done;
writeFileSync(out, lines.join("\n") + "\n");
console.log(`recorded ${lines.length} lines to ${out}`);
