// Keeps every conversation about and inside Quorum, raw and complete, so a channel can review it.
// Usage: pnpm history:sync [--project <repo>]... [--quiet]
//
// What it collects:
//   - Claude Code sessions run in this repo (its development), subagent transcripts and spilled
//     tool results included
//   - every project Quorum ran in: its whole .quorum/ (rooms' events.jsonl, council sessions, mail)
//   - members' and support roles' own vendor transcripts: Claude and Codex runs in Quorum's neutral
//     cwd, opencode sessions run as the `quorum` agent
//
// Raw copies go to ${XDG_DATA_HOME:-~/.local/share}/quorum/history/raw/, outside every repo, because
// transcripts hold whatever went through a terminal (keys included). A file is only ever added to:
// when a source grows it's copied again, and when one changes any other way the old copy is kept
// beside it as `<name>.superseded-<time>`. Nothing is deleted, summarized or compacted.
//
// Readable copies go to <this repo>/.quorum/history/: every human and assistant message verbatim,
// one line per tool call and result with a pointer into the raw file, likely secrets redacted. A
// channel's members read those (they can't read the raw store, and it's not in any repo).
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DATA = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "quorum");
const RAW = join(DATA, "history", "raw");
const OUT = join(REPO, ".quorum", "history");
const PROJECTS = join(DATA, "projects.txt");
const NEUTRAL_CWD = join(tmpdir(), "quorum-agent-cwd");
const CLAUDE = join(homedir(), ".claude", "projects");
const CODEX = join(homedir(), ".codex", "sessions");
const OPENCODE = join(homedir(), ".local", "share", "opencode", "opencode.db");

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const say = (s: string) => quiet || console.log(s);

/** Claude Code's folder name for a working directory. */
const claudeSlug = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, "-");

const ls = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

function walk(dir: string, skip: (p: string) => boolean = () => false): string[] {
  return ls(dir).flatMap((n) => {
    const p = join(dir, n);
    if (skip(p)) return [];
    return statSync(p).isDirectory() ? walk(p, skip) : [p];
  });
}

const stats = { added: 0, grown: 0, superseded: 0, same: 0, rendered: 0 };

/** Copies `src` to `dest` without ever losing what `dest` held. Returns whether anything changed. */
function keep(src: string | Buffer, dest: string): boolean {
  const next = typeof src === "string" ? readFileSync(src) : src;
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) {
    writeFileSync(dest, next);
    stats.added++;
    return true;
  }
  const prev = readFileSync(dest);
  if (prev.equals(next)) {
    stats.same++;
    return false;
  }
  if (next.length > prev.length && next.subarray(0, prev.length).equals(prev)) stats.grown++;
  else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dot = basename(dest).indexOf(".");
    const name = dot > 0 ? `${basename(dest).slice(0, dot)}.superseded-${stamp}${basename(dest).slice(dot)}` : `${basename(dest)}.superseded-${stamp}`;
    renameSync(dest, join(dirname(dest), name));
    stats.superseded++;
  }
  writeFileSync(dest, next);
  return true;
}

// ---- redaction (readable copies only) ----

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g, "[redacted key]"],
  [/\bapikey_[A-Za-z0-9_]{20,}/g, "[redacted key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[redacted token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted token]"],
  [/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, "[redacted jwt]"],
  [/((?:api[_-]?key|secret|token|password|passwd|bearer|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[A-Za-z0-9_\-./+=]{16,}/gi, "$1[redacted]"],
];
const redact = (s: string) => SECRETS.reduce((t, [re, to]) => t.replace(re, to), s);

// ---- rendering ----

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;
const oneLine = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const lines = (s: string) => (s ? s.split("\n").length : 0);
const asText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b === "string" ? b : (b?.text ?? (b?.type ? `[${b.type}]` : "")))).join("\n") : c == null ? "" : JSON.stringify(c);
const when = (ts?: string | number) => (ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "");

interface Rendered {
  title: string;
  started?: string;
  ended?: string;
  body: string[];
}

function writeRendered(dest: string, r: Rendered, raw: string, kind: string) {
  const head = [
    `# ${r.title}`,
    "",
    `- kind: ${kind}`,
    `- raw: \`${raw}\` (line numbers below as L<n>)`,
    ...(r.started ? [`- from ${r.started} to ${r.ended ?? r.started}`] : []),
    "",
    "---",
    "",
  ];
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, redact([...head, ...r.body].join("\n")));
  stats.rendered++;
}

