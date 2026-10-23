import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { loadPreset, type CouncilConfig } from "../config.js";
import { Engine, type TransportFor } from "../engine.js";
import { createTransport } from "../transports/index.js";
import { councilWorkflow } from "../workflows/council.js";

/**
 * NDJSON JSON-RPC over stdio. Client -> engine: {id, method, params}. Engine -> client:
 * {id, result|error} for requests, and {event, data} for engine events (no id).
 *
 * Methods: session.start {preset, topic, repo, rounds?, protocol?, pause?}, session.continue {stop?}, session.steer {text},
 * session.interject {to, text}, session.abort.
 */
export interface RpcOptions {
  /** Override transport creation (tests, playground). */
  transportFor?: (config: CouncilConfig) => TransportFor;
  assetsDir?: string;
}

const defaultTransportFor =
  (config: CouncilConfig): TransportFor =>
  (agentId) => {
    const spec = config.agents.find((a) => a.id === agentId);
    const cli = agentId === "chair" ? config.chair : spec;
    if (!cli) throw new Error(`unknown agent "${agentId}"`);
    return createTransport({ id: agentId, cli: cli.cli, model: cli.model });
  };

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
    running = running.then(fn).then(
      () => {},
      (e) => write({ event: "error", data: { message: e instanceof Error ? e.message : String(e) } }),
    );
  };

  async function handle(method: string, p: any): Promise<unknown> {
    switch (method) {
      case "session.start": {
        const config = loadPreset(String(p.preset), opts.assetsDir);
        if (p.rounds) config.rounds = Number(p.rounds);
        if (p.protocol) config.protocol = String(p.protocol);
        if (p.pause) config.pause = p.pause;
        engine = new Engine({
          config,
          topic: String(p.topic),
          repo: String(p.repo),
          transportFor: (opts.transportFor ?? defaultTransportFor)(config),
          assetsDir: opts.assetsDir,
        });
        engine.on((e) => write(e));
        run = await councilWorkflow(engine).createRun();
        started = false;
        return { sessionId: engine.session.id, dir: engine.session.dir, agents: config.agents.map((a) => a.id) };
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
