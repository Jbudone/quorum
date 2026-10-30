import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { parseDirectives, parseFileBlocks } from "../src/room/directives.js";
import { computeSignals } from "../src/room/signals.js";
import type { RoomEvent } from "../src/room/store.js";
import { BRIDGE, ROOM_TOOLS, ToolServer } from "../src/room/tools.js";
import { ClaudeTransport } from "../src/transports/claude.js";
import { CodexTransport } from "../src/transports/codex.js";
import { OpencodeTransport } from "../src/transports/opencode.js";
import type { McpServerSpec } from "../src/transports/index.js";
import { AGENTS, callTool, messages, rig, types, type ToolCall } from "./roomRig.js";

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
});
const setup = (o: Parameters<typeof rig>[0] = {}) => {
  const r = rig(o);
  cleanup.push(r.closeAll);
  return r;
};
/** Members whose first turn runs `first` and who pass ever after. */
const firstTurn = (who: string, first: ToolCall[], say?: string) => (agent: string, n: number) =>
  agent === who && n === 1 ? { tools: first, say } : "PASS";

describe("Room tools", () => {
  it("speaks in reply text, DMs through a tool, and drops what was written before the tool call", async () => {
    const r = setup({ member: firstTurn("arch", [["dm", { to: "skeptic", text: "you'll hate this" }]], "Use an LRU.") });
    // One at a time so message numbers are deterministic.
    const room = r.create({ parallel: 1 });
    room.resume();
    await room.settled();

    expect(messages(room).map((e) => e.type === "message" && [e.from, e.to, e.text, e.replyTo])).toEqual([
      ["human", "room", "pick a cache", undefined],
      ["arch", "skeptic", "you'll hate this", undefined],
      ["arch", "room", "Use an LRU.", 3],
    ]);
    expect(JSON.stringify(room.store.events())).not.toContain("thinking aloud");
    expect(r.results.arch).toEqual([{ text: "Sent privately to skeptic as #6." }]);
    expect(r.memberCalls()[0].prompt).toContain("Tools are for side actions only");
    expect(room.state).toBe("idle");
  });

  it("rejects bad calls with a message the member can act on", async () => {
    const r = setup({
      member: firstTurn("arch", [
        ["dm", { to: "nobody", text: "hi" }],
        ["dm", { to: "arch", text: "me" }],
        ["dm", { to: "human", text: "  " }],
        ["post", { text: "x" }],
        ["read_doc", { name: "nothing" }],
      ]),
    });
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    room.resume();
    await room.settled();
    expect(r.results.arch.map((x) => x.error ?? x.text)).toEqual([
      'no member "nobody"; members are human',
      'no member "arch"; members are human',
      "text is required",
      'unknown tool "post"',
      'nothing called "nothing".\nNo documents yet.\nShared notes: none yet',
    ]);
  });

  it("refuses a token once its turn is over", async () => {
    const r = setup({ member: () => "PASS" });
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    room.resume();
    await room.settled();
    const spec = r.memberCalls()[0].opts!.mcp!;
    expect(await callTool(spec, "dm", { to: "human", text: "late" })).toEqual({ error: "this turn is over; nothing was sent" });
    expect(await callTool({ ...spec, env: { ...spec.env, QUORUM_ROOM_TOKEN: "forged" } }, "read_doc")).toMatchObject({ error: expect.stringMatching(/turn is over/) });
  });

  it("pages back through history with read_room", async () => {
    const r = setup({ member: firstTurn("arch", [["read_room", { before: 4, limit: 1 }]]) });
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    room.post("second thought");
    room.resume();
    await room.settled();
    expect(r.results.arch[0].text).toBe("[#3] human:\npick a cache");
  });

  it("raises topics and moves focus", async () => {
    const r = setup({ member: firstTurn("arch", [["raise_topic", { title: "Bulk import consistency", why: "keeps coming up" }]], "Raised it.") });
    const room = r.create({ parallel: 1 });
    room.resume();
    await room.settled();
    expect(room.topics()).toEqual([
      { slug: "pick-a-cache", title: "pick a cache", closed: false },
      { slug: "bulk-import-consistency", title: "Bulk import consistency", closed: false },
    ]);
    expect(r.results.arch[0].text).toMatch(/Raised as bulk-import-consistency/);

    room.setFocus("bulk-import-consistency");
    await room.settled();
    expect(room.focus()).toBe("bulk-import-consistency");
    expect(() => room.setFocus("nope")).toThrow(/no topic/);
    room.closeTopic("pick-a-cache", "human", "settled");
    expect(room.topics()[0].closed).toBe(true);
    expect(() => room.setFocus("pick-a-cache")).toThrow(/closed/);
  });

  it("versions documents, reads them back, and keeps private notebooks", async () => {
    const r = setup({
      member: firstTurn("arch", [
        ["doc_draft", { name: "Plan", kind: "plan", text: "# Plan\nv1" }],
        ["doc_draft", { name: "plan", text: "# Plan\nv2", note: "tighter" }],
        ["read_doc", { name: "plan" }],
        ["read_doc", {}],
        ["notebook_write", { text: "check TTL" }],
        ["notebook_read"],
      ]),
    });
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    room.resume();
    await room.settled();
    expect(r.results.arch.map((x) => x.error ?? x.text)).toEqual([
      "Saved plan v1.",
      "Saved plan v2.",
      "plan v2:\n\n# Plan\nv2\n",
      "Documents: plan v2\nShared notes: none yet",
      "Notebook saved.",
      "check TTL\n",
    ]);
    expect(room.docs()).toEqual([{ slug: "plan", version: 2, kind: "plan" }]);
    expect(room.store.events().filter((e) => e.type === "doc.revised").at(-1)).toMatchObject({ note: "tighter", by: "arch" });

    // On a fresh start the member sees its notebook and the documents.
    room.store.saveAgentState("arch", { lastRead: 0, turns: 3 });
    room.post("next");
    await room.settled();
    const fresh = r.memberCalls().at(-1)!.prompt;
    expect(fresh).toContain("Your private notebook:\ncheck TTL");
    expect(fresh).toContain("Documents: plan (plan) v2");
  });
});

