import { createHash } from "node:crypto";
import { ASSISTANT_BLOCKS, ASSISTANT_VERBS, CHAIR_VERBS } from "../room/directives.js";
import { CARD_SYSTEM, FLOOR_SYSTEM, floorPrompt, GIST_WORDS, highlightCardPrompt, highlightsPrompt } from "../room/floor.js";
import { glossaryPrompt } from "../room/glossary.js";
import {
  accessNote,
  ASSISTANT_SYSTEM,
  assistantActions,
  assistantAsk,
  assistantContext,
  assistantWatch,
  BRIEF_SYSTEM,
  briefPrompt,
  CHAIR_SYSTEM,
  chairPrompt,
  docBriefPrompt,
  EXIT_MEMO,
  memberFresh,
  memberIncremental,
  memberThread,
  PERSONA_SYSTEM,
  personaDraftPrompt,
  reviseIndependent,
  SCRIBE_SYSTEM,
  scribePrompt,
  THREAD_SUMMARY,
  threadSummaryPrompt,
} from "../room/prompts.js";

/**
 * Every kind of model call a channel makes, what it's for, where its prompt is written, the code
 * its version is taken from, and the rules its reply should keep. The version is a fingerprint of
 * that code (functions print as their source), so it changes only when that prompt is edited, and a
 * report can compare a prompt's replies before and after the edit.
 */

export type Purpose =
  | "member"
  | "member.revise"
  | "member.exit"
  | "floor"
  | "highlights"
  | "card"
  | "glossary"
  | "doc.brief"
  | "catchup"
  | "persona"
  | "thread.summary"
  | "chair"
  | "scribe"
  | "assistant.ask"
  | "assistant.watch";

