// Runs a scripted mock council against a scenario; zero tokens spent.
// Usage: pnpm playground:run [scenario]   (default: auth-rewrite)
import { readFileSync } from "node:fs";
import { MockTransport } from "../engine/src/transports/mock.js";

const name = process.argv[2] ?? "auth-rewrite";
const scenario = JSON.parse(readFileSync(new URL(`./scenarios/${name}.json`, import.meta.url), "utf8")) as {
  topic: string;
  agents: { id: string; role: string; reply: string }[];
};

console.log(`Topic: ${scenario.topic}\n`);
for (const a of scenario.agents) {
  const t = new MockTransport(a.id, { rules: [], fallback: a.reply, chunkDelayMs: 15 });
  process.stdout.write(`${a.id} (${a.role}): `);
  for await (const e of t.send(scenario.topic)) if (e.type === "text") process.stdout.write(e.delta);
  process.stdout.write("\n\n");
}
