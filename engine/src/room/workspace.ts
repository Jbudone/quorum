import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadPersona, parsePersona, type AgentSpec, type Persona } from "../config.js";
import { RoomStore } from "./store.js";

/**
 * A repo's workspace: `<repo>/.quorum/`. Channels are rooms (`rooms/<id>/`); members belong to the
 * workspace, not a channel, so the same member can sit in several channels and carries its own
 * notebook (`members/<id>.md`) between them. Personas the assistant invents live in `personas/`.
 */
export interface WorkspaceMember extends AgentSpec {
  /** One-line role, e.g. "research scientist, procedural content generation". */
  role?: string;
}

const MEMBER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class Workspace {
  readonly dir: string;

  constructor(readonly repo: string) {
    this.dir = join(repo, ".quorum");
  }

  members(): WorkspaceMember[] {
    try {
      return JSON.parse(readFileSync(join(this.dir, "workspace.json"), "utf8")).members ?? [];
    } catch {
      return [];
    }
  }

  /** Adds a member, or updates the one with the same id. */
  saveMember(m: WorkspaceMember): void {
    if (!MEMBER_ID.test(m.id)) throw new Error(`bad member name "${m.id}": use lowercase letters, digits and dashes`);
    const all = this.members().filter((x) => x.id !== m.id);
    let w: any = {};
    try {
      w = JSON.parse(readFileSync(join(this.dir, "workspace.json"), "utf8"));
    } catch {}
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "workspace.json"), JSON.stringify({ ...w, members: [...all, m] }, null, 2));
  }

  /** A workspace-wide flag, e.g. whether the human was asked about the mail pointer. */
  flag(name: string): string | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, "workspace.json"), "utf8")).flags?.[name];
    } catch {
      return undefined;
    }
  }

  setFlag(name: string, value: string): void {
    let w: any = {};
    try {
      w = JSON.parse(readFileSync(join(this.dir, "workspace.json"), "utf8"));
    } catch {}
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "workspace.json"), JSON.stringify({ ...w, members: w.members ?? [], flags: { ...w.flags, [name]: value } }, null, 2));
  }

  /** Saves an invented persona under the member's id, so it can join other channels later. */
  writePersona(key: string, p: Persona): void {
    if (!MEMBER_ID.test(key)) throw new Error(`bad persona name "${key}"`);
    mkdirSync(join(this.dir, "personas"), { recursive: true });
    writeFileSync(join(this.dir, "personas", `${key}.md`), `---\nname: ${p.name}\nrole: ${p.role}\n---\n${p.body.trim()}\n`);
  }

  /** Channels in this workspace, newest activity first. */
  channels() {
    return RoomStore.list(this.repo).sort((a, b) => b.updated.localeCompare(a.updated));
  }
}

/** Loads a persona: the workspace's own first, then the user's and the shipped ones. */
export function personaFor(repo: string, key: string, assetsDir?: string): Persona {
  const mine = join(repo, ".quorum", "personas", `${key}.md`);
  if (/^[\w-]+$/.test(key) && existsSync(mine)) return parsePersona(readFileSync(mine, "utf8"));
  return loadPersona(key, assetsDir);
}

const READABLE = /\.(md|mdx|txt|rst|org|json|toml|ya?ml|ts|tsx|js|go|py|rs)$/i;
const MAX_FILES = 300;

/** The files a reading list covers, relative to the repo, with their modification times. */
export function readingFiles(repo: string, reading: string[]): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (abs: string) => {
    if (out.length >= MAX_FILES) return;
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(abs).sort()) if (!f.startsWith(".") && f !== "node_modules") walk(join(abs, f));
    } else if (READABLE.test(abs)) out.push({ path: relative(repo, abs), mtime: st.mtimeMs });
  };
  for (const p of reading) walk(resolve(repo, p));
  return out;
}

/** Checks a reading-list entry: it must exist and stay inside the repo. Returns it relative to the repo. */
export function readingPath(repo: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(repo, p);
  const rel = relative(repo, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${p} is outside the project`);
  if (!existsSync(abs)) throw new Error(`nothing at ${p}`);
  return rel || ".";
}
