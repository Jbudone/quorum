import { buildIllustrator } from "../settings.js";
import { mockIllustrator } from "../illustrator.js";
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
import { Room, type TransportFactory } from "../room/room.js";
import { personaIn, roomTransports, supportFor } from "../room/setup.js";
import { RoomStore } from "../room/store.js";

/**
 * NDJSON JSON-RPC over stdio. Client -> engine: {id, method, params}. Engine -> client:
 * {id, result|error} for requests, and {event, data} for engine events (no id).
 *
 * Methods: session.start {preset | config, topic, repo, rounds?, protocol?, pause?, mock?}, session.continue {stop?}, session.steer {text, question?},
 * session.interject {to, text}, session.abort, session.configure {pause?, rounds?}, presets.list, personas.list, clis.list,
 * presets.save {name, config}, doctor.
 *
 * Rooms: rooms.list {repo}, room.start {preset | config, topic, repo, mock?, parallel?, turnCap?}, room.open {repo, id},
 * room.resume, room.pause {reason?}, room.post {text, to?}, room.ask {text}, room.resolve {id, accept},
 * room.configure {parallel?, turnCap?, quotaWarn?, quotaStop?}, room.focus {slug}, room.closeTopic {slug, why?},
 * room.raise {title}, room.add {persona, cli, model?}, room.remove {id, memo?}, room.rejoin {id}, room.doc {name, version?},
 * room.export {slug}. Room events: room.event (a log entry), room.state, room.turn.start|delta|tool|end, room.usage,
 * room.assistant.delta. Closing stdin pauses the room.
 */
export interface RpcOptions {
  /** Override transport creation (tests, playground). */
  transportFor?: (config: CouncilConfig) => TransportFor;
  assetsDir?: string;
  /** CLIs allowed for this server; default is installed and not known broken (see doctor). */
  usable?: () => CliName[];
  /** Override room transports (tests). */
  roomTransports?: TransportFactory;
  /** Delay between mock room chunks, ms (tests use 0). */
  mockDelayMs?: number;
}

/** Most log entries sent when a room is opened; older history stays on disk. */
const SNAPSHOT_EVENTS = 400;

function snapshot(r: Room) {
  const c = r.store.config();
  return {
    id: r.id,
    dir: r.store.dir,
    topic: c.topic,
    state: r.state,
    agents: c.agents,
    left: c.left ?? [],
    support: c.support,
    tuning: { parallel: c.parallel, turnCap: c.turnCap, quotaWarn: c.quotaWarn, quotaStop: c.quotaStop },
    focus: r.focus() ?? "",
    topics: r.topics(),
    docs: r.docs(),
    pending: r.pending(),
    events: r.store.events().slice(-SNAPSHOT_EVENTS),
  };
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
  let room: Room | undefined;

  const needRoom = (): Room => {
    if (!room) throw new Error("no room: call room.start or room.open first");
    return room;
  };

  /** Swaps in a room and streams its events to the client. */
  const adopt = async (r: Room) => {
    if (room) await room.close();
    room = r;
    r.on((e) => write(e));
  };

  const transportsFor = (personaOf: (id: string) => string): TransportFactory =>
    opts.roomTransports ?? roomTransports(personaOf, opts.mockDelayMs ?? 25);

  // A room's slow jobs (the assistant's answer, a member's exit memo) run beside each other, not in the council queue.
  const side = (fn: () => Promise<unknown>) =>
    void fn().catch((e) => write({ event: "error", data: { message: e instanceof Error ? e.message : String(e) } }));

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
          illustrate: p.diagrams === false ? undefined : mock ? mockIllustrator : opts.transportFor ? undefined : buildIllustrator(cliInfo(), String(p.repo)),
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
        need().steer(String(p.text), p.question ? String(p.question) : undefined);
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

      case "rooms.list":
        return RoomStore.list(String(p.repo));
      case "room.start": {
        let config = p.config ? councilFromWire(p.config, opts.assetsDir) : loadPreset(String(p.preset), opts.assetsDir);
        let substitutions: unknown[] = [];
        let usable: CliName[] = ["mock"];
        if (p.mock) config = mockify(config);
        else if (!opts.roomTransports) {
          usable = (opts.usable ?? (() => usableClis(installedClis(), readHealth())))();
          ({ config, substitutions } = resolveAvailable(config, usable));
        }
        const agents = config.agents;
        const r = Room.create({
          repo: String(p.repo),
          transports: transportsFor((id) => agents.find((a) => a.id === id)?.persona ?? id),
          assetsDir: opts.assetsDir,
          topic: String(p.topic),
          agents,
          support: p.mock || opts.roomTransports ? { assistant: { cli: "mock" }, chair: { cli: "mock" }, scribe: { cli: "mock" } } : supportFor(config, usable),
          parallel: p.parallel ? Number(p.parallel) : undefined,
          turnCap: p.turnCap ? Number(p.turnCap) : undefined,
        });
        await adopt(r);
        return { ...snapshot(r), substitutions };
      }
      case "room.open": {
        const store = RoomStore.open(String(p.repo), String(p.id));
        const r = Room.open(String(p.id), { repo: String(p.repo), transports: transportsFor(personaIn(() => store.config())), assetsDir: opts.assetsDir });
        await adopt(r);
        return snapshot(r);
      }
      case "room.resume":
        needRoom().resume();
        return {};
      case "room.pause":
        needRoom().pause(p.reason ? String(p.reason) : undefined);
        return {};
      case "room.post":
        return { seq: needRoom().post(String(p.text ?? ""), p.to ? String(p.to) : "room").seq };
      case "room.ask": {
        const r = needRoom();
        const text = String(p.text ?? "");
        if (!text.trim()) throw new Error("ask something first");
        side(() => r.ask(text, (delta) => write({ event: "room.assistant.delta", data: { delta } })));
        return {};
      }
      case "room.resolve": {
        const r = needRoom();
        side(() => r.resolve(Number(p.id), Boolean(p.accept)));
        return {};
      }
      case "room.configure":
        return needRoom().configure({ parallel: p.parallel, turnCap: p.turnCap, quotaWarn: p.quotaWarn, quotaStop: p.quotaStop });
      case "room.focus":
        needRoom().setFocus(String(p.slug));
        return {};
      case "room.closeTopic":
        needRoom().closeTopic(String(p.slug), "human", p.why ? String(p.why) : undefined);
        return {};
      case "room.raise":
        return { slug: needRoom().raiseTopic(String(p.title ?? ""), "human") };
      case "room.add":
        return { id: needRoom().addMember({ persona: String(p.persona), cli: String(p.cli) as CliName, model: p.model ? String(p.model) : undefined }) };
      case "room.remove": {
        const r = needRoom();
        side(() => r.removeMember(String(p.id), p.memo !== false));
        return {};
      }
      case "room.rejoin":
        return { id: needRoom().rejoin(String(p.id)) };
      case "room.doc": {
        const r = needRoom();
        const name = String(p.name ?? "").replace(/\.md$/, "");
        if (r.docs().some((d) => d.slug === name)) return { name, text: r.store.readOutput(name, p.version ? Number(p.version) : undefined) };
        const text = RoomStore.isDocPath(`${name}.md`) ? r.store.readDoc(`${name}.md`) : "";
        if (!text) throw new Error(`nothing called "${name}"`);
        return { name, text };
      }
      case "room.export":
        return { url: await needRoom().exportIssue(String(p.slug)) };
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
    }).on("close", () => {
      // Closing the interface pauses the room; it resumes from disk next time.
      void Promise.all([running, room?.close()]).then(() => resolve());
    });
  });
}

export { loadPreset };
