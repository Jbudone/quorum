/** Reviewing a document: its sections, and what changed between two versions. */

export interface Section {
  /** The heading text, without the #s. */
  title: string;
  /** 0-based line index of the heading. */
  line: number;
}

/** The markdown headings (# to ###) outside code fences, in order. */
export function sections(text: string): Section[] {
  const out: Section[] = [];
  let fenced = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    const m = !fenced && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push({ title: m[2], line: i });
  });
  return out;
}

/** The text of one section: its heading down to the next heading of the same or a higher level. */
export function sectionText(text: string, title: string): string | undefined {
  const lines = text.split("\n");
  const all = sections(text);
  const i = all.findIndex((s) => s.title === title);
  if (i < 0) return undefined;
  const level = /^#+/.exec(lines[all[i].line])![0].length;
  const next = all.slice(i + 1).find((s) => /^#+/.exec(lines[s.line])![0].length <= level);
  return lines.slice(all[i].line, next?.line ?? lines.length).join("\n");
}

export type DiffLine = { op: " " | "+" | "-"; text: string };

/**
 * A line diff (longest common subsequence). Documents are short, but very long pairs fall back to
 * "everything replaced" rather than a quadratic table.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

/** A compact unified diff: changed lines with a little context, for prompts. */
export function unifiedDiff(before: string, after: string, context = 2): string {
  const d = lineDiff(before, after);
  const keep = new Set<number>();
  d.forEach((l, i) => {
    if (l.op !== " ") for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep.add(k);
  });
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && i > last + 1) out.push("…");
    out.push(`${d[i].op} ${d[i].text}`);
    last = i;
  }
  return out.join("\n");
}

/** A section's own lines: its heading down to the next heading of any level. */
function ownText(text: string, title: string): string | undefined {
  const lines = text.split("\n");
  const all = sections(text);
  const i = all.findIndex((s) => s.title === title);
  if (i < 0) return undefined;
  return lines.slice(all[i].line, all[i + 1]?.line ?? lines.length).join("\n").trimEnd();
}

/**
 * Titles of the sections in `after` whose own text differs from `before` (or is new). A title
 * section doesn't count as changed just because something under it did.
 */
export function changedSections(before: string, after: string): string[] {
  return sections(after)
    .map((s) => s.title)
    .filter((t) => ownText(before, t) !== ownText(after, t));
}
