import { RoomStore } from "./store.js";

/**
 * Support roles (assistant, Chair) answer in prose and end with action lines:
 *
 *   >> focus: caching | the storage question is settled
 *
 * Plain text works on every CLI, including ones that can't be given tools.
 */
export interface Directive {
  verb: string;
  args: string[];
  why: string;
}

const LINE = /^\s*>>\s*([a-z-]+)\s*:\s*(.*)$/i;
const TEXT_VERBS = new Set(["steer", "pause", "raise"]);

/** Splits a reply into its prose and its action lines. Unknown verbs are dropped. */
export function parseDirectives(text: string, verbs: readonly string[]): { prose: string; directives: Directive[] } {
  const prose: string[] = [];
  const directives: Directive[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) {
      prose.push(line);
      continue;
    }
    const verb = m[1].toLowerCase();
    if (!verbs.includes(verb)) continue;
    const [body, ...why] = m[2].split("|");
    // Free-text verbs keep their body whole; the rest are space-separated words (ids, slugs, numbers).
    const args = TEXT_VERBS.has(verb) ? [body.trim()] : body.trim().split(/\s+/).filter(Boolean);
    directives.push({ verb, args, why: why.join("|").trim() });
  }
  return { prose: prose.join("\n").trim(), directives };
}

/**
 * The scribe answers with whole files:
 *
 *   === decisions.md ===
 *   ...full new contents...
 *
 * Only paths the store accepts as docs are kept; anything else is ignored.
 */
export function parseFileBlocks(text: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  let cur: { path: string; lines: string[] } | undefined;
  const flush = () => {
    if (cur && RoomStore.isDocPath(cur.path)) out.push({ path: cur.path, text: cur.lines.join("\n").trim() });
  };
  for (const line of text.split("\n")) {
    const m = /^===\s*(?:docs\/)?(\S+?)\s*===\s*$/.exec(line);
    if (m) {
      flush();
      cur = { path: m[1], lines: [] };
    } else cur?.lines.push(line);
  }
  flush();
  return out;
}
