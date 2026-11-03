// How Quorum's prompts are doing, from the calls channels logged (calls.jsonl in each channel).
// Usage: pnpm improve [<room dir>...] [--days N] [--examples] [--diagnose [--model M]] [--json]
// With no room dirs it reads every channel that has logged calls. Nothing in the rooms is changed.
// --diagnose asks a model (Claude, run read-only in Quorum's folder) why the flagged prompts miss
// and for edits as diffs; it changes no files.
import { resolve } from "node:path";
import { knownRooms } from "../engine/src/improve/calls.js";
import { analyze, diagnosePrompt, formatHealth, quorumRoot } from "../engine/src/improve/report.js";
import { createTransport } from "../engine/src/transports/index.js";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const value = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const days = Number(value("--days") ?? 0);
const model = value("--model");
const dirs = args.filter((a, i) => !a.startsWith("--") && !["--days", "--model"].includes(args[i - 1] ?? ""));
const rooms = dirs.length ? dirs.map((d) => resolve(process.env.INIT_CWD ?? process.cwd(), d)) : knownRooms();

const h = analyze(rooms, days ? { since: Date.now() - days * 86_400_000 } : {});
if (flag("--json")) {
  console.log(JSON.stringify(h, null, 2));
  process.exit(0);
}
console.log(formatHealth(h, { examples: flag("--examples") || flag("--diagnose") }));

if (flag("--diagnose")) {
  const prompt = diagnosePrompt(h);
  if (!prompt) {
    console.log("\nNothing to diagnose: no prompt needs work.");
    process.exit(0);
  }
  console.log("\n## Diagnosis\n");
  const t = createTransport({ id: "improver", cli: "claude", ...(model ? { model } : {}) });
  for await (const e of t.send(prompt, { cwd: quorumRoot(), readOnly: true, systemPrompt: "You review and improve LLM prompts in a codebase. Be concrete and brief." })) {
    if (e.type === "text") process.stdout.write(e.delta);
    else if (e.type === "error") console.error(`\n(${e.message})`);
  }
  console.log();
}
