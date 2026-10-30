import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSpec } from "../src/config.js";
import { Room } from "../src/room/room.js";
import { BRIDGE, ToolServer } from "../src/room/tools.js";
import { ClaudeTransport } from "../src/transports/claude.js";
import { CodexTransport } from "../src/transports/codex.js";
import { OpencodeTransport } from "../src/transports/opencode.js";
import type { AgentEvent, AgentTransport, McpServerSpec, SendOptions } from "../src/transports/index.js";

const agents: AgentSpec[] = [
  { id: "arch", cli: "mock", persona: "architect" },
  { id: "skeptic", cli: "mock", persona: "skeptic" },
];

type Call = [name: string, args?: Record<string, unknown>];

/** Calls a room tool the way the bridge does: over HTTP with the turn's token. */
async function call(mcp: McpServerSpec, name: string, args: Record<string, unknown> = {}): Promise<{ text?: string; error?: string }> {
  const res = await fetch(`${mcp.env.QUORUM_ROOM_URL}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${mcp.env.QUORUM_ROOM_TOKEN}` },
    body: JSON.stringify({ name, arguments: args }),
  });
  return res.json();
}

/**
 * Tool-capable fake agents. `script(agent, turn)` lists the tool calls a turn makes; every result is
 * recorded, and each turn ends with throwaway reply text that must never reach the room.
 */
function rig(script: (agent: string, turn: number) => Call[]) {
  const repo = mkdtempSync(join(tmpdir(), "quorum-room-tools-"));
  const results: Record<string, { text?: string; error?: string }[]> = {};
  const prompts: string[] = [];
  const specs: McpServerSpec[] = [];
  const turns: Record<string, number> = {};
  const transportFor = (agent: string): AgentTransport => ({
    id: agent,
    supportsMcp: true,
    async *send(prompt: string, opts?: SendOptions): AsyncIterable<AgentEvent> {
      prompts.push(prompt);
      specs.push(opts!.mcp!);
      for (const [name, args] of script(agent, (turns[agent] = (turns[agent] ?? 0) + 1))) {
        (results[agent] ??= []).push(await call(opts!.mcp!, name, args));
      }
      yield { type: "text", delta: "scratch notes" };
      yield { type: "done" };
    },
  });
  return { repo, transportFor, results, prompts, specs };
}

const rooms: Room[] = [];
afterEach(async () => {
  await Promise.all(rooms.splice(0).map((r) => r.close()));
});

function open(r: ReturnType<typeof rig>, extra: Partial<Parameters<typeof Room.create>[0]> = {}) {
  const room = Room.create({ repo: r.repo, transportFor: r.transportFor, topic: "pick a cache", agents, ...extra });
  rooms.push(room);
  return room;
}

describe("Room tools", () => {
  it("posts, replies and DMs through the tools; the final reply text stays private", async () => {
    const r = rig((agent, n) =>
      agent === "arch" && n === 1
        ? [["post", { text: "Use an LRU.", reply_to: 1 }], ["dm", { to: "skeptic", text: "you'll hate this" }]]
        : [["pass"]],
    );
    // One at a time so message numbers are deterministic.
    const room = open(r, { parallel: 1 });
    room.resume();
    await room.settled();

    const msgs = room.store.events().filter((e) => e.type === "message");
    expect(msgs.map((e) => e.type === "message" && [e.from, e.to, e.text, e.replyTo])).toEqual([
      ["human", "room", "pick a cache", undefined],
      ["arch", "room", "Use an LRU.", 1],
      ["arch", "skeptic", "you'll hate this", undefined],
    ]);
    expect(JSON.stringify(room.store.events())).not.toContain("scratch notes");
    expect(r.results.arch).toEqual([{ text: "Sent as #3." }, { text: "Sent as #4." }]);
    // skeptic's second wake (for arch's messages) shows the reply marker and the DM.
    expect(r.prompts.at(-1)).toContain("[#3] arch (re #1)");
    expect(r.prompts.at(-1)).toContain("[#4] arch → skeptic (private)");
    expect(r.prompts[0]).toContain("Speak only through the quorum tools");
    expect(room.state).toBe("idle");
  });

  it("rejects bad calls with a message the agent can act on", async () => {
    const r = rig((agent, n) =>
      agent === "arch" && n === 1
        ? [
            ["dm", { to: "nobody", text: "hi" }],
            ["dm", { to: "arch", text: "me" }],
            ["post", { text: "  " }],
            ["post", { text: "x", reply_to: 99 }],
            ["shout", {}],
            ...Array.from({ length: 5 }, (_, i): Call => ["post", { text: `point ${i}` }]),
          ]
        : [["pass"]],
    );
    const room = open(r, { agents: agents.slice(0, 1) });
    room.resume();
    await room.settled();
    expect(r.results.arch.map((x) => x.error ?? x.text)).toEqual([
      'no member "nobody"; members are human',
      'no member "arch"; members are human',
      "text is required",
      "no message #99",
      'unknown tool "shout"',
      "Sent as #3.",
      "Sent as #4.",
      "Sent as #5.",
      "Sent as #6.",
      "at most 4 messages per turn; wait for replies",
    ]);
  });

  it("refuses a token once its turn is over", async () => {
    const r = rig(() => [["pass"]]);
    const room = open(r, { agents: agents.slice(0, 1) });
    room.resume();
    await room.settled();
    expect(await call(r.specs[0], "post", { text: "late" })).toEqual({ error: "this turn is over; nothing was sent" });
    expect(await call({ ...r.specs[0], env: { ...r.specs[0].env, QUORUM_ROOM_TOKEN: "forged" } }, "pass")).toMatchObject({
      error: expect.stringMatching(/turn is over/),
    });
  });

  it("pages back through history with read_room", async () => {
    const r = rig((agent, n) => (n === 1 ? [["read_room", { before: 2, limit: 1 }]] : [["pass"]]));
    const room = open(r, { agents: agents.slice(0, 1) });
    room.post("second thought");
    room.resume();
    await room.settled();
    expect(r.results.arch[0].text).toBe("[#1] human:\npick a cache");
  });
});

