import type { UsageRow } from "./ledger.js";
import { docLags, overlap, PROBE, words } from "./signals.js";
import type { RoomEvent } from "./store.js";

/**
 * Grades a finished (or paused) channel from its log: how much of the members' talk was new, how
 * well the documents kept up with the discussion, whether claims met evidence, and what it cost.
 * Model-free and repeatable, so two channels (or one channel before and after an engine change) can
 * be compared on the same scale. Thresholds are rough rules of thumb, not calibrated scores.
 */

export type Level = "ok" | "watch" | "poor";

export interface Finding {
  area: string;
  level: Level;
  text: string;
}

export interface MemberLine {
  id: string;
  messages: number;
  passes: number;
  /** Share of the member's messages that mostly repeat what other members said just before. */
  echo: number;
}

export interface Grade {
  events: number;
  members: MemberLine[];
  counts: {
    memberMessages: number;
    humanMessages: number;
    supportMessages: number;
    asides: number;
    passes: number;
    failed: number;
    aborted: number;
    suggestions: number;
    accepted: number;
    declined: number;
    withdrawn: number;
    pending: number;
    seatChanges: number;
    steers: number;
    evidence: number;
    decisions: number;
    questions: number;
    openQuestions: number;
    probeTalk: number;
    mailDrafted: number;
    mailSent: number;
    mailReplies: number;
    docVersions: number;
    docsAccepted: number;
    docsExported: number;
  };
  /** Most similar member pairs by vocabulary: high overlap means two seats did the same job. */
  pairs: { a: string; b: string; overlap: number }[];
  /** Jobs held by more than one seat. */
  sharedRoles: { role: string; ids: string[] }[];
  /** Longest run of member messages with no evidence in it. */
  longestDry: number;
  lag: { slug: string; version: number; messages: number; decisions: number }[];
  cost?: { listUsd: number; memberShare: number; meteredTurns: number; memberTurns: number; perAcceptedDoc?: number };
  findings: Finding[];
}

const SUPPORT = new Set(["human", "chair", "assistant", "scribe", "floor"]);
const ECHO = 0.6;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export interface GradeInput {
  /** Each member's job, when known (the workspace's member list), to spot one job on several seats. */
  roles?: Record<string, string>;
}

