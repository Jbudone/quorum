import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog, mockCatalog, parseOllamaList, type CatalogInputs, type ModelsDev } from "../src/catalog.js";
import { applyProviderEnv, DEFAULT_HARNESS_ORDER, noteRecent, readProviders, readRecent, updateProviders, writeProviders } from "../src/providers.js";
import { customProvider } from "../src/transports/opencode.js";
import { kimiModels, zcodeModels } from "../src/models.js";

const dev: ModelsDev = {
  anthropic: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5", limit: { context: 1_000_000 }, cost: { input: 5, output: 25 }, reasoning: true } } },
  google: { id: "google", name: "Google", env: ["GOOGLE_API_KEY"], models: { "gemini-4-argon": { id: "gemini-4-argon", name: "Gemini 4 Argon" } } },
  openrouter: { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"], models: { "moonshotai/kimi-k3": { id: "moonshotai/kimi-k3", name: "Kimi K3" } } },
  "zai-coding-plan": { id: "zai-coding-plan", name: "Z.AI Coding Plan", env: ["ZHIPU_API_KEY"], models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" } } },
  mistral: { id: "mistral", name: "Mistral", env: ["MISTRAL_API_KEY"], models: { "mistral-large-3": { id: "mistral-large-3", name: "Mistral Large 3" } } },
};

const inputs = (over: Partial<CatalogInputs> = {}): CatalogInputs => ({
  dev,
  clis: ["claude", "agy", "kimi", "zcode", "opencode"].map((cli: any) => ({ cli, usable: true, models: [] })),
  lists: {
    claude: [{ id: "opus" }, { id: "claude-opus-5-5" }],
    agy: [{ id: "gemini-4-argon-low" }, { id: "gemini-4-argon-high" }, { id: "claude-opus-5-5-high" }],
    kimi: [{ id: "or/kimi", key: "openrouter/moonshotai/kimi-k3" }],
    zcode: [{ id: "account:zai-individual-coding-plan/GLM-5.3", key: "zai-coding-plan/glm-5.3" }],
    opencode: [{ id: "openrouter/moonshotai/kimi-k3" }],
  },
  config: { harnesses: DEFAULT_HARNESS_ORDER, favourites: ["mistral/mistral-large-3"], providers: {} },
  recent: { "openrouter/moonshotai/kimi-k3": 5 },
  env: { OPENROUTER_API_KEY: "x" },
  ...over,
});

const get = (c: ReturnType<typeof buildCatalog>, key: string) => c.models.find((m) => m.key === key)!;

describe("buildCatalog", () => {
  it("routes each model to every harness that can run it, the preferred harness first", () => {
    const c = buildCatalog(inputs());
    const opus = get(c, "anthropic/claude-opus-5-5");
    expect(opus.routes.map((r) => [r.harness, r.id, r.label])).toEqual([
      ["claude", "claude-opus-5-5", undefined],
      ["agy", "claude-opus-5-5-high", "high, via Antigravity"],
      ["opencode", "anthropic/claude-opus-5-5", undefined],
    ]);
    expect(opus.routes.at(-1)).toMatchObject({ ready: false, needs: "set ANTHROPIC_API_KEY" });
    expect(opus).toMatchObject({ runnable: true, context: 1_000_000, cost: { input: 5, output: 25 }, reasoning: true });
  });

  it("folds agy's effort levels into one entry, and matches ids spelled differently", () => {
    const c = buildCatalog(inputs());
    expect(get(c, "google/gemini-4-argon").routes.filter((r) => r.harness === "agy").map((r) => r.label)).toEqual(["low", "high"]);
    expect(c.models.some((m) => m.key.includes("argon-low"))).toBe(false);
    expect(get(c, "zai-coding-plan/glm-5.3").routes[0]).toMatchObject({ harness: "zcode", id: "account:zai-individual-coding-plan/GLM-5.3", ready: true });
  });

  it("puts runnable models first and marks what a key would unlock", () => {
    const c = buildCatalog(inputs());
    const firstDim = c.models.findIndex((m) => !m.runnable);
    expect(c.models.slice(firstDim).every((m) => !m.runnable)).toBe(true);
    expect(get(c, "mistral/mistral-large-3")).toMatchObject({ runnable: false, favourite: true, routes: [{ harness: "opencode", needs: "set MISTRAL_API_KEY" }] });
    expect(get(c, "openrouter/moonshotai/kimi-k3")).toMatchObject({ runnable: true, lastUsed: 5 });
  });

  it("honours a key kept under the human's own env var name", () => {
    const c = buildCatalog(inputs({ config: { harnesses: DEFAULT_HARNESS_ORDER, favourites: [], providers: { mistral: { env: "MY_MISTRAL" } } }, env: { MY_MISTRAL: "k" } }));
    expect(get(c, "mistral/mistral-large-3").runnable).toBe(true);
    expect(c.providers.find((p) => p.id === "mistral")).toMatchObject({ keySet: true, keyVar: "MY_MISTRAL" });
  });

  it("runs custom providers and a local ollama through opencode, and hides hidden providers", () => {
    const c = buildCatalog(
      inputs({
        config: { harnesses: DEFAULT_HARNESS_ORDER, favourites: [], providers: { lmstudio: { name: "LM Studio", baseUrl: "http://localhost:1234/v1", models: ["qwen3-coder"] }, mistral: { hidden: true } } },
        ollama: ["llama3:8b"],
      }),
    );
    expect(get(c, "lmstudio/qwen3-coder")).toMatchObject({ providerName: "LM Studio", runnable: true, routes: [{ harness: "opencode", id: "lmstudio/qwen3-coder" }] });
    expect(get(c, "ollama/llama3:8b").runnable).toBe(true);
    expect(c.models.some((m) => m.provider === "mistral")).toBe(false);
  });

  it("orders harnesses as the human asked", () => {
    const c = buildCatalog(inputs({ config: { harnesses: ["opencode", ...DEFAULT_HARNESS_ORDER.filter((h) => h !== "opencode")], favourites: [], providers: {} } }));
    expect(get(c, "openrouter/moonshotai/kimi-k3").routes[0].harness).toBe("opencode");
    expect(c.harnesses[0]).toMatchObject({ cli: "opencode", anyProvider: true });
  });

  it("has a mock catalog for the TUI's mock mode", () => {
    const c = mockCatalog();
    expect(c.models.filter((m) => m.runnable).length).toBeGreaterThan(3);
    expect(c.models.some((m) => !m.runnable)).toBe(true);
  });
});

describe("providers.toml", () => {
  it("round-trips, keeps the header, and fills in the default harness order", () => {
    const dir = mkdtempSync(join(tmpdir(), "prov-"));
    writeProviders({ harnesses: ["opencode"], favourites: ["a/b"], providers: { lmstudio: { name: "LM Studio", baseUrl: "http://x/v1", models: ["m"] }, openrouter: { env: "MY_OR" } } }, dir);
    const text = readFileSync(join(dir, "providers.toml"), "utf8");
    expect(text).toMatch(/^# Quorum's providers/);
    expect(text).toContain('base_url = "http://x/v1"');
    const f = readProviders(dir);
    expect(f.harnesses[0]).toBe("opencode");
    expect(f.harnesses).toEqual(expect.arrayContaining(DEFAULT_HARNESS_ORDER));
    expect(f.providers.lmstudio).toEqual({ name: "LM Studio", baseUrl: "http://x/v1", models: ["m"] });
    updateProviders((x) => x.favourites.push("c/d"), dir);
    expect(readProviders(dir).favourites).toEqual(["a/b", "c/d"]);
  });

  it("reads a broken file as defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "prov-"));
    writeFileSync(join(dir, "providers.toml"), "harnesses = [");
    expect(readProviders(dir)).toEqual({ harnesses: DEFAULT_HARNESS_ORDER, favourites: [], providers: {} });
  });

  it("exposes a key under the name harnesses expect, never overriding one already set", () => {
    const env: NodeJS.ProcessEnv = { MY_OR: "k", MISTRAL_API_KEY: "mine", MY_MISTRAL: "other" };
    applyProviderEnv((p) => ({ openrouter: "OPENROUTER_API_KEY", mistral: "MISTRAL_API_KEY" })[p], { harnesses: [], favourites: [], providers: { openrouter: { env: "MY_OR" }, mistral: { env: "MY_MISTRAL" } } }, env);
    expect(env.OPENROUTER_API_KEY).toBe("k");
    expect(env.MISTRAL_API_KEY).toBe("mine");
  });

  it("keeps the most recent picks", () => {
    const file = join(mkdtempSync(join(tmpdir(), "recent-")), "r.json");
    noteRecent("a/b", file, 1);
    noteRecent("c/d", file, 2);
    expect(readRecent(file)).toEqual({ "c/d": 2, "a/b": 1 });
  });
});

describe("custom providers in opencode", () => {
  it("configures the model's provider only when opencode wouldn't know it", () => {
    const f = { harnesses: [], favourites: [], providers: { lmstudio: { name: "LM Studio", baseUrl: "http://x/v1", env: "LM_KEY", models: ["a"] } } };
    expect(customProvider("lmstudio/b", f).provider).toEqual({
      lmstudio: { npm: "@ai-sdk/openai-compatible", name: "LM Studio", options: { baseURL: "http://x/v1", apiKey: "{env:LM_KEY}" }, models: { a: {}, b: {} } },
    });
    expect((customProvider("ollama/llama3:8b", f).provider as any).ollama.options.baseURL).toBe("http://localhost:11434/v1");
    expect(customProvider("anthropic/claude-opus-5-5", f)).toEqual({});
  });
});

describe("harness model lists", () => {
  it("reads Kimi's aliases, default first", () => {
    const file = join(mkdtempSync(join(tmpdir(), "kimi-")), "config.toml");
    writeFileSync(file, `default_model = "b"\n[models.a]\nprovider = "openrouter"\nmodel = "x/a"\n[models.b]\nprovider = "openrouter"\nmodel = "x/b"\n`);
    expect(kimiModels(file)).toEqual([
      { id: "b", label: "x/b via openrouter", key: "openrouter/x/b" },
      { id: "a", label: "x/a via openrouter", key: "openrouter/x/a" },
    ]);
  });

  it("reads ZCode's configured providers against its built-in model table", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-"));
    writeFileSync(join(root, "provider_config.json"), JSON.stringify({ config: { defaultModelSelection: { providerId: "account:zai-plan", modelId: "GLM-5.3" }, providerConfigRules: { providerRules: [] } } }));
    const dir = join(root, "runtime", "provider", "linux", "1.0.0", "endpoint-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "zcode-builtin.json"), JSON.stringify({ config: { modelConfigRules: { templateModelRules: [
      { templateId: "zai-api", modelId: "GLM-5.3" }, { templateId: "zai-api", modelId: "GLM-5.3-Flash" }, { templateId: "zai-api", modelId: "GLM-4", config: { enabled: false } },
    ] } } }));
    expect(zcodeModels(root)).toEqual([
      { id: "account:zai-plan/GLM-5.3", key: "zai-coding-plan/glm-5.3", label: "ZCode's default" },
      { id: "account:zai-plan/GLM-5.3-Flash", key: "zai-coding-plan/glm-5.3-flash" },
    ]);
  });

  it("parses `ollama list`", () => {
    expect(parseOllamaList("NAME\tID\tSIZE\nllama2:latest\tfe93\t3.8 GB\nqwen3:8b\tab\t5 GB\n")).toEqual(["llama2:latest", "qwen3:8b"]);
  });
});