/** A Claude Code transcript: the human, the assistant, one line per tool call and result. */
function renderClaude(file: string): Rendered {
  const body: string[] = [];
  let title = "";
  let firstPrompt = "";
  let started: string | undefined;
  let ended: string | undefined;
  const tools = new Map<string, string>();
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      const L = `L${i + 1}`;
      const ts = j.timestamp as string | undefined;
      if (ts) {
        started ??= when(ts);
        ended = when(ts);
      }
      const side = j.isSidechain ? " (subagent)" : "";
      if (j.type === "ai-title") title = j.aiTitle;
      else if (j.type === "queue-operation" && j.operation === "enqueue" && j.content && !body.length) {
        // Headless runs (Quorum's members) get their prompt this way.
        firstPrompt ||= j.content;
      } else if (j.type === "attachment" && j.attachment?.type === "queued_command" && j.attachment.prompt) {
        const p = String(j.attachment.prompt);
        if (p.startsWith("<task-notification>")) body.push(`> background task finished (${L})`, "");
        else body.push(`## human, while the assistant worked${side} · ${when(ts)} · ${L}`, "", p, "");
      } else if (j.type === "user") {
        const c = j.message?.content;
        if (typeof c === "string") {
          if (j.isCompactSummary) {
            body.push(`---`, "", `**Context compacted here** (${L}). The summary the assistant continued from:`, "", "<details><summary>summary</summary>", "", c, "", "</details>", "");
            return;
          }
          const text = c.replace(REMINDER, "").trim();
          const cmd = /<command-name>([^<]*)<\/command-name>[\s\S]*?<command-args>([^<]*)<\/command-args>/.exec(text);
          const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
          if (cmd) body.push(`> human ran \`${cmd[1]}${cmd[2] ? ` ${cmd[2]}` : ""}\` (${L})`, "");
          else if (out) body.push(`> → ${oneLine(out[1], 300)}`, "");
          else if (j.isMeta) return;
          else if (text) {
            firstPrompt ||= text;
            body.push(`## human${side} · ${when(ts)} · ${L}`, "", text, "");
          }
        } else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === "tool_result") {
              const t = asText(b.content).replace(REMINDER, "");
              const name = tools.get(b.tool_use_id) ?? "tool";
              body.push(`> ↳ ${name} ${b.is_error ? `failed: ${oneLine(t, 240)}` : `${lines(t)} lines`} (${L})`, "");
            } else if (b.type === "text") {
              const t = String(b.text).replace(REMINDER, "").trim();
              if (t) body.push(`## human${side} · ${when(ts)} · ${L}`, "", t, "");
            } else if (b.type === "image") body.push(`> human pasted an image (${L})`, "");
          }
        }
      } else if (j.type === "assistant") {
        for (const b of j.message?.content ?? []) {
          if (b.type === "text" && b.text?.trim()) body.push(`## assistant${side} · ${when(ts)} · ${L}`, "", b.text.trim(), "");
          else if (b.type === "thinking" && b.thinking?.trim()) body.push("<details><summary>thinking</summary>", "", b.thinking.trim(), "", "</details>", "");
          else if (b.type === "tool_use") {
            tools.set(b.id, b.name);
            const inp = b.input ?? {};
            const what = inp.description ? `${inp.description} — \`${oneLine(String(inp.command ?? ""), 200)}\`` : oneLine(typeof inp.command === "string" ? inp.command : (inp.file_path ?? inp.pattern ?? inp.prompt ?? JSON.stringify(inp)), 200);
            body.push(`> 🔧 ${b.name}: ${what} (${L})`);
          }
        }
      } else if (j.type === "system" && j.subtype === "compact_boundary") body.push(`---`, "", `**Context compacted here** (${L})`, "");
    });
  if (!title) title = oneLine(firstPrompt, 80) || basename(file);
  if (firstPrompt && !body.some((l) => l.startsWith("## human"))) body.unshift(`## prompt`, "", firstPrompt, "");
  return { title, started, ended, body };
}