export function gradeRoom(events: readonly RoomEvent[], usage: readonly UsageRow[] = [], input: GradeInput = {}): Grade {
  const joined = events.flatMap((e) => (e.type === "agent.joined" ? [e.agent] : []));
  const spoke = events.flatMap((e) => (e.type === "message" && !SUPPORT.has(e.from) && !e.from.startsWith("mail:") ? [e.from] : []));
  const ids = [...new Set([...joined, ...spoke])];
  const who = new Set(ids);
  const msgs = events.filter((e): e is Extract<RoomEvent, { type: "message" }> => e.type === "message");
  const member = msgs.filter((e) => who.has(e.from));
  const tags = events.flatMap((e) => (e.type === "tags" ? e.items : []));

  // Echo: a member message whose words mostly appear in one of the five member messages before it, by someone else.
  const bags = member.map((e) => words(e.text));
  const echoed = member.map((e, i) =>
    member
      .slice(Math.max(0, i - 5), i)
      .some((p, j) => p.from !== e.from && overlap(bags[i], bags[Math.max(0, i - 5) + j]) >= ECHO),
  );
  const members: MemberLine[] = ids.map((id) => {
    const mine = member.flatMap((e, i) => (e.from === id ? [i] : []));
    return {
      id,
      messages: mine.length,
      passes: events.filter((e) => e.type === "pass" && e.from === id).length,
      echo: mine.length ? round(mine.filter((i) => echoed[i]).length / mine.length) : 0,
    };
  });

  // Seat overlap: Jaccard of each pair's vocabularies, ignoring words most members use.
  const vocab = new Map(ids.map((id) => [id, new Set(member.filter((e) => e.from === id).flatMap((e) => [...words(e.text)]))]));
  const df = new Map<string, number>();
  for (const v of vocab.values()) for (const w of v) df.set(w, (df.get(w) ?? 0) + 1);
  const common = (w: string) => (df.get(w) ?? 0) > Math.max(2, ids.length / 2);
  const pairs: Grade["pairs"] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = [...(vocab.get(ids[i]) ?? [])].filter((w) => !common(w));
      const b = new Set([...(vocab.get(ids[j]) ?? [])].filter((w) => !common(w)));
      if (a.length < 20 || b.size < 20) continue;
      const both = a.filter((w) => b.has(w)).length;
      pairs.push({ a: ids[i], b: ids[j], overlap: round(both / (a.length + b.size - both)) });
    }
  pairs.sort((x, y) => y.overlap - x.overlap);

  // Evidence: tagged evidence, or a reply from the project's agents.
  const evidenceSeqs = new Set(tags.filter((t) => t.kind === "evidence").map((t) => t.seq));
  for (const e of msgs) if (e.from.startsWith("mail:")) evidenceSeqs.add(e.seq);
  let dry = 0;
  let longestDry = 0;
  for (const e of member) {
    dry = evidenceSeqs.has(e.seq) ? 0 : dry + 1;
    longestDry = Math.max(longestDry, dry);
  }

  const replied = new Set(msgs.flatMap((e) => (e.replyTo ? [e.replyTo] : [])));
  const questions = tags.filter((t) => t.kind === "question");
  const resolved = new Map(events.flatMap((e) => (e.type === "suggestion.resolved" ? [[e.id, e] as const] : [])));
  const sugs = events.filter((e): e is Extract<RoomEvent, { type: "suggestion" }> => e.type === "suggestion");
  const accepted = sugs.filter((s) => resolved.get(s.id)?.accepted);
  const docVersions = events.filter((e) => e.type === "doc.revised").length;
  const docsAccepted = new Set(events.flatMap((e) => (e.type === "doc.accepted" ? [e.slug] : []))).size;
  // Only the documents the channel ended on: approved ones, or the last one written. Drafts that were
  // merged into a later document are expected to fall behind.
  const approved = new Set(events.flatMap((e) => (e.type === "doc.accepted" ? [e.slug] : [])));
  const lastDoc = [...events].reverse().find((e) => e.type === "doc.revised");
  const outcome = approved.size ? approved : new Set(lastDoc?.type === "doc.revised" ? [lastDoc.slug] : []);
  const lag = docLags(events, ids).filter((d) => outcome.has(d.slug));
  const exported = new Set(events.flatMap((e) => (e.type === "doc.exported" ? [e.slug] : [])));
  for (const e of events)
    if (e.type === "aside") for (const m of e.text.matchAll(/^Exported (\S+?)(?: v\d+)? to /gm)) exported.add(m[1]);
  const byRole = new Map<string, string[]>();
  for (const id of ids) {
    const r = input.roles?.[id]?.trim().toLowerCase();
    if (r) byRole.set(r, [...(byRole.get(r) ?? []), id]);
  }
  const sharedRoles = [...byRole].filter(([, v]) => v.length > 1).map(([role, v]) => ({ role, ids: v }));

  const counts: Grade["counts"] = {
    memberMessages: member.length,
    humanMessages: msgs.filter((e) => e.from === "human").length,
    supportMessages: msgs.filter((e) => SUPPORT.has(e.from) && e.from !== "human").length,
    asides: events.filter((e) => e.type === "aside" && e.from === "assistant").length,
    passes: events.filter((e) => e.type === "pass").length,
    failed: events.filter((e) => e.type === "turn.failed").length,
    aborted: events.filter((e) => e.type === "turn.aborted").length,
    suggestions: sugs.length,
    accepted: accepted.length,
    declined: sugs.filter((s) => resolved.has(s.id) && !resolved.get(s.id)!.accepted && !resolved.get(s.id)!.withdrawn).length,
    withdrawn: sugs.filter((s) => resolved.get(s.id)?.withdrawn).length,
    pending: sugs.filter((s) => !resolved.has(s.id)).length,
    seatChanges: accepted.filter((s) => ["add", "hire", "remove", "swap"].includes(s.action)).length,
    steers: accepted.filter((s) => s.action === "steer").length,
    evidence: evidenceSeqs.size,
    decisions: tags.filter((t) => t.kind === "decision").length,
    questions: questions.length,
    openQuestions: questions.filter((q) => !replied.has(q.seq)).length,
    probeTalk: member.filter((e) => PROBE.test(e.text)).length,
    mailDrafted: sugs.filter((s) => s.action === "mail").length,
    mailSent: events.filter((e) => e.type === "mail.out").length,
    mailReplies: msgs.filter((e) => e.from.startsWith("mail:")).length,
    docVersions,
    docsAccepted,
    docsExported: exported.size,
  };

  let cost: Grade["cost"];
  if (usage.length) {
    // Usage is only compared with the turns taken since the channel started recording it.
    const since = usage[0].ts;
    const list = usage.reduce((n, r) => n + (r.listUsd ?? r.usd ?? 0), 0);
    const mem = usage.filter((r) => r.role === "member").reduce((n, r) => n + (r.listUsd ?? r.usd ?? 0), 0);
    cost = {
      listUsd: round(list),
      memberShare: list ? round(mem / list) : 0,
      meteredTurns: usage.filter((r) => r.role === "member").length,
      memberTurns: member.filter((e) => e.ts >= since).length + events.filter((e) => e.type === "pass" && e.ts >= since).length,
      ...(docsAccepted ? { perAcceptedDoc: round(list / docsAccepted) } : {}),
    };
  }

  const g: Grade = { events: events.length, members, counts, pairs: pairs.slice(0, 5), sharedRoles, longestDry, lag, ...(cost ? { cost } : {}), findings: [] };
  g.findings = findings(g);
  return g;
}

