#!/usr/bin/env node
// Stdio MCP server that agent CLIs launch for a Quorum room turn. It holds no state: tool listings
// and calls are forwarded to the engine at QUORUM_ROOM_URL with the turn's QUORUM_ROOM_TOKEN.
// Plain JavaScript with no dependencies, so any CLI can start it with just `node`.
import { createInterface } from "node:readline";

const url = process.env.QUORUM_ROOM_URL;
const token = process.env.QUORUM_ROOM_TOKEN;
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

async function engine(path, body) {
  const res = await fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  return res.json();
}

async function handle(req) {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "quorum", version: "0.1.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: (await engine("/tools")).tools };
    case "tools/call": {
      const r = await engine("/call", { name: req.params?.name, arguments: req.params?.arguments ?? {} });
      return r.error
        ? { content: [{ type: "text", text: r.error }], isError: true }
        : { content: [{ type: "text", text: r.text }] };
    }
    default:
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notifications need no answer
  try {
    send({ id: req.id, result: await handle(req) });
  } catch (e) {
    send({ id: req.id, error: { code: e.code ?? -32000, message: e.message } });
  }
});