/** A Codex rollout. */
function renderCodex(file: string): Rendered {
  const body: string[] = [];
  let title = "";
  let started: string | undefined;
  let ended: string | undefined;
  const tools = new Map<string, string>();
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      const L = `L${i + 1}`;
      if (j.timestamp) {
        started ??= when(j.timestamp);
        ended = when(j.timestamp);
      }
      const p = j.payload ?? {};
      if (j.type === "compacted" || p.type === "context_compacted") body.push("---", "", `**Context compacted here** (${L})`, "");
      if (j.type !== "response_item") return;
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const t = asText(p.content).trim();
        if (!t || t.startsWith("<environment_context>") || t.startsWith("<user_instructions>")) return;
        if (p.role === "user") title ||= oneLine(t, 80);
        body.push(`## ${p.role === "user" ? "prompt" : "assistant"} · ${when(j.timestamp)} · ${L}`, "", t, "");
      } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        tools.set(p.call_id, p.name ?? "shell");
        body.push(`> 🔧 ${p.name ?? "shell"}: ${oneLine(String(p.input ?? p.arguments ?? JSON.stringify(p.action ?? {})), 200)} (${L})`);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const t = asText(p.output);
        body.push(`> ↳ ${tools.get(p.call_id) ?? "tool"} ${lines(t)} lines (${L})`, "");
      } else if (p.type === "reasoning" && Array.isArray(p.summary) && p.summary.length) {
        body.push("<details><summary>reasoning</summary>", "", asText(p.summary), "", "</details>", "");
      }
    });
  return { title: title || basename(file), started, ended, body };
}

/** An opencode session, from the rows the raw copy keeps. */
function renderOpencode(dump: { session: any; messages: any[] }): Rendered {
  const body: string[] = [];
  let title = dump.session.title ?? "";
  dump.messages.forEach((m, i) => {
    let d: any;
    try {
      d = JSON.parse(m.data);
    } catch {
      return;
    }
    const L = `messages[${i}]`;
    const ts = when(d.time?.created);
    if (m.type === "user") {
      title ||= oneLine(d.text ?? "", 80);
      body.push(`## prompt · ${ts} · ${L}`, "", d.text ?? "", "");
    } else if (m.type === "assistant") {
      for (const c of d.content ?? []) {
        if (c.type === "text" && c.text?.trim()) body.push(`## assistant (${d.model?.id ?? "?"}) · ${ts} · ${L}`, "", c.text.trim(), "");
        else if (c.type === "reasoning" && c.text?.trim()) body.push("<details><summary>reasoning</summary>", "", c.text.trim(), "", "</details>", "");
        else if (c.type === "tool") {
          const out = asText(c.state?.content);
          body.push(`> 🔧 ${c.name}: ${oneLine(JSON.stringify(c.state?.input ?? {}), 200)} → ${c.state?.status ?? "?"}, ${lines(out)} lines (${L})`);
        }
      }
    } else if (m.type === "synthetic" || m.type === "system") body.push(`> ${m.type}: ${oneLine(d.text ?? "", 200)} (${L})`, "");
  });
  return { title: title || dump.session.id, started: when(dump.session.time_created), ended: when(dump.session.time_updated), body };
}

