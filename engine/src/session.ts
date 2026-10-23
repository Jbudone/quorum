import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CouncilConfig } from "./config.js";

export interface TranscriptEntry {
  round: number;
  /** Agent id, "chair", or "human". */
  speaker: string;
  text: string;
  ts: string;
}

/** Plain-file session store under `<repo>/.quorum/sessions/<id>/`. */
export class Session {
  readonly dir: string;

  private constructor(
    readonly id: string,
    root: string,
  ) {
    this.dir = join(root, ".quorum", "sessions", id);
  }

  static create(root: string, config: CouncilConfig, topic: string, now = new Date()): Session {
    const id = `${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${config.name}`;
    const s = new Session(id, root);
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, "session.json"), JSON.stringify({ id, topic, config }, null, 2));
    for (const f of ["plan.md", "decisions.md", "dissent.md", "open-questions.md"]) {
      writeFileSync(join(s.dir, f), "");
    }
    return s;
  }

  static open(root: string, id: string): Session {
    return new Session(id, root);
  }

  meta(): { id: string; topic: string; config: CouncilConfig } {
    return JSON.parse(readFileSync(join(this.dir, "session.json"), "utf8"));
  }

  append(entry: Omit<TranscriptEntry, "ts">): void {
    appendFileSync(
      join(this.dir, "transcript.jsonl"),
      JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n",
    );
  }

  transcript(): TranscriptEntry[] {
    try {
      return readFileSync(join(this.dir, "transcript.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  write(file: "plan.md" | "decisions.md" | "dissent.md" | "open-questions.md", text: string): void {
    writeFileSync(join(this.dir, file), text);
  }

  read(file: "plan.md" | "decisions.md" | "dissent.md" | "open-questions.md"): string {
    return readFileSync(join(this.dir, file), "utf8");
  }
}