interface PurposeDef {
  about: string;
  /** Where to edit the prompt. */
  where: string;
  sources: unknown[];
  check?: (reply: string) => string[];
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const sentences = (s: string) => s.split(/(?<=[.!?])\s+(?=[A-Z"'`(])/).filter((x) => x.trim()).length;

function json(reply: string): any {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** The reply minus its action lines and blocks: the prose the human reads. */
function prose(reply: string, blocks: readonly string[]): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of reply.split("\n")) {
    const m = /^\s*>>\s*([a-z_-]+)\s*:?/i.exec(line);
    if (m && blocks.includes(m[1].toLowerCase())) inBlock = true;
    else if (m && m[1].toLowerCase() === "end") inBlock = false;
    else if (!inBlock && !m && !/^\s*DIGEST:/.test(line)) out.push(line);
  }
  return out.join("\n").trim();
}

function actions(reply: string, verbs: readonly string[]): string[] {
  const known = new Set([...verbs, "end"]);
  const bad = new Set<string>();
  for (const m of reply.matchAll(/^\s*>>\s*([a-z_-]+)\s*:/gim)) if (!known.has(m[1].toLowerCase())) bad.add(m[1].toLowerCase());
  return [...bad].map((v) => `unknown action ">> ${v}"`);
}

function chat(reply: string, verbs: readonly string[], blocks: readonly string[], maxWords: number): string[] {
  const p = prose(reply, blocks);
  const out = actions(reply, [...verbs, ...blocks]);
  if (words(p) > maxWords) out.push(`${words(p)} words of prose, asked for one to three short sentences`);
  if (/^#{1,6}\s/m.test(p)) out.push("used headings");
  const digest = /^\s*DIGEST:\s*(.*)$/m.exec(reply)?.[1];
  if (digest && digest.length > 90) out.push(`status line of ${digest.length} characters, asked for under 90`);
  return out;
}

function card(reply: string): string[] {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(reply)?.[1];
  const body = reply.replace(/```[\s\S]*?```/g, "");
  const bullets = body.split("\n").filter((l) => /^\s*[-*•]\s+/.test(l));
  const para = body
    .split("\n")
    .filter((l) => l.trim() && !/^\s*[-*•]\s+/.test(l))
    .join(" ");
  if (sentences(para) > 2) out.push(`${sentences(para)} sentences in the paragraph, asked for at most two`);
  if (words(para) > 40) out.push(`paragraph of ${words(para)} words, asked for under 40`);
  if (bullets.length < 2 || bullets.length > 3) out.push(`${bullets.length} bullets, asked for two or three`);
  const long = bullets.filter((b) => words(b.replace(/^\s*[-*•]\s+/, "")) > 12).length;
  if (long) out.push(`${long} bullet${long > 1 ? "s" : ""} over twelve words`);
  if (fence) {
    const lines = fence.replace(/\n$/, "").split("\n");
    if (lines.length > 5) out.push(`diagram of ${lines.length} lines, asked for at most five`);
    const wide = Math.max(...lines.map((l) => [...l].length));
    if (wide > 44) out.push(`diagram ${wide} characters wide, asked for at most 44`);
  }
  if (/^#{1,6}\s|\*\*[^*]+\*\*:?/m.test(body)) out.push("used headings or bold labels");
  if (/#\d+\b/.test(body)) out.push("cited message numbers");
  return out;
}

export const PURPOSES: Record<Purpose, PurposeDef> = {
  member: {
    about: "a member's turn in the channel",
    where: "engine/src/room/prompts.ts memberFresh / memberIncremental / memberThread",
    sources: [memberFresh, memberIncremental, memberThread, accessNote],
  },
  "member.revise": {
    about: "a member revising its draft after others answered first",
    where: "engine/src/room/prompts.ts reviseIndependent",
    sources: [reviseIndependent],
  },
  "member.exit": { about: "a leaving member's exit memo", where: "engine/src/room/prompts.ts EXIT_MEMO", sources: [EXIT_MEMO] },
  floor: {
    about: "the floor picking who speaks next and tagging messages",
    where: "engine/src/room/floor.ts floorPrompt / FLOOR_SYSTEM",
    sources: [floorPrompt, FLOOR_SYSTEM],
    check: (r) => {
      const j = json(r);
      if (!j) return ["no JSON answer"];
      return Array.isArray(j.speak) ? [] : ['no "speak" list'];
    },
  },
  highlights: {
    about: "gists for the highlights strip, backfilled over older messages",
    where: "engine/src/room/floor.ts highlightsPrompt",
    sources: [highlightsPrompt, FLOOR_SYSTEM],
    check: (r) => {
      const j = json(r);
      if (!j || !Array.isArray(j.highlights)) return ["no JSON highlights list"];
      const long = j.highlights.filter((h: any) => words(String(h?.gist ?? "")) > GIST_WORDS).length;
      return long ? [`${long} gist${long > 1 ? "s" : ""} over ${GIST_WORDS} words`] : [];
    },
  },
  card: {
    about: "the hover card for a highlight",
    where: "engine/src/room/floor.ts highlightCardPrompt / CARD_SYSTEM",
    sources: [highlightCardPrompt, CARD_SYSTEM],
    check: card,
  },
  glossary: {
    about: "one-line briefs for the channel's code names",
    where: "engine/src/room/glossary.ts glossaryPrompt",
    sources: [glossaryPrompt, CARD_SYSTEM],
    check: (r) => {
      const j = json(r);
      if (!j || !Array.isArray(j.terms)) return ["no JSON terms list"];
      const long = j.terms.filter((t: any) => words(String(t?.brief ?? "")) > 18).length;
      return long ? [`${long} brief${long > 1 ? "s" : ""} over 18 words`] : [];
    },
  },
  "doc.brief": {
    about: "the assistant's brief of a document up for review",
    where: "engine/src/room/prompts.ts docBriefPrompt",
    sources: [docBriefPrompt, ASSISTANT_SYSTEM],
    check: (r) => (r.trim() === "NOTHING" ? [] : /#\d+\b/.test(r) ? ["cited message numbers"] : []),
  },
  catchup: {
    about: "a catch-up brief for a member joining late",
    where: "engine/src/room/prompts.ts briefPrompt / BRIEF_SYSTEM",
    sources: [briefPrompt, BRIEF_SYSTEM],
    check: (r) => (words(r) > 150 ? [`${words(r)} words, asked for at most 150`] : []),
  },
  persona: {
    about: "drafting a member from the human's one-line description",
    where: "engine/src/room/prompts.ts personaDraftPrompt / PERSONA_SYSTEM",
    sources: [personaDraftPrompt, PERSONA_SYSTEM],
    check: (r) => (/^ROLE:/m.test(r) ? [] : ["no ROLE: line"]),
  },
  "thread.summary": {
    about: "the one-line summary of a side thread",
    where: "engine/src/room/prompts.ts threadSummaryPrompt / THREAD_SUMMARY",
    sources: [threadSummaryPrompt, THREAD_SUMMARY],
    check: (r) => (sentences(r) > 1 ? [`${sentences(r)} sentences, asked for one`] : []),
  },
  chair: {
    about: "the Chair's check-in on the discussion",
    where: "engine/src/room/prompts.ts chairPrompt / CHAIR_SYSTEM",
    sources: [chairPrompt, CHAIR_SYSTEM],
    check: (r) => actions(r, CHAIR_VERBS),
  },
  scribe: {
    about: "the scribe updating the channel's notes",
    where: "engine/src/room/prompts.ts scribePrompt / SCRIBE_SYSTEM",
    sources: [scribePrompt, SCRIBE_SYSTEM],
  },
  "assistant.ask": {
    about: "the assistant answering the human",
    where: "engine/src/room/prompts.ts assistantAsk / ASSISTANT_SYSTEM",
    sources: [assistantAsk, assistantContext, assistantActions, ASSISTANT_SYSTEM],
    // Answers about a document may run longer (the system prompt allows a few bullets there).
    check: (r) => chat(r, ASSISTANT_VERBS, ASSISTANT_BLOCKS, 160),
  },
  "assistant.watch": {
    about: "the assistant watching the room and suggesting actions",
    where: "engine/src/room/prompts.ts assistantWatch / ASSISTANT_SYSTEM",
    sources: [assistantWatch, assistantContext, assistantActions, ASSISTANT_SYSTEM],
    check: (r) => chat(r, ASSISTANT_VERBS, ASSISTANT_BLOCKS, 90),
  },
};

const prints = new Map<Purpose, string>();

/** The version of a purpose's prompt: a hash of the code that builds it. */
export function fingerprint(p: Purpose): string {
  let v = prints.get(p);
  if (!v) {
    const src = (PURPOSES[p]?.sources ?? []).map((s) => String(s)).join("\0");
    v = createHash("sha1").update(src).digest("hex").slice(0, 8);
    prints.set(p, v);
  }
  return v;
}

/** Where a reply broke its prompt's rules; empty when it kept them (or the purpose has none). */
export function checkReply(p: Purpose, reply: string): string[] {
  if (!reply.trim()) return ["empty reply"];
  try {
    return PURPOSES[p]?.check?.(reply) ?? [];
  } catch {
    return [];
  }
}
