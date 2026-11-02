import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { channelTerms, noteTerms, parseGlossary, repoAdrs } from "../src/room/glossary.js";

describe("the glossary", () => {
  const repo = mkdtempSync(join(tmpdir(), "gloss-"));
  mkdirSync(join(repo, "docs", "adr"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "adr", "0001-single-authoritative-grid.md"),
    "# ADR 0001: Server is the authoritative grid\n\n- Status: implemented\n\n## Context\n\nWhy.\n\n## Decision\n\n- The server grid is the single source of truth.\n",
  );
  writeFileSync(join(repo, "CONTEXT.md"), "## Terms\n\n- **ChangeSet** — `{id, ops[]}`; a unit of proposed work.\n- **Op / LevelOp** — one grid mutation.\n");

  it("reads the repo's ADRs and the terms its notes define", () => {
    expect(repoAdrs(repo)).toEqual([
      expect.objectContaining({ term: "ADR 0001", kind: "adr", source: "docs/adr/0001-single-authoritative-grid.md", brief: "Server is the authoritative grid (implemented) — The server grid is the single source of truth." }),
    ]);
    expect(noteTerms(repo)).toEqual([
      { term: "ChangeSet", kind: "term", brief: "{id, ops[]}; a unit of proposed work.", source: "CONTEXT.md" },
      { term: "Op", kind: "term", brief: "one grid mutation.", aliases: ["LevelOp"], source: "CONTEXT.md" },
    ]);
  });

  it("finds the names a channel keeps using that nothing defines, and reads briefs back", () => {
    const known = [...repoAdrs(repo), ...noteTerms(repo)];
    const terms = channelTerms(
      [
        { seq: 3, text: "ADR 0001 holds, but ADR-9 should cover `commitChangeSet` and `ChangeSet`." },
        { seq: 5, text: "`commitChangeSet` is the gate; `plain` is just a word; ADR 0009 again." },
      ],
      known,
    );
    expect(terms.map((t) => [t.term, t.mentions])).toEqual([
      ["ADR 0009", [3, 5]],
      ["commitChangeSet", [3, 5]],
    ]);
    expect(parseGlossary('{"terms":[{"term":"commitChangeSet","brief":" where ops commit "},{"term":"nope","brief":"x"}]}', ["commitChangeSet"])).toEqual([{ term: "commitChangeSet", brief: "where ops commit" }]);
  });
});