describe("MCP bridge", () => {
  it("speaks MCP over stdio and forwards calls with the turn token", async () => {
    const seen: unknown[] = [];
    const server = await ToolServer.start((token, name, args) => {
      seen.push([token, name, args]);
      if (name === "pass") throw new Error("not now");
      return "ok";
    });
    const spec = server.spec("tok");
    const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env } });
    const lines = createInterface({ input: child.stdout });
    const replies: any[] = [];
    lines.on("line", (l) => replies.push(JSON.parse(l)));
    const rpc = (id: number | undefined, method: string, params?: unknown) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) + "\n");
    rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    rpc(undefined, "notifications/initialized");
    rpc(2, "tools/list");
    rpc(3, "tools/call", { name: "post", arguments: { text: "hi" } });
    rpc(4, "tools/call", { name: "pass" });
    rpc(5, "bogus");
    while (replies.length < 5) await new Promise((res) => setTimeout(res, 10));
    child.kill();
    await server.close();

    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    expect(byId[1].result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "quorum" } });
    expect(byId[2].result.tools.map((t: any) => t.name)).toEqual(["post", "dm", "pass", "read_room"]);
    expect(byId[3].result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(byId[4].result).toEqual({ content: [{ type: "text", text: "not now" }], isError: true });
    expect(byId[5].error.code).toBe(-32601);
    expect(seen).toEqual([
      ["tok", "post", { text: "hi" }],
      ["tok", "pass", {}],
    ]);
    expect(spec.args).toEqual([BRIDGE]);
  });
});

describe("MCP injection per CLI", () => {
  const mcp: McpServerSpec = { name: "quorum", command: "/usr/bin/node", args: ["/b.mjs"], env: { QUORUM_ROOM_URL: "http://x", QUORUM_ROOM_TOKEN: "t" } };

  it("claude: --mcp-config JSON and pre-approved tools", () => {
    const a = new ClaudeTransport().buildArgs({ mcp });
    expect(JSON.parse(a[a.indexOf("--mcp-config") + 1])).toEqual({
      mcpServers: { quorum: { command: "/usr/bin/node", args: ["/b.mjs"], env: mcp.env } },
    });
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__quorum");
    expect(new ClaudeTransport().buildArgs()).not.toContain("--mcp-config");
  });

  it("codex: -c overrides before the session id", () => {
    const { args } = (new CodexTransport() as any).invocation("p", { mcp, sessionId: "s1" });
    expect(args).toEqual(
      expect.arrayContaining([
        "-c", 'mcp_servers.quorum.command="/usr/bin/node"',
        "-c", 'mcp_servers.quorum.args=["/b.mjs"]',
        "-c", 'mcp_servers.quorum.env={QUORUM_ROOM_URL="http://x", QUORUM_ROOM_TOKEN="t"}',
        "-c", 'mcp_servers.quorum.default_tools_approval_mode="approve"',
      ]),
    );
    expect(args.slice(-2)).toEqual(["s1", "-"]);
  });

  it("opencode: a local mcp entry in the inline config", () => {
    const { env } = (new OpencodeTransport() as any).invocation("p", { mcp });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).mcp).toEqual({
      quorum: { type: "local", command: ["/usr/bin/node", "/b.mjs"], environment: mcp.env },
    });
  });
});
