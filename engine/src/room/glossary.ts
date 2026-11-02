import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The project's vocabulary, for a human who hasn't followed every discussion: its ADRs (decision
 * records), the terms its notes define (CONTEXT.md and the like), and the code names a channel keeps
 * using, each with a short brief. Repo sources are read as they are; channel terms nobody defined
 * get a one-line brief written by a model, once, and kept in the channel's log.
 */

export interface GlossaryEntry {
  /** As people write it: "ADR 0001", "ChangeSet", "fillRuns". */
  term: string;
  kind: "adr" | "term" | "code";
  brief: string;
  /** Other ways it's written ("ADR-0001", "LevelOp"). */
  aliases?: string[];
  /** Where it's defined: a repo path, or "channel" for terms only the discussion uses. */
  source?: string;
  /** For channel terms: message numbers that mention it. */
  mentions?: number[];
}

const ADR_DIRS = ["docs/adr", "docs/adrs", "adr", "doc/adr", "docs/decisions", "decisions"];
const NOTE_FILES = ["CONTEXT.md", "GLOSSARY.md", "docs/glossary.md", "docs/CONTEXT.md"];

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** ADRs in the repo: number and title from the file, status and the decision's gist from its body. */
export function repoAdrs(repo: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const d of ADR_DIRS) {
    const dir = join(repo, d);
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /^\d{1,4}[-_].+\.md$/i.test(f)).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      let src = "";
      try {
        src = readFileSync(join(dir, f), "utf8");
      } catch {
        continue;
      }
      const num = f.match(/^(\d{1,4})/)![1].padStart(4, "0");
      const title = squash(/^#\s+(?:ADR[-\s]*\d+\s*[:.—-]\s*)?(.+)$/m.exec(src)?.[1] ?? f.replace(/^\d+[-_]/, "").replace(/\.md$/, "").replace(/[-_]/g, " "));
      const status = squash(/^[-*\s]*\**status\**\s*[:—-]\s*(.+)$/im.exec(src)?.[1] ?? /^##\s*status\s*\n+(.+)$/im.exec(src)?.[1] ?? "");
      const decision = /^##\s*decision\s*\n([\s\S]*?)(?=\n##\s|$)/im.exec(src)?.[1] ?? /^##\s*context\s*\n([\s\S]*?)(?=\n##\s|$)/im.exec(src)?.[1] ?? "";
      const gist = squash(decision.replace(/^[-*]\s+/gm, "").replace(/`/g, ""));
      out.push({
        term: `ADR ${num}`,
        kind: "adr",
        brief: [title, status ? `(${clip(status, 60)})` : "", gist ? `— ${clip(gist, 220)}` : ""].filter(Boolean).join(" "),
        aliases: [`ADR-${num}`, `ADR ${Number(num)}`, `ADR${num}`],
        source: `${d}/${f}`,
      });
    }
    if (out.length) break;
  }
  return out;
}

/** Terms a project's notes define, as "- **Term** — meaning" or "**Term**: meaning" (a term may be "A / B"). */
export function noteTerms(repo: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const f of NOTE_FILES) {
    let src = "";
    try {
      src = readFileSync(join(repo, f), "utf8");
    } catch {
      continue;
    }
    // A definition runs to the next bullet, heading or blank line.
    const re = /^[-*]?\s*\*\*([^*\n]{1,60})\*\*\s*(?:—|–|-|:)\s*([\s\S]*?)(?=\n\s*\n|\n[-*]\s|\n#|$)/gm;
    for (const m of src.matchAll(re)) {
      const names = m[1].split(/\s+\/\s+/).map((x) => x.trim()).filter(Boolean);
      if (!names.length || out.some((e) => e.term === names[0])) continue;
      out.push({ term: names[0], kind: "term", brief: clip(squash(m[2].replace(/`/g, "")), 260), ...(names.length > 1 ? { aliases: names.slice(1) } : {}), source: f });
    }
  }
  return out;
}

/** Text that may name things: messages, documents, cards. */
export interface Said {
  seq?: number;
  text: string;
}

/**
 * Names a channel keeps using that the repo doesn't define: ADR numbers, and code-like names in
 * backticks (camelCase, snake_case, dotted or pathed) mentioned at least twice. Most-used first.
 */
export function channelTerms(said: Said[], known: GlossaryEntry[], max = 40): { term: string; kind: "adr" | "code"; mentions: number[]; snippets: string[] }[] {
  const have = new Set(known.flatMap((e) => [e.term, ...(e.aliases ?? [])].map((x) => x.toLowerCase())));
  const found = new Map<string, { term: string; kind: "adr" | "code"; mentions: Set<number>; count: number; snippets: string[] }>();
  const note = (term: string, kind: "adr" | "code", s: Said, at: number) => {
    if (have.has(term.toLowerCase())) return;
    const f = found.get(term) ?? { term, kind, mentions: new Set<number>(), count: 0, snippets: [] };
    f.count++;
    if (s.seq) f.mentions.add(s.seq);
    if (f.snippets.length < 2) f.snippets.push(squash(s.text.slice(Math.max(0, at - 120), at + 160)));
    found.set(term, f);
  };
  for (const s of said) {
    for (const m of s.text.matchAll(/\bADR[-\s]?(\d{1,4})\b/g)) note(`ADR ${m[1].padStart(4, "0")}`, "adr", s, m.index ?? 0);
    for (const m of s.text.matchAll(/`([A-Za-z_][\w.\/-]{2,40})`/g)) {
      const t = m[1];
      // Code-like: mixed case inside, an underscore, a dot or a slash; not a plain word.
      if (!/[a-z][A-Z]|_|\.|\//.test(t) || /^\d/.test(t)) continue;
      note(t, "code", s, m.index ?? 0);
    }
  }
  return [...found.values()]
    .filter((f) => f.kind === "adr" || f.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((f) => ({ term: f.term, kind: f.kind, mentions: [...f.mentions].sort((a, b) => a - b), snippets: f.snippets }));
}

/** Asks for a one-line brief of each term, from how the channel uses it. */
export function glossaryPrompt(terms: { term: string; snippets: string[] }[], topic?: string): string {
  return [
    topic ? `A discussion about: ${topic}` : "",
    `Terms it uses, each with where it appears:\n\n${terms.map((t) => `${t.term}\n${t.snippets.map((s) => `  … ${s} …`).join("\n")}`).join("\n\n")}`,
    `For each term, write what it is in plain words for someone new to the project: one line, under 18 words, no jargon you don't explain. For an ADR, say what it decides. If the snippets don't make it clear, say what it seems to be and add "(unclear)".`,
    `Answer with JSON only: {"terms": [{"term": "<exactly as given>", "brief": "<one line>"}]}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseGlossary(text: string, terms: string[]): { term: string; brief: string }[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const raw = JSON.parse(text.slice(start, end + 1));
    const want = new Set(terms);
    return (Array.isArray(raw?.terms) ? raw.terms : []).flatMap((t: any) => {
      const term = String(t?.term ?? "");
      const brief = squash(String(t?.brief ?? ""));
      return want.has(term) && brief ? [{ term, brief: clip(brief, 200) }] : [];
    });
  } catch {
    return [];
  }
}
