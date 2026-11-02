// Grades channels from their logs: evidence, probes, document lag, seat overlap, support load, cost.
// Usage: pnpm grade <room dir> [<room dir>...] [--json]
// A room dir is .quorum/rooms/<id> in any project. Nothing is written; the rooms can be live.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { formatGrade, gradeRoom } from "../engine/src/room/grade.js";
import { readJsonl, type UsageRow } from "../engine/src/room/ledger.js";
import type { RoomEvent } from "../engine/src/room/store.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const dirs = args.filter((a) => a !== "--json");
if (!dirs.length) {
  console.error("usage: grade-room.ts <room dir> [<room dir>...] [--json]");
  process.exit(2);
}

const out = dirs.map((d) => {
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), d);
  if (!existsSync(join(dir, "events.jsonl"))) throw new Error(`${dir} has no events.jsonl`);
  const events = readJsonl<RoomEvent>(join(dir, "events.jsonl"));
  const usage = readJsonl<UsageRow>(join(dir, "usage.jsonl"));
  let name = basename(dir);
  try {
    name = JSON.parse(readFileSync(join(dir, "room.json"), "utf8")).name ?? name;
  } catch {}
  // Roles live in the project's workspace (two levels up from the room).
  let roles: Record<string, string> | undefined;
  try {
    const ws = JSON.parse(readFileSync(join(dir, "..", "..", "workspace.json"), "utf8"));
    roles = Object.fromEntries((ws.members ?? []).filter((m: { role?: string }) => m.role).map((m: { id: string; role: string }) => [m.id, m.role]));
  } catch {}
  return { name, dir, grade: gradeRoom(events, usage, { roles }) };
});

if (json) console.log(JSON.stringify(out, null, 2));
else console.log(out.map((o) => formatGrade(o.name, o.grade)).join("\n\n"));