describe("Room support roles", () => {
  it("the Chair posts, nudges, raises topics, proposes focus, and accepting a document pauses for review", async () => {
    const r = setup({
      member: firstTurn("arch", [["doc_draft", { name: "plan", kind: "plan", text: "# Plan" }]], "drafted"),
      chair: [
        "Skeptic, your view?\n>> nudge: skeptic | weigh in on the plan\n>> raise: Rollout | keeps coming up\n>> focus: rollout | next\n>> accept: plan v1\n>> launch: rockets",
        "PASS",
      ],
    });
    const room = r.create({ parallel: 1 });
    room.resume();
    await room.settled();
    const chair = messages(room).filter((e) => e.type === "message" && e.from === "chair");
    expect(chair.map((e) => e.type === "message" && [e.to, e.text])).toEqual([
      ["skeptic", "weigh in on the plan"],
      ["room", "Skeptic, your view?"],
    ]);
    expect(room.topics().map((t) => t.slug)).toContain("rollout");
    expect(room.pending()).toMatchObject([{ from: "chair", action: "focus", args: ["rollout"], why: "next" }]);
    expect(room.docs()[0]).toMatchObject({ slug: "plan", accepted: 1 });
    expect(room.state).toBe("paused");
    expect(room.store.events().find((e) => e.type === "paused")).toMatchObject({ reason: "milestone: plan v1 accepted" });

    await room.resolve(room.pending()[0].id, true);
    expect(room.focus()).toBe("rollout");
    expect(room.pending()).toEqual([]);
    await expect(room.resolve(99, true)).rejects.toThrow(/no open suggestion/);
  });

  it("the scribe writes only allowed docs and tags code notes with the commit", async () => {
    const r = setup({
      member: () => "PASS",
      scribe: ["=== decisions.md ===\n- LRU (#3)\n=== ../../etc/passwd ===\nnope\n=== topics/pick-a-cache.md ===\nwhere we are\n=== code-notes.md ===\nrepo layer"],
    });
    const room = r.create({ agents: AGENTS.slice(0, 1) });
    room.post("more");
    await room.runScribe();
    expect(room.store.docPaths()).toEqual(["decisions.md", "code-notes.md", "topics/pick-a-cache.md"]);
    expect(room.store.events().at(-1)).toMatchObject({ type: "docs.updated", files: ["decisions.md", "topics/pick-a-cache.md", "code-notes.md"] });
    expect(room.store.meta()).toMatchObject({ codeCommit: "abc123", scribeSeq: 4 });

    // When the repo moves on, members are warned the code notes may be stale.
    const later = setup({ member: () => "PASS" });
    const again = later.open(room.id, { repo: r.repo, head: () => "def456" });
    again.resume();
    await again.settled();
    const prompt = later.memberCalls()[0].prompt;
    expect(prompt).toContain("Shared notes, decisions.md:\n- LRU (#3)");
    expect(prompt).toContain("written at commit abc123, but the repo is now at def456");
  });

  it("the assistant answers privately, proposes changes, and only pauses by itself", async () => {
    const r = setup({
      member: () => "PASS",
      assistant: ["They agree on an LRU (#3).\n>> add: security claude | nobody covers abuse\n>> steer: Decide the TTL first.\n>> pause: you should look at this"],
    });
    const room = r.create();
    room.resume();
    await room.settled();
    const deltas: string[] = [];
    const answer = await room.ask("where are we?", (d) => deltas.push(d));
    expect(answer).toBe("They agree on an LRU (#3).");
    expect(deltas.join("")).toContain(">> add:");
    expect(room.state).toBe("paused");
    expect(room.pending().map((p) => [p.action, p.args])).toEqual([
      ["add", ["security", "claude"]],
      ["steer", ["Decide the TTL first."]],
    ]);
    const asides = room.store.events().filter((e) => e.type === "aside");
    expect(asides.map((e) => e.type === "aside" && e.from)).toEqual(["human", "assistant"]);
    // Members never see asides or suggestions.
    expect(r.memberCalls().every((c) => !c.prompt.includes("where are we"))).toBe(true);
    expect(r.calls.find((c) => c.agent === "assistant")!.prompt).toContain("The human asks you: where are we?");

    await room.resolve(1, true);
    expect(room.store.config().agents.map((a) => a.id)).toEqual(["arch", "skeptic", "security"]);
    await room.resolve(2, false);
    expect(messages(room).some((e) => e.type === "message" && e.text === "Decide the TTL first.")).toBe(false);
  });

  it("the assistant keeps a digest and leaves a note only when something shifted", async () => {
    const r = setup({
      member: () => "PASS",
      assistant: ["DIGEST:\n- LRU agreed (#3)\nNOTE: Nobody has looked at tenants.\n>> add: security claude | tenant isolation", "DIGEST:\n- LRU agreed (#3)"],
    });
    const room = r.create();
    await room.watch("check-in");
    await room.watch("check-in");
    const asides = room.store.events().filter((e) => e.type === "aside");
    expect(asides.map((e) => e.type === "aside" && [e.kind, e.text])).toEqual([
      ["digest", "- LRU agreed (#3)"],
      ["note", "Nobody has looked at tenants."],
    ]);
    expect(room.digest()).toBe("- LRU agreed (#3)");
    expect(room.pending()).toMatchObject([{ action: "add", args: ["security", "claude"] }]);
    expect(r.calls.filter((c) => c.agent === "assistant")[1].prompt).toContain("Your current two-line status for the human:\n- LRU agreed (#3)");
  });

  it("a removed member writes an exit memo and can be brought back", async () => {
    const r = setup({ member: () => "PASS" });
    const room = r.create();
    room.store.writeNotebook("skeptic", "my notes");
    await room.removeMember("skeptic");
    expect(room.store.config().agents.map((a) => a.id)).toEqual(["arch"]);
    expect(room.store.events().at(-1)).toMatchObject({ type: "agent.left", agent: "skeptic", memo: "- skeptic memo" });
    // The notebook belongs to the member, not the channel, so it keeps the memo.
    expect(room.store.notebook("skeptic")).toBe("my notes\n\n## Left #pick-a-cache\n\n- skeptic memo\n");
    await expect(room.removeMember("skeptic")).rejects.toThrow(/no member/);

    expect(room.addMember({ persona: "skeptic", cli: "mock" })).toBe("skeptic");
    expect(room.addMember({ persona: "skeptic", cli: "mock", model: "other" })).toBe("skeptic-2");
    expect(() => room.addMember({ persona: "nope", cli: "mock" })).toThrow(/persona/);
    room.resume();
    await room.settled();
    const joined = r.memberCalls().find((c) => c.agent === "skeptic-2")!.prompt;
    expect(joined).toContain("You have just joined a discussion already under way");
  });

  it("files an issue document only when asked", async () => {
    const filed: [string, string][] = [];
    const r = setup({ member: firstTurn("arch", [["doc_draft", { name: "issue-ttl", kind: "issue", text: "# TTL too long\n\nDetails." }]]) });
    const room = r.create({
      agents: AGENTS.slice(0, 1),
      fileIssue: async (t, b) => (filed.push([t, b]), "https://github.com/x/y/issues/1"),
    });
    room.resume();
    await room.settled();
    expect(await room.exportIssue("issue-ttl")).toBe("https://github.com/x/y/issues/1");
    expect(filed).toEqual([["TTL too long", "Details."]]);
    await expect(room.exportIssue("nope")).rejects.toThrow(/no document/);
  });
});

