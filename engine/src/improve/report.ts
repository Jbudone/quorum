import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../room/ledger.js";
import { Mailbox, QUORUM } from "../room/mail.js";
import type { RoomEvent } from "../room/store.js";
import { knownRooms, readCalls, stateDir, type CallRow } from "./calls.js";
import { fingerprint, PURPOSES, type Purpose } from "./purposes.js";

/**
 * How Quorum's prompts are doing, from the calls channels logged: for each prompt and each version
 * of it, how often the reply broke the prompt's own rules, failed, or was slow, and what came of it
 * (suggestions the human accepted or declined, member turns that were passes). The report names the
 * prompts that need work and shows whether a prompt edit helped. Model-free; a diagnosis by a model
 * is a separate, optional step (diagnosePrompt).
 */

type Call = CallRow & { seq?: number; room: string };

export interface Example {
  room: string;
  n: number;
  seq?: number;
  problems: string[];
  reply: string;
}

export interface VersionStats {
  version: string;
  current: boolean;
  first: number;
  last: number;
  calls: number;
  failed: number;
  offFormat: number;
  /** Problems with numbers taken out, so like ones count together: "N bullets, asked for two or three". */
  problems: [string, number][];
  medianMs: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  outcome?: string;
  examples: Example[];
}

export interface PurposeStats {
  purpose: Purpose;
  about: string;
  where: string;
  versions: VersionStats[];
}

export interface Finding {
  purpose: Purpose | "overall";
  level: "poor" | "watch" | "ok";
  text: string;
}

export interface Pushback {
  room: string;
  seq: number;
  text: string;
}