/** A Quorum channel's log, as the human would have read it (asides and floor notes included). */
function renderRoom(eventsFile: string): Rendered {
  const body: string[] = [];
  let title = "";
  try {
    const cfg = JSON.parse(readFileSync(join(dirname(eventsFile), "room.json"), "utf8"));
    title = `Channel ${cfg.name || cfg.id}: ${oneLine(cfg.topic ?? "", 80)}`;
  } catch {}
  let started: string | undefined;
  let ended: string | undefined;
  readFileSync(eventsFile, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      started ??= when(e.ts);
      ended = when(e.ts);
      const at = `#${e.seq} · ${when(e.ts)}`;
      switch (e.type) {
        case "message":
          body.push(`## ${e.from} → ${e.to}${e.thread && e.thread !== e.seq ? ` (thread #${e.thread})` : ""} · ${at}`, "", e.text, "");
          break;
        case "aside":
          body.push(`## ${e.from} (aside${e.kind ? `, ${e.kind}` : ""}) · ${at}`, "", e.text, "");
          break;
        case "floor":
          body.push(`> floor: ${e.picks.length ? e.picks.map((p: any) => `${p.agent} (${oneLine(p.why, 100)})`).join("; ") : "nobody"} (${at})`, "");
          break;
        case "tags":
          break;
        case "suggestion":
          body.push(`> suggestion ${e.id} from ${e.from}: ${e.action} ${e.args.join(" | ")} — ${e.why} (${at})`, "");
          break;
        case "suggestion.resolved":
          body.push(`> suggestion ${e.id} ${e.withdrawn ? "withdrawn" : e.accepted ? "approved" : "declined"} (${at})`, "");
          break;
        case "thread.summary":
          body.push(`## thread #${e.thread} outcome · ${at}`, "", e.text, "");
          break;
        default: {
          const { seq, ts, type, ...rest } = e;
          body.push(`> ${type}: ${oneLine(JSON.stringify(rest), 240)} (${at})`, "");
        }
      }
    });
  return { title: title || basename(dirname(eventsFile)), started, ended, body };
}

// ---- sources ----

function projects(): string[] {
  const known = existsSync(PROJECTS) ? readFileSync(PROJECTS, "utf8").split("\n").filter(Boolean) : [];
  const given: string[] = [];
  args.forEach((a, i) => a === "--project" && args[i + 1] && given.push(resolve(process.env.INIT_CWD ?? process.cwd(), args[i + 1])));
  const all = [...new Set([REPO, ...known, ...given])];
  const added = all.filter((p) => !known.includes(p));
  if (added.length) {
    mkdirSync(DATA, { recursive: true });
    appendFileSync(PROJECTS, added.map((p) => `${p}\n`).join(""));
  }
  return all.filter((p) => existsSync(p));
}

const index: { kind: string; title: string; file: string; started?: string; ended?: string }[] = [];
function record(kind: string, r: Rendered, out: string) {
  index.push({ kind, title: r.title, file: relative(OUT, out), started: r.started, ended: r.ended });
}

/** Claude Code sessions in this repo and its subfolders: Quorum's own development. */
function devSessions() {
  const slug = claudeSlug(REPO);
  for (const d of ls(CLAUDE).filter((n) => n === slug || n.startsWith(`${slug}-`))) {
    const sub = d === slug ? "" : d.slice(slug.length + 1);
    for (const f of walk(join(CLAUDE, d), (p) => basename(p) === "memory")) {
      const rel = relative(join(CLAUDE, d), f);
      const raw = join(RAW, "claude-code", d, rel);
      const changed = keep(f, raw);
      if (!f.endsWith(".jsonl")) continue;
      const out = join(OUT, "development", sub, rel.replace(/\.jsonl$/, ".md"));
      const r = renderClaude(raw);
      if (changed || !existsSync(out)) writeRendered(out, r, raw, `Claude Code session${sub ? ` in ${sub}/` : ""}`);
      record(`development${rel.includes("/") ? " (subagent)" : ""}`, r, out);
    }
  }
}

/** Who each vendor session belonged to, from every project's vendor-sessions.jsonl. */
function attribution(repos: string[]): Map<string, { project: string; room?: string; agent: string; model?: string }> {
  const m = new Map();
  for (const repo of repos) {
    const f = join(repo, ".quorum", "vendor-sessions.jsonl");
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      try {
        const s = JSON.parse(l);
        m.set(s.session, { project: basename(repo), room: s.room, agent: s.agent, model: s.model });
      } catch {}
    }
  }
  return m;
}

/**
 * Where a member's transcript goes: under its project and channel (or the planning chat before a
 * channel existed), in a folder per member. Sessions from before Quorum logged them can't be placed.
 */
function memberOut(who: ReturnType<typeof attribution>, id: string, cli: string): string {
  const w = who.get(id);
  if (!w) return join(OUT, "unplaced", cli, `${id}.md`);
  const where = w.room ? join("rooms", w.room) : "planning";
  // A side thread runs as `<member>@t<seq>`; it belongs in that member's folder.
  const [agent, thread] = w.agent.split("@t");
  return join(OUT, "projects", w.project, where, agent, `${thread ? `thread-${thread}-` : ""}${cli}-${id}.md`);
}

