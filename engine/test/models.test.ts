import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexModels, listModels, parseAgyModels, parseOpencodeModels } from "../src/models.js";

describe("model lists", () => {
  it("reads opencode's, agy's and codex's model lists", () => {
    expect(parseOpencodeModels("anthropic/claude-haiku-5-5\nopenrouter/qwen/qwen3-coder\nnot a model\n")).toEqual([{ id: "anthropic/claude-haiku-5-5" }, { id: "openrouter/qwen/qwen3-coder" }]);
    expect(parseAgyModels("Fetching available models...\ngemini-4-argon-low\tGemini 4 Argon (Low)\n")).toEqual([{ id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" }]);
    const f = join(mkdtempSync(join(tmpdir(), "codex-")), "models_cache.json");
    writeFileSync(f, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" }, { slug: "codex-auto-review", visibility: "hide" }, { nope: 1 }] }));
    expect(codexModels(f)).toEqual([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }]);
    expect(codexModels(join(tmpdir(), "missing.json"))).toEqual([]);
  });

  it("offers Claude's aliases without asking the CLI", async () => {
    expect((await listModels("claude")).map((m) => m.id)).toContain("sonnet");
  });
});