export interface Health {
  rooms: { dir: string; name: string; project: string; calls: number }[];
  calls: number;
  since?: number;
  purposes: PurposeStats[];
  findings: Finding[];
  pushback: Pushback[];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const generic = (p: string) => p.replace(/\d+/g, "N");

/** Things the human says when a reply missed: the most direct signal there is. */
const PUSHBACK =
  /\b(too (long|wordy|verbose|much)|wordy|verbose|confus\w*|not what I|that's wrong|wrong|didn't ask|shorter|more concise|unclear|cut off|makes no sense|no idea what|stop \w+ing|don't (do|say|use|keep))\b/i;

/** Interactive prompts, where the human waits on the reply. */
const INTERACTIVE = new Set<Purpose>(["card", "glossary", "assistant.ask", "persona"]);

function roomName(dir: string): { name: string; project: string } {
  let name = basename(dir);
  try {
    name = JSON.parse(readFileSync(join(dir, "room.json"), "utf8")).name ?? name;
  } catch {}
  return { name, project: basename(join(dir, "..", "..", "..")) };
}

export function analyze(dirs: string[], o: { since?: number } = {}): Health {
  const rooms: Health["rooms"] = [];
  const calls: Call[] = [];
  const pushback: Pushback[] = [];
  const outcomes = new Map<string, { sugg: number; accepted: number; declined: number; withdrawn: number }>();
  const memberOut = new Map<string, { turns: number; passes: number; messages: number; highlighted: number; answered: number }>();
  let floorTurns = 0;
  let floorPasses = 0;

  for (const dir of dirs) {
    const { name, project } = roomName(dir);
    const label = `${project}/${name}`;
    // Mock sessions (quorum --mock, tests) say nothing about real prompts.
    const mine = readCalls(dir).calls.filter((c) => c.cli !== "mock" && (!o.since || c.ts >= o.since)).map((c) => ({ ...c, room: label }));
    rooms.push({ dir, name, project, calls: mine.length });
    calls.push(...mine);
    let events: RoomEvent[] = [];
    try {
      events = readJsonl<RoomEvent>(join(dir, "events.jsonl"));
    } catch {}
    if (o.since) events = events.filter((e) => Date.parse(e.ts) >= o.since!);

    // Suggestions, credited to the assistant call that ended just before each was made.
    const asst = mine.filter((c) => c.purpose === "assistant.ask" || c.purpose === "assistant.watch").sort((a, b) => a.ts + a.ms - (b.ts + b.ms));
    const resolved = new Map(events.flatMap((e) => (e.type === "suggestion.resolved" ? [[e.id, e] as const] : [])));
    for (const e of events) {
      if (e.type !== "suggestion") continue;
      const at = Date.parse(e.ts);
      const by = [...asst].reverse().find((c) => c.ts + c.ms <= at + 50);
      if (!by) continue;
      const k = `${by.purpose} ${by.version}`;
      const t = outcomes.get(k) ?? { sugg: 0, accepted: 0, declined: 0, withdrawn: 0 };
      t.sugg++;
      const r = resolved.get(e.id);
      if (r?.withdrawn) t.withdrawn++;
      else if (r?.accepted) t.accepted++;
      else if (r) t.declined++;
      outcomes.set(k, t);
    }

    // Member turns: passes, and whether what they said mattered (highlighted, answered by the human).
    const gisted = new Set(events.flatMap((e) => (e.type === "tags" || e.type === "gists" ? e.items.filter((t) => t.gist).map((t) => t.seq) : [])));
    const answered = new Set(events.flatMap((e) => (e.type === "message" && e.from === "human" && e.replyTo ? [e.replyTo] : [])));
    for (const c of mine.filter((c) => c.purpose === "member" && !c.failed)) {
      const k = c.version;
      const t = memberOut.get(k) ?? { turns: 0, passes: 0, messages: 0, highlighted: 0, answered: 0 };
      t.turns++;
      const pass = /^\s*PASS\s*$/.test(c.reply);
      if (pass) t.passes++;
      if (c.seq) {
        t.messages++;
        if (gisted.has(c.seq)) t.highlighted++;
        if (answered.has(c.seq)) t.answered++;
      }
      memberOut.set(k, t);
      floorTurns++;
      if (pass) floorPasses++;
    }

    for (const e of events)
      if (e.type === "message" && e.from === "human" && PUSHBACK.test(e.text)) pushback.push({ room: label, seq: e.seq, text: e.text.replace(/\s+/g, " ").slice(0, 200) });
  }

  const purposes: PurposeStats[] = [];
  for (const p of Object.keys(PURPOSES) as Purpose[]) {
    const mine = calls.filter((c) => c.purpose === p);
    if (!mine.length) continue;
    const byV = new Map<string, Call[]>();
    for (const c of mine) byV.set(c.version, [...(byV.get(c.version) ?? []), c]);
    const versions: VersionStats[] = [...byV.entries()]
      .map(([version, cs]) => {
        const off = cs.filter((c) => c.problems?.length);
        const counts = new Map<string, number>();
        for (const c of off) for (const pr of new Set(c.problems!.map(generic))) counts.set(pr, (counts.get(pr) ?? 0) + 1);
        const out = outcomes.get(`${p} ${version}`);
        const mo = p === "member" ? memberOut.get(version) : undefined;
        return {
          version,
          current: version === fingerprint(p),
          first: Math.min(...cs.map((c) => c.ts)),
          last: Math.max(...cs.map((c) => c.ts)),
          calls: cs.length,
          failed: cs.filter((c) => c.failed).length,
          offFormat: off.length,
          problems: [...counts.entries()].sort((a, b) => b[1] - a[1]),
          medianMs: median(cs.filter((c) => !c.failed).map((c) => c.ms)),
          tokensIn: cs.reduce((n, c) => n + (c.in ?? 0), 0),
          tokensOut: cs.reduce((n, c) => n + (c.out ?? 0), 0),
          usd: cs.reduce((n, c) => n + (c.usd ?? 0), 0),
          ...(out
            ? { outcome: `${out.sugg} suggestions: ${out.accepted} accepted, ${out.declined} declined, ${out.withdrawn} withdrawn` }
            : mo
              ? { outcome: `${mo.turns} turns: ${mo.passes} passes; of ${mo.messages} messages, ${mo.highlighted} highlighted, ${mo.answered} answered by the human` }
              : {}),
          examples: off
            .slice(-3)
            .reverse()
            .map((c) => ({ room: c.room, n: c.n, ...(c.seq ? { seq: c.seq } : {}), problems: c.problems!, reply: c.reply.slice(0, 1500) })),
        };
      })
      .sort((a, b) => a.first - b.first);
    purposes.push({ purpose: p, about: PURPOSES[p].about, where: PURPOSES[p].where, versions });
  }

  const findings: Finding[] = [];
  const add = (purpose: Finding["purpose"], level: Finding["level"], text: string) => findings.push({ purpose, level, text });
  for (const s of purposes) {
    const v = s.versions[s.versions.length - 1];
    if (v.calls >= 5) {
      const off = v.offFormat / v.calls;
      if (off >= 0.2) {
        const top = v.problems.slice(0, 2).map(([pr, n]) => `${pr} (${n})`).join("; ");
        add(s.purpose, off >= 0.4 ? "poor" : "watch", `${v.offFormat} of ${v.calls} replies broke the prompt's rules: ${top}.`);
      }
      if (v.failed / v.calls >= 0.15) add(s.purpose, "watch", `${v.failed} of ${v.calls} calls failed.`);
      if (INTERACTIVE.has(s.purpose) && v.medianMs > 12_000) add(s.purpose, "watch", `The human waits on this, and it takes ${Math.round(v.medianMs / 1000)}s at the median.`);
    }
    // A prompt edit: compare its replies before and after.
    const prev = s.versions.length > 1 ? s.versions[s.versions.length - 2] : undefined;
    if (prev && prev.calls >= 5 && v.calls >= 5) {
      const a = pct(prev.offFormat, prev.calls);
      const b = pct(v.offFormat, v.calls);
      if (b - a >= 15) add(s.purpose, "poor", `Got worse after the prompt changed (${prev.version} → ${v.version}): off-format ${a}% → ${b}%.`);
      else if (a - b >= 15) add(s.purpose, "ok", `Improved after the prompt changed (${prev.version} → ${v.version}): off-format ${a}% → ${b}%.`);
    }
  }
  for (const [k, t] of outcomes) {
    const [purpose] = k.split(" ") as [Purpose];
    const answered = t.accepted + t.declined;
    if (answered >= 4 && t.declined / answered >= 0.5) add(purpose, "watch", `The human declined ${t.declined} of ${answered} suggestions they answered.`);
    if (t.sugg >= 6 && t.withdrawn / t.sugg >= 0.4) add(purpose, "watch", `${t.withdrawn} of ${t.sugg} suggestions were withdrawn before the human answered.`);
  }
  if (floorTurns >= 10 && floorPasses / floorTurns >= 0.35)
    add("floor", "watch", `${floorPasses} of ${floorTurns} member turns were passes: the floor woke members who had nothing to add.`);
  const support = calls.filter((c) => c.role === "support").reduce((n, c) => n + (c.in ?? 0) + (c.out ?? 0), 0);
  const all = calls.reduce((n, c) => n + (c.in ?? 0) + (c.out ?? 0), 0);
  if (all && support / all > 0.5) add("overall", "watch", `Support prompts used ${pct(support, all)}% of all tokens, more than the members.`);
  const rank = { poor: 0, watch: 1, ok: 2 };
  findings.sort((a, b) => rank[a.level] - rank[b.level]);

  return { rooms, calls: calls.length, ...(calls.length ? { since: Math.min(...calls.map((c) => c.ts)) } : {}), purposes, findings, pushback: pushback.slice(-12) };
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

export function formatHealth(h: Health, o: { title?: string; examples?: boolean } = {}): string {
  if (!h.calls) return `# ${o.title ?? "Prompt health"}\n\nNo calls logged yet. Each channel logs its model calls from now on; come back after it has run a while.`;
  const mark = { poor: "✗", watch: "!", ok: "✓" };
  const projects = [...new Set(h.rooms.filter((r) => r.calls).map((r) => r.project))];
  const out = [
    `# ${o.title ?? "Prompt health"}`,
    "",
    `${h.calls} calls in ${h.rooms.filter((r) => r.calls).length} channels (${projects.join(", ")}) since ${day(h.since!)}. A version is a fingerprint of the code that writes that prompt, so it changes only when the prompt is edited.`,
    "",
    "## Findings",
    "",
    ...(h.findings.length ? h.findings.map((f) => `- ${mark[f.level]} **${f.purpose}:** ${f.text}${f.purpose !== "overall" && f.level !== "ok" ? ` Edit: \`${PURPOSES[f.purpose].where}\`.` : ""}`) : ["- ✓ Nothing stands out."]),
    "",
    "## By prompt",
    "",
    "| prompt | version | calls | failed | off-format | median | tokens in/out |",
    "|---|---|---|---|---|---|---|",
    ...h.purposes.flatMap((s) =>
      s.versions.map(
        (v, i) =>
          `| ${i === s.versions.length - 1 ? `**${s.purpose}**` : s.purpose} | ${v.version}${v.current ? " (now)" : ""} | ${v.calls} | ${v.failed} | ${v.offFormat ? `${pct(v.offFormat, v.calls)}%` : "–"} | ${(v.medianMs / 1000).toFixed(1)}s | ${k(v.tokensIn)} / ${k(v.tokensOut)} |`,
      ),
    ),
    "",
  ];
  const outcomes = h.purposes.flatMap((s) => s.versions.filter((v) => v.outcome).map((v) => `- **${s.purpose}** ${v.version}: ${v.outcome}.`));
  if (outcomes.length) out.push("## What came of it", "", ...outcomes, "");
  if (h.pushback.length) out.push("## Where you pushed back", "", ...h.pushback.map((p) => `- ${p.room} #${p.seq}: “${p.text}”`), "");
  if (o.examples) {
    const bad = h.purposes.filter((s) => s.versions[s.versions.length - 1].examples.length);
    if (bad.length) {
      out.push("## Examples of replies that broke the rules", "");
      for (const s of bad) {
        const e = s.versions[s.versions.length - 1].examples[0];
        out.push(`**${s.purpose}** (${e.room}, call ${e.n}${e.seq ? `, #${e.seq}` : ""}): ${e.problems.join("; ")}`, "", "```", e.reply.slice(0, 700), "```", "");
      }
    }
  }
  return out.join("\n").trimEnd();
}

/** Where the Quorum source is: this file is engine/src/improve/report.ts. */
export const quorumRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Asks a model to diagnose the prompts that need work and propose edits. It's run from Quorum's
 * source folder, so it can read the prompt code itself.
 */
export function diagnosePrompt(h: Health): string | undefined {
  const bad = h.findings.filter((f) => f.level !== "ok" && f.purpose !== "overall");
  if (!bad.length) return undefined;
  const parts = [...new Set(bad.map((f) => f.purpose as Purpose))].slice(0, 4).map((p) => {
    const s = h.purposes.find((x) => x.purpose === p);
    const v = s?.versions[s.versions.length - 1];
    const ex = (v?.examples ?? []).slice(0, 2).map((e) => `Reply (${e.problems.join("; ")}):\n${e.reply.slice(0, 1200)}`);
    return [`## ${p}: ${PURPOSES[p].about}`, `Prompt code: ${PURPOSES[p].where}`, ...bad.filter((f) => f.purpose === p).map((f) => `- ${f.text}`), v?.outcome ? `Outcome: ${v.outcome}` : "", ...ex].filter(Boolean).join("\n\n");
  });
  return [
    `You're improving the prompts of Quorum, the program in this folder: a channel where AI members discuss a problem with a human, supported by prompts for a floor, a scribe, a Chair and an assistant. Its call log flagged these prompts. Read each one's code where given before you judge it.`,
    parts.join("\n\n"),
    h.pushback.length ? `What the human said when replies missed:\n${h.pushback.map((p) => `- "${p.text}"`).join("\n")}` : "",
    `For each prompt: say in one or two sentences why the replies miss (a rule that's buried, conflicting, vague, or asks for something the model can't see), then give the edit as a short unified diff against the file. Prefer moving or sharpening a rule over adding more text. If the check itself looks wrong rather than the prompt, say so (the checks are in engine/src/improve/purposes.ts). Don't edit any files.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const lastPath = () => join(stateDir(), "improve", "last.json");

/**
 * Writes a fresh report about once a day, after channels have made enough new calls, and mails
 * Quorum's developers (Quorum's own .quorum/mail, which is never committed) when a prompt newly
 * needs work. Model-free, so it costs nothing. Returns the report's path when it wrote one.
 */
export function autoReport(o: { now?: number; minCalls?: number; everyMs?: number; root?: string; rooms?: string[] } = {}): string | undefined {
  const now = o.now ?? Date.now();
  let last: { ts: number; calls: number; flagged: string[] } = { ts: 0, calls: 0, flagged: [] };
  try {
    last = { ...last, ...JSON.parse(readFileSync(lastPath(), "utf8")) };
  } catch {}
  if (now - last.ts < (o.everyMs ?? 20 * 3600_000)) return undefined;
  const h = analyze(o.rooms ?? knownRooms());
  if (h.calls - last.calls < (o.minCalls ?? 30)) return undefined;
  const text = formatHealth(h, { title: `Prompt health, ${day(now)}`, examples: true });
  const dir = join(stateDir(), "improve");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day(now)}.md`);
  writeFileSync(file, text + "\n");
  const flagged = h.findings.filter((f) => f.level !== "ok").map((f) => `${f.purpose}: ${f.text.replace(/\d+/g, "N")}`);
  const fresh = h.findings.filter((f) => f.level !== "ok" && !last.flagged.includes(`${f.purpose}: ${f.text.replace(/\d+/g, "N")}`));
  const root = o.root ?? quorumRoot();
  if (fresh.length && existsSync(join(root, "engine", "src", "improve"))) {
    try {
      new Mailbox(root).send({
        to: "all",
        from: QUORUM,
        subject: `Prompt health: ${fresh.length} prompt${fresh.length > 1 ? "s" : ""} need${fresh.length > 1 ? "" : "s"} work`,
        body: [
          `Quorum's call log flagged these since the last report:`,
          "",
          ...fresh.map((f) => `- **${f.purpose}:** ${f.text}${f.purpose !== "overall" ? ` Edit: \`${PURPOSES[f.purpose].where}\`.` : ""}`),
          "",
          `Full report: ${file}. \`pnpm improve --diagnose\` asks a model for edits.`,
        ].join("\n"),
      });
    } catch {}
  }
  writeFileSync(lastPath(), JSON.stringify({ ts: now, calls: h.calls, flagged }));
  return file;
}