function findings(g: Grade): Finding[] {
  const c = g.counts;
  const out: Finding[] = [];
  const add = (area: string, level: Level, text: string) => out.push({ area, level, text });
  const m = Math.max(1, c.memberMessages);

  // Evidence: did claims meet anything outside the text?
  if (c.evidence === 0) add("evidence", "poor", `No evidence entered the channel: ${c.memberMessages} member messages were all argument.`);
  else if (g.longestDry >= 12) add("evidence", "watch", `${g.longestDry} member messages in a row with no evidence.`);
  else add("evidence", "ok", `${c.evidence} pieces of evidence; longest run without any was ${g.longestDry} messages.`);

  // Probes: talked about, drafted, sent, answered.
  if (c.probeTalk >= 3 && c.mailSent === 0)
    add("probes", "poor", `${c.probeTalk} member messages discuss probes or experiments; ${c.mailDrafted} were drafted as mail and none were sent.`);
  else if (c.mailSent && !c.mailReplies) add("probes", "watch", `${c.mailSent} mail sent to the project's agents and no reply came back into the channel.`);
  else if (c.mailSent) add("probes", "ok", `${c.mailSent} mail sent, ${c.mailReplies} replies came back.`);

  // Documents: does the record keep up with the talk?
  if (!c.docVersions) add("documents", c.memberMessages >= 10 ? "poor" : "watch", "No document was written; the outcome lives only in the transcript.");
  for (const d of g.lag.filter((l) => l.decisions >= 2 || l.messages >= 8))
    add("documents", d.decisions >= 3 ? "poor" : "watch", `${d.slug} v${d.version} misses ${d.decisions} decisions and ${d.messages} member messages that came after it.`);
  if (c.docVersions && !c.docsAccepted) add("documents", "watch", `${c.docVersions} document versions and none approved.`);

  // Seats: distinct jobs, everyone pulling weight.
  const quiet = g.members.filter((x) => x.messages <= 1);
  const top = [...g.members].sort((a, b) => b.messages - a.messages)[0];
  if (top && g.members.length >= 3 && top.messages > 0.4 * c.memberMessages)
    add("lineup", "watch", `${top.id} wrote ${pct(top.messages / Math.max(1, c.memberMessages))} of the member messages.`);
  if (g.members.length > 6) add("lineup", "watch", `${g.members.length} members; past six, seats tend to overlap.`);
  if (quiet.length >= 2) add("lineup", "watch", `${quiet.length} members spoke once or not at all: ${quiet.map((x) => x.id).join(", ")}.`);
  for (const r of g.sharedRoles) add("lineup", "poor", `${r.ids.length} seats share one job (${r.role}): ${r.ids.join(", ")}.`);
  const twins = g.pairs.filter((p) => p.overlap >= 0.3);
  if (twins.length) add("lineup", "watch", `Overlapping seats: ${twins.map((p) => `${p.a}/${p.b} ${pct(p.overlap)}`).join(", ")}.`);
  const echoes = g.members.filter((x) => x.messages >= 3 && x.echo >= 0.5);
  if (echoes.length) add("lineup", "watch", `Mostly echoing others: ${echoes.map((x) => `${x.id} ${pct(x.echo)}`).join(", ")}.`);
  if (c.withdrawn >= 5 && c.withdrawn * 2 >= c.suggestions)
    add("support", "watch", `${c.withdrawn} of ${c.suggestions} suggestions were withdrawn and replaced before the human answered.`);
  if (c.seatChanges > Math.max(4, g.members.length)) add("lineup", "watch", `${c.seatChanges} seat changes; the lineup kept being rebuilt.`);

  // Support load: the room should mostly hear from its members.
  const support = c.asides + c.supportMessages;
  if (support > m) add("support", "poor", `Support roles posted ${support} times against ${c.memberMessages} member messages.`);
  else if (support > m / 2) add("support", "watch", `Support roles posted ${support} times against ${c.memberMessages} member messages.`);
  if (c.steers >= 3) add("support", "watch", `${c.steers} steers accepted; the brief kept changing.`);

  // Questions and the ending.
  if (c.openQuestions) add("closure", c.openQuestions * 2 >= c.questions ? "watch" : "ok", `${c.openQuestions} of ${c.questions} tagged questions got no direct reply.`);
  if (c.pending) add("closure", "watch", `${c.pending} suggestions were still waiting on the human at the end.`);
  if (c.failed + c.aborted >= 3) add("reliability", "watch", `${c.failed} failed and ${c.aborted} aborted turns.`);

  // Cost.
  if (!g.cost) add("cost", "watch", "No usage was recorded, so the channel's cost is unknown.");
  else {
    if (g.cost.meteredTurns < g.cost.memberTurns * 0.9)
      add("cost", "watch", `Only ${g.cost.meteredTurns} of ${g.cost.memberTurns} member turns recorded usage.`);
    if (g.cost.memberShare < 0.5) add("cost", "watch", `Support roles took ${pct(1 - g.cost.memberShare)} of the cost.`);
    add("cost", "ok", `$${g.cost.listUsd} at list prices${g.cost.perAcceptedDoc !== undefined ? `, $${g.cost.perAcceptedDoc} per approved document` : ""}.`);
  }

  const rank: Record<Level, number> = { poor: 0, watch: 1, ok: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** The grade as a short markdown report, worst findings first. */
export function formatGrade(name: string, g: Grade): string {
  const c = g.counts;
  const mark: Record<Level, string> = { poor: "✗", watch: "!", ok: "✓" };
  return [
    `# ${name}`,
    "",
    ...g.findings.map((f) => `- ${mark[f.level]} **${f.area}:** ${f.text}`),
    "",
    `Members: ${g.members.map((x) => `${x.id} ${x.messages}`).join(", ")}`,
    `Messages: ${c.memberMessages} member, ${c.humanMessages} human, ${c.supportMessages} support, ${c.asides} assistant asides, ${c.passes} passes`,
    `Suggestions: ${c.suggestions} (${c.accepted} accepted, ${c.declined} declined, ${c.withdrawn} withdrawn, ${c.pending} pending)`,
    `Tags: ${c.evidence} evidence, ${c.decisions} decisions, ${c.questions} questions`,
    `Docs: ${c.docVersions} versions, ${c.docsAccepted} approved, ${c.docsExported} exported`,
    `Mail: ${c.mailDrafted} drafted, ${c.mailSent} sent, ${c.mailReplies} replies`,
    ...(g.pairs.length ? [`Closest seats: ${g.pairs.slice(0, 3).map((p) => `${p.a}/${p.b} ${pct(p.overlap)}`).join(", ")}`] : []),
  ].join("\n");
}