describe("parsers and signals", () => {
  it("splits prose from action lines and keeps only known verbs", () => {
    expect(parseDirectives("Hello.\n>> focus: caching | done here\n>> nudge: bob | speak up\n>> fly: away", ["focus", "nudge"])).toEqual({
      prose: "Hello.",
      directives: [
        { verb: "focus", args: ["caching"], why: "done here" },
        { verb: "nudge", args: ["bob"], why: "speak up" },
      ],
    });
  });

  it("reads scribe file blocks", () => {
    expect(parseFileBlocks("=== docs/facts.md ===\na\n=== notes.txt ===\nb\n=== topics/x.md ===\nc")).toEqual([
      { path: "facts.md", text: "a" },
      { path: "topics/x.md", text: "c" },
    ]);
  });

  it("notices repetition, pass streaks and missing progress", () => {
    const ev = (seq: number, body: object) => ({ seq, ts: "", ...body }) as RoomEvent;
    const say = (seq: number, from: string, text: string) => ev(seq, { type: "message", from, to: "room", text });
    const events = [
      ev(1, { type: "doc.revised", slug: "plan", version: 1, kind: "plan", by: "a" }),
      say(2, "a", "we should cache product lookups with an LRU"),
      say(3, "b", "an LRU cache for product lookups makes sense"),
      say(4, "a", "agreed, cache product lookups with an LRU"),
      say(5, "human", "ok"),
      ev(6, { type: "pass", from: "a" }),
      ev(7, { type: "pass", from: "b" }),
    ];
    expect(computeSignals(events, ["a", "b"])).toEqual({ sinceProgress: 3, passStreak: 2, repetition: 0.8, repeats: 2 });
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
    expect(byId[2].result.tools.map((t: any) => t.name)).toEqual(ROOM_TOOLS.map((t) => t.name));
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
