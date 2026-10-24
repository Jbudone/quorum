import { designCouncil, mockDesigner, realDesigner } from "../designer.js";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { listPersonas, listPresets, loadPreset, mockify, type CliName, type CouncilConfig } from "../config.js";
import { cliInfo, doctor, installedClis, readHealth, resolveAvailable, usableClis, writeHealth } from "../doctor.js";
import { Engine, type TransportFor } from "../engine.js";
import { councilFromWire, savePreset } from "../library.js";
import { createTransport } from "../transports/index.js";
import { scriptedMock } from "../mock/scripted.js";
import { councilWorkflow } from "../workflows/council.js";

/**
 * NDJSON JSON-RPC over stdio. Client -> engine: {id, method, params}. Engine -> client:
 * {id, result|error} for requests, and {event, data} for engine events (no id).
 *
 * Methods: session.start {preset | config, topic, repo, rounds?, protocol?, pause?, mock?}, session.continue {stop?}, session.steer {text},
 * session.interject {to, text}, session.abort, session.configure {pause?, rounds?}, presets.list, personas.list, clis.list,
 * presets.save {name, config}, doctor.
 */
export interface RpcOptions {
  /** Override transport creation (tests, playground). */
  transportFor?: (config: CouncilConfig) => TransportFor;
  assetsDir?: string;
  /** CLIs allowed for this server; default is installed and not known broken (see doctor). */
  usable?: () => CliName[];
}

const defaultTransportFor =
  (config: CouncilConfig): TransportFor =>
  (agentId) => {
    const spec = config.agents.find((a) => a.id === agentId);
    const cli = agentId === "chair" ? config.chair : spec;
    if (!cli) throw new Error(`unknown agent "${agentId}"`);
    return createTransport({ id: agentId, cli: cli.cli, model: cli.model });
  };

/** Scripted, role-aware mock agents; the persona file name picks each agent's voice. */
function mockTransportFor(config: CouncilConfig, _assetsDir?: string): TransportFor {
  return (agentId) => {
    const spec = config.agents.find((a) => a.id === agentId);
    return scriptedMock(agentId, spec?.persona ?? "chair");
  };
}

export function serve(input: Readable, output: Writable, opts: RpcOptions = {}): Promise<void> {
  const write = (msg: unknown) => output.write(JSON.stringify(msg) + "\n");
  let engine: Engine | undefined;
  let run: Awaited<ReturnType<ReturnType<typeof councilWorkflow>["createRun"]>> | undefined;
  let started = false;
  let running: Promise<unknown> = Promise.resolve();

  const need = (): Engine => {
    if (!engine) throw new Error("no session: call session.start first");
    return engine;
  };

  // Long operations run in the background; their progress arrives as events.
  const background = (fn: () => Promise<unknown>) => {
    running = running
      .then(fn)
      .then(
        () => {},
        (e) => write({ event: "error", data: { message: e instanceof Error ? e.message : String(e) } }),
      )
      // Tells the client the engine is free to take the next request.
      .then(() => write({ event: "idle", data: {} }));
  };

  async function handle(method: string, p: any): Promise<unknown> {
    switch (method) {
      case "session.start": {
        // A full config (from the settings drawer) wins over a preset name.
        let config = p.config ? councilFromWire(p.config, opts.assetsDir) : loadPreset(String(p.preset), opts.assetsDir);
        let substitutions: unknown[] = [];
        const mock = Boolean(p.mock);
        if (mock) config = mockify(config);
        // Injected transports (tests, playground) and mock sessions bypass real-CLI resolution.
        else if (!opts.transportFor) {
          const usable = (opts.usable ?? (() => usableClis(installedClis(), readHealth())))();
          ({ config, substitutions } = resolveAvailable(config, usable));
        }
        if (p.rounds) config.rounds = Number(p.rounds);
        if (p.protocol) config.protocol = String(p.protocol);
        if (p.pause) config.pause = p.pause;
        engine = new Engine({
          config,
          topic: String(p.topic),
          repo: String(p.repo),
          transportFor: mock ? mockTransportFor(config, opts.assetsDir) : (opts.transportFor ?? defaultTransportFor)(config),
          assetsDir: opts.assetsDir,
        });
        engine.on((e) => write(e));
        run = await councilWorkflow(engine).createRun();
        started = false;
        return { sessionId: engine.session.id, dir: engine.session.dir, agents: config.agents.map((a) => a.id),
          substitutions,
          rounds: config.rounds,
          protocol: config.protocol,
          pause: config.pause,
        };
      }
      case "presets.list":
        return listPresets(opts.assetsDir);
      case "personas.list":
        return listPersonas(opts.assetsDir);
      case "clis.list":
        return cliInfo();
      case "presets.save": {
        const file = savePreset(String(p.name), councilFromWire(p.config, opts.assetsDir), opts.assetsDir);
        return { name: String(p.name), file };
      }
      case "council.design": {
        const topic = String(p.topic ?? "").trim();
        if (!topic) throw new Error("tell the designer what the council will work on");
        const clis = p.mock ? [{ cli: "mock" as CliName, usable: true, models: [] as string[] }] : cliInfo();
        const designer = p.mock ? { ask: mockDesigner, cli: "mock" } : realDesigner(clis, String(p.repo ?? process.cwd()));
        const d = await designCouncil(designer.ask, { topic, clis, assetsDir: opts.assetsDir });
        return { ...d, designer: designer.cli };
      }
      case "session.configure":
        return need().configure({ pause: p.pause, rounds: p.rounds });
      case "doctor": {
        // Probes spend a little quota (one tiny turn per CLI), so it only runs when asked.
        const report = await doctor();
        writeHealth(report);
        return report;
      }
      case "session.continue":
        {
          need();
          const stop = Boolean(p.stop);
          background(async () => {
            // First call starts the loop; later calls resume it from the human pause.
            const res = started
              ? await run!.resume({ step: "round", resumeData: { stop } })
              : ((started = true), await run!.start({ inputData: { done: false } }));
            if (res.status === "success") write({ event: "session.done", data: {} });
            else if (res.status === "failed") throw res.error;
          });
        }
        return {};
      case "session.steer":
        need().steer(String(p.text));
        return {};
      case "session.interject":
        {
          const e = need();
          background(() => e.interject(String(p.to), String(p.text)));
        }
        return {};
      case "session.abort":
        need().stop();
        return {};
      default:
        throw new Error(`unknown method "${method}"`);
    }
  }

  return new Promise((resolve) => {
    createInterface({ input }).on("line", async (line) => {
      if (!line.trim()) return;
      let req: any;
      try {
        req = JSON.parse(line);
      } catch {
        return write({ error: { message: "invalid JSON" } });
      }
      try {
        write({ id: req.id, result: await handle(req.method, req.params ?? {}) });
      } catch (e) {
        write({ id: req.id, error: { message: e instanceof Error ? e.message : String(e) } });
      }
    }).on("close", () => void running.then(() => resolve()));
  });
}

export { loadPreset };