function memberSessions(who: ReturnType<typeof attribution>) {
  const label = (id: string, cli: string) => {
    const w = who.get(id);
    return w ? `${cli} session of ${w.agent} in ${w.project}${w.room ? ` (${w.room})` : ""}${w.model ? `, ${w.model}` : ""}` : `${cli} session run by Quorum (before sessions were logged)`;
  };
  // Claude: Quorum runs every Claude agent in its neutral cwd, so everything there is Quorum's.
  const cdir = join(CLAUDE, claudeSlug(NEUTRAL_CWD));
  for (const f of walk(cdir)) {
    const rel = relative(cdir, f);
    const raw = join(RAW, "members", "claude", rel);
    const changed = keep(f, raw);
    if (!f.endsWith(".jsonl")) continue;
    const out = memberOut(who, basename(f, ".jsonl"), "claude");
    const r = renderClaude(raw);
    if (changed || !existsSync(out)) writeRendered(out, r, raw, label(basename(f, ".jsonl"), "Claude"));
    record("member (claude)", r, out);
  }
  // Codex: rollouts whose cwd is the neutral cwd, or whose id Quorum logged.
  for (const f of walk(CODEX).filter((p) => p.endsWith(".jsonl"))) {
    let meta: any = {};
    try {
      meta = JSON.parse(readFileSync(f, "utf8").split("\n", 1)[0]).payload ?? {};
    } catch {}
    const id = meta.id ?? meta.session_id ?? "";
    if (meta.cwd !== NEUTRAL_CWD && !who.has(id)) continue;
    const raw = join(RAW, "members", "codex", basename(f));
    const changed = keep(f, raw);
    const out = memberOut(who, id, "codex");
    const r = renderCodex(raw);
    if (changed || !existsSync(out)) writeRendered(out, r, raw, label(id, "Codex"));
    record("member (codex)", r, out);
  }
  // opencode: sessions run as Quorum's `quorum` agent, or whose id Quorum logged.
  if (!existsSync(OPENCODE)) return;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(OPENCODE, { readOnly: true });
  } catch (e) {
    say(`opencode: can't open its database (${e instanceof Error ? e.message : e})`);
    return;
  }
  for (const s of db.prepare("select * from session_v2 order by time_created").all() as any[]) {
    if (s.agent !== "quorum" && !who.has(s.id)) continue;
    const messages = db.prepare("select type, seq, time_created, data from session_message where session_id = ? order by seq").all(s.id) as any[];
    const dump = { session: { ...s }, messages: messages.map((m) => ({ ...m })) };
    const raw = join(RAW, "members", "opencode", `${s.id}.json`);
    const changed = keep(Buffer.from(`${JSON.stringify(dump, null, 1)}\n`), raw);
    const out = memberOut(who, s.id, "opencode");
    const r = renderOpencode(dump);
    if (changed || !existsSync(out)) writeRendered(out, r, raw, label(s.id, "opencode"));
    record("member (opencode)", r, out);
  }
  db.close();
}

/** Each project's whole .quorum/, raw, and its channels rendered. */
function quorumData(repos: string[]) {
  for (const repo of repos) {
    const q = join(repo, ".quorum");
    const name = basename(repo);
    for (const f of walk(q, (p) => p === OUT || basename(p) === "attachments")) {
      const rel = relative(q, f);
      const raw = join(RAW, "projects", name, rel);
      const changed = keep(f, raw);
      if (!/^rooms\/[^/]+\/events\.jsonl$/.test(rel)) continue;
      const out = join(OUT, "projects", name, "rooms", rel.split("/")[1], "channel.md");
      const r = renderRoom(raw);
      if (changed || !existsSync(out)) writeRendered(out, r, raw, `Quorum channel in ${name}`);
      record(`channel (${name})`, r, out);
    }
  }
}

function writeIndex(repos: string[]) {
  index.sort((a, b) => (a.started ?? "").localeCompare(b.started ?? ""));
  const rows = index.map((e) => `| ${e.started ?? ""} | ${e.kind} | [${e.title.replace(/\|/g, "\\|")}](${e.file}) |`);
  writeFileSync(
    join(OUT, "README.md"),
    [
      "# Quorum's conversation history",
      "",
      "Everything said while building Quorum and while using it, for reviewing what to improve. Written by `scripts/history-sync.ts`; don't edit.",
      "",
      "- `development/`: Claude Code sessions in which Quorum was built. The human's messages are the best evidence of friction: requests repeated, corrections, things that surprised them.",
      "- `projects/<project>/rooms/<channel>/channel.md`: a Quorum channel as it ran, assistant asides and floor decisions included.",
      "- `projects/<project>/rooms/<channel>/<member>/<cli>-<session>.md`: what that member (or support role) saw and did inside its own CLI.",
      "- `projects/<project>/planning/<member>/`: the planning assistant before a channel existed.",
      "- `unplaced/<cli>/`: member sessions from before Quorum recorded whose they were.",
      "",
      "Messages are verbatim. Tool calls and results are one line each; `L<n>` points into the raw transcript. Likely secrets are redacted. Context compactions are marked where they happened.",
      "",
      `Projects: ${repos.map((r) => `\`${r}\``).join(", ")}. Last synced ${new Date().toISOString()}.`,
      "",
      "| started | kind | conversation |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
}

const repos = projects();
mkdirSync(OUT, { recursive: true });
// The readable copies are regenerated from raw each run; clear the flat layout older syncs wrote.
for (const old of ["channels", "members", "projects", "unplaced"]) rmSync(join(OUT, old), { recursive: true, force: true });
devSessions();
memberSessions(attribution(repos));
quorumData(repos);
writeIndex(repos);
say(`history: ${stats.added} new, ${stats.grown} grown, ${stats.superseded} superseded, ${stats.same} unchanged raw files; ${stats.rendered} rendered; ${index.length} conversations`);
say(`raw: ${RAW}`);
say(`readable: ${OUT}`);
