#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPreset, type CouncilConfig } from "./config.js";
import { doctor, installedClis, readHealth, resolveAvailable, usableClis, writeHealth } from "./doctor.js";
import { Engine } from "./engine.js";
import { serve } from "./rpc/server.js";
import { createTransport } from "./transports/index.js";

const HELP = `quorum-engine

  quorum-engine serve                     NDJSON JSON-RPC on stdin/stdout (used by the TUI)
  quorum-engine doctor                    probe each installed agent CLI with one tiny turn
  quorum-engine run --topic "..." [opts]  headless council, prints the transcript

run options:
  --preset <name>   solo | trio | delphi | deep   (default: solo)
  --repo <dir>      project to ground the council in (default: cwd)
  --rounds <n>      override the preset's round count
  --protocol <name> override the preset's protocol (e.g. round-robin)
  --mock            use scripted mock agents (no tokens)
`;

function mockify(config: CouncilConfig): CouncilConfig {
  return {
    ...config,
    agents: config.agents.map((a) => ({ ...a, cli: "mock" as const })),
    chair: { cli: "mock" },
  };
}

async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      preset: { type: "string", default: "solo" },
      topic: { type: "string" },
      repo: { type: "string", default: process.cwd() },
      rounds: { type: "string" },
      protocol: { type: "string" },
      mock: { type: "boolean", default: false },
    },
  });
  if (!values.topic) throw new Error("--topic is required");
  let config = loadPreset(values.preset!);
  if (values.rounds) config.rounds = Number(values.rounds);
  if (values.protocol) config.protocol = values.protocol;
  if (values.mock) config = mockify(config);
  else {
    const r = resolveAvailable(config, usableClis(installedClis(), readHealth()));
    config = r.config;
    for (const s of r.substitutions) console.error(`note: ${s.agent} uses ${s.to} instead of ${s.from} (${s.from} is unavailable)`);
  }
  // Headless has nobody to pause for, so run straight through.
  config.pause = "auto";

  const engine = new Engine({
    config,
    topic: values.topic,
    repo: resolve(values.repo!),
    transportFor: (id) => {
      const c = id === "chair" ? config.chair : config.agents.find((a) => a.id === id)!;
      return createTransport({
        id,
        cli: c.cli,
        model: c.model,
        mock: { rules: [], fallback: `[${id}] mock reply`, chunkDelayMs: 0 },
      });
    },
  });
  let speaking = "";
  engine.on((e) => {
    if (e.event === "round.start") console.log(`\n── Round ${e.data.round} ──`);
    if (e.event === "turn.delta") {
      if (speaking !== e.data.agent) process.stdout.write(`\n${e.data.agent}: `);
      speaking = e.data.agent;
      process.stdout.write(e.data.delta);
    }
    if (e.event === "chair.summary")
      console.log(`\n\n┃ Chair${e.data.converged ? " (converged)" : ""}: ${e.data.summary}`);
    if (e.event === "error") console.error(`\n! ${e.data.agent ?? ""} ${e.data.message}`);
    if (e.event === "usage" && e.data.quotaUtilization !== undefined)
      console.error(`\n(quota ${(e.data.quotaUtilization * 100).toFixed(0)}% of window)`);
  });
  await engine.continue();
  console.log(`\n\nSession saved to ${engine.session.dir}`);
}

async function runDoctor(): Promise<void> {
  const clis = installedClis();
  console.log(`probing ${clis.join(", ")} ...`);
  const report = await doctor(clis);
  writeHealth(report);
  for (const [cli, h] of Object.entries(report)) {
    const quota = h.quotaUtilization === undefined ? "" : `  quota ${(h.quotaUtilization * 100).toFixed(0)}%`;
    console.log(h.ok ? `  ✓ ${cli.padEnd(9)} ${((h.ms ?? 0) / 1000).toFixed(1)}s${quota}` : `  ✗ ${cli.padEnd(9)} ${h.error}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "serve") await serve(process.stdin, process.stdout);
  else if (cmd === "run") await run(rest);
  else if (cmd === "doctor") await runDoctor();
  else console.log(HELP);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
