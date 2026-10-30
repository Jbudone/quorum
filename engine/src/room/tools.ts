import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerSpec } from "../transports/types.js";

/** A tool as MCP lists it. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tools room members speak through. The bridge fetches these, so this is the only copy. */
export const ROOM_TOOLS: ToolDef[] = [
  {
    name: "post",
    description:
      "Say something to the whole room. Use reply_to with a message number (#N) when answering one message. Set topic only to file a short note under a parked topic; leave it out to speak on the topic in focus.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        reply_to: { type: "integer", description: "message number you answer" },
        topic: { type: "string", description: "slug of a parked topic this note belongs to" },
      },
      required: ["text"],
    },
  },
  {
    name: "dm",
    description: "Send a private message to one member (or 'human'). The human's assistant can still read it.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" } },
      required: ["to", "text"],
    },
  },
  {
    name: "pass",
    description: "Say nothing this turn because you have nothing new to add. Wakes nobody.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "raise_topic",
    description: "Propose a new question that deserves its own discussion. It starts parked; the Chair and the human decide when it gets focus.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, why: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "doc_draft",
    description:
      "Write or revise a document the room is producing (a plan, an issue, a decision record). Each call saves a new full version; the Chair accepts a version once the room agrees.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "short name, e.g. 'plan' or 'issue-login-timeout'" },
        text: { type: "string", description: "the whole document in markdown" },
        kind: { type: "string", enum: ["plan", "issue", "decision", "other"] },
        note: { type: "string", description: "what changed in this version" },
      },
      required: ["name", "text"],
    },
  },
  {
    name: "read_doc",
    description: "Read a room document (latest version) or a shared note kept by the scribe (decisions, facts, open-questions, code-notes, topics/<slug>). Call with no name to list them.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "notebook_read",
    description: "Read your private notebook. Only you see it, and it persists across turns and restarts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notebook_write",
    description: "Replace your private notebook with new contents: your working notes, positions and things to check.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "read_room",
    description: "Read earlier messages you can see, newest last. Use before to page back past a message number.",
    inputSchema: {
      type: "object",
      properties: { before: { type: "integer" }, limit: { type: "integer", description: "1-50, default 20" } },
    },
  },
];

/** Bridge script every CLI launches as a stdio MCP server; it forwards calls to the ToolServer. */
export const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "quorum-room-mcp.mjs");

export type ToolHandler = (token: string, name: string, args: Record<string, unknown>) => string;

/**
 * Localhost endpoint behind the MCP bridge. Each turn gets a fresh token that names its agent, so a
 * member can only speak as itself and only while its turn is running.
 */
export class ToolServer {
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(handle: ToolHandler): Promise<ToolServer> {
    const server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/tools") return reply(200, { tools: ROOM_TOOLS });
      if (req.method !== "POST" || req.url !== "/call") return reply(404, { error: "not found" });
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const { name, arguments: args } = JSON.parse(raw);
          const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
          reply(200, { text: handle(token, String(name), args ?? {}) });
        } catch (e) {
          reply(200, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // Never keep the process alive just for this.
    server.unref();
    const { port } = server.address() as { port: number };
    return new ToolServer(server, `http://127.0.0.1:${port}`);
  }

  /** The MCP server a CLI should launch for a turn holding `token`. */
  spec(token: string): McpServerSpec {
    return {
      name: "quorum",
      command: process.execPath,
      args: [BRIDGE],
      env: { QUORUM_ROOM_URL: this.url, QUORUM_ROOM_TOKEN: token },
    };
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export const newToken = (): string => randomBytes(18).toString("base64url");
