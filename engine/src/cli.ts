#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPreset, mockify, type CliName } from "./config.js";
import { doctor, installedClis, readHealth, resolveAvailable, usableClis, writeHealth } from "./doctor.js";
import { Engine } from "./engine.js";
import { Room } from "./room/room.js";
import { RoomStore } from "./room/store.js";
import { serve } from "./rpc/server.js";
import { createTransport } from "./transports/index.js";

const HELP = `quorum-engine

  quorum-engine serve                     NDJSON JSON-RPC on stdin/stdout (used by the TUI)
  quorum-engine doctor                    probe each installed agent CLI with one tiny turn
  quorum-engine run --topic "..." [opts]  headless council, prints the transcript
  quorum-engine room --topic "..." [opts] headless room until it pauses or goes idle
  quorum-engine room --resume <id> [opts] reopen a saved room (latest: --resume last)

run options:
  --preset <name>   solo | trio | delphi | deep   (default: solo)
  --repo <dir>      project to ground the council in (default: cwd)
  --rounds <n>      override the preset's round count
  --protocol <name> override the preset's protocol (e.g. round-robin)
  --mock            use scripted mock agents (no tokens)

room options: --preset, --repo and --mock as above, plus
  --parallel <n>    most agents speaking at once (default 2)
  --turns <n>       turn cap per resume (default 40)
`;

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

async function room(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      preset: { type: "string", default: "trio" },
      topic: { type: "string" },
      resume: { type: "string" },
      repo: { type: "string", default: process.cwd() },
      parallel: { type: "string" },
      turns: { type: "string" },
      mock: { type: "boolean", default: false },
    },
  });
  const repo = resolve(values.repo!);
  const clis = new Map<string, { cli: CliName; model?: string }>();
  const transportFor = (id: string) =>
    createTransport({
      id,
      ...(values.mock ? { cli: "mock" as const } : clis.get(id)!),
      mock: { rules: [], fallback: `[${id}] mock reply`, chunkDelayMs: 0 },
    });
  let r: Room;
  if (values.resume) {
    const id = values.resume === "last" ? RoomStore.list(repo)[0] : values.resume;
    if (!id) throw new Error("no saved rooms here");
    for (const a of RoomStore.open(repo, id).config().agents) clis.set(a.id, a);
    r = Room.open(id, { repo, transportFor });
    r.configure({
      parallel: values.parallel ? Number(values.parallel) : undefined,
      turnCap: values.turns ? Number(values.turns) : undefined,
    });
  } else {
    if (!values.topic) throw new Error("--topic or --resume is required");
    let config = loadPreset(values.preset!);
    if (values.mock) config = mockify(config);
    else config = resolveAvailable(config, usableClis(installedClis(), readHealth())).config;
    for (const a of config.agents) clis.set(a.id, a);
    r = Room.create({
      repo,
      transportFor,
      topic: values.topic,
      agents: config.agents,
      parallel: values.parallel ? Number(values.parallel) : undefined,
      turnCap: values.turns ? Number(values.turns) : undefined,
    });
  }
  r.on((e) => {
    if (e.event === "room.event" && e.data.type === "message" && e.data.from !== "human")
      console.log(`\n#${e.data.seq} ${e.data.from}:\n${e.data.text}`);
    if (e.event === "room.event" && e.data.type === "pass") console.log(`\n#${e.data.seq} ${e.data.from} passes`);
    if (e.event === "room.event" && e.data.type === "turn.failed") console.error(`\n! ${e.data.agent}: ${e.data.message}`);
    if (e.event === "room.state" && e.data.state !== "running") console.log(`\n── ${e.data.state}${e.data.reason ? `: ${e.data.reason}` : ""} ──`);
  });
  process.once("SIGINT", () => r.pause("interrupted"));
  r.resume();
  await r.settled();
  console.log(`\nRoom saved to ${r.store.dir}\nResume with: quorum-engine room --resume ${r.id}`);
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
  else if (cmd === "room") await room(rest);
  else if (cmd === "doctor") await runDoctor();
  else console.log(HELP);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
