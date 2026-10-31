import { afterEach, describe, expect, it } from "vitest";
import { checkEdit } from "../src/room/room.js";
import { assistantActions, renderEvent, setupPrompt } from "../src/room/prompts.js";
import { Workspace } from "../src/room/workspace.js";
import { rig } from "./roomRig.js";

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
});
const setup = (o: Parameters<typeof rig>[0] = {}) => {
  const r = rig(o);
  cleanup.push(r.closeAll);
  return r;
};

describe("Editing a suggestion before approving it", () => {
  it("carries out the human's version and logs what changed", async () => {
    const r = setup({ member: () => "PASS", assistant: ["x\n>> hire: qa | mock | QA lead | Breaks things. | nobody tests"] });
    const room = r.create();
    await room.ask("who's missing?");
    const sug = room.pending()[0];
    await room.resolve(sug.id, true, ["qa-lead", "mock", "sonnet", "QA lead", "Breaks things on purpose, then writes it down."]);
    expect(room.store.config().agents.find((a) => a.id === "qa-lead")).toMatchObject({ cli: "mock", model: "sonnet" });
    expect(room.store.events().at(-1)).toMatchObject({ type: "suggestion.resolved", id: sug.id, accepted: true, args: ["qa-lead", "mock", "sonnet", "QA lead", "Breaks things on purpose, then writes it down."] });
  });

  it("logs no args when approved as proposed, and refuses edits missing what's required", async () => {
    expect(() => checkEdit("hire", ["a", "mock", "", "r", "p"], ["a", "", "", "r", "p"])).toThrow(/needs its harness/);
    expect(() => checkEdit("hire", ["a", "mock", "", "r", "p"], ["Bad Name", "mock", "", "r", "p"])).toThrow(/lowercase/);
    expect(() => checkEdit("parallel", ["2"], ["zero"])).toThrow(/number/);
    expect(checkEdit("steer", ["old"], ["new words", "ignored"])).toEqual(["new words"]);
    const r = setup({ member: () => "PASS", assistant: ["x\n>> steer: focus on tenants"] });
    const room = r.create();
    await room.ask("what now?");
    await room.resolve(room.pending()[0].id, true, ["focus on tenants"]);
    expect(room.store.events().at(-1)).not.toHaveProperty("args");
  });
});

describe("Swapping a member's model", () => {
  it("is something the assistant can suggest, and approving it moves the member while keeping its memory", async () => {
    const r = setup({ member: () => "noted", assistant: ["The architect needs more judgment.\n>> swap: arch | mock opus | design calls need the strongest model"] });
    const room = r.create();
    room.post("go");
    room.resume();
    await room.settled();
    room.pause();
    room.store.writeNotebook("arch", "remember: LRU");
    expect(room.store.agentState("arch").sessionId).toBeDefined();
    await room.ask("is the lineup right?");
    const sug = room.pending().find((s) => s.action === "swap")!;
    expect(sug).toMatchObject({ args: ["arch", "mock", "opus"], why: "design calls need the strongest model" });
    await room.resolve(sug.id, true);
    expect(room.store.config().agents.find((a) => a.id === "arch")).toMatchObject({ cli: "mock", model: "opus" });
    expect(room.store.agentState("arch").sessionId).toBeUndefined();
    expect(room.store.notebook("arch")).toContain("remember: LRU");
    const ev = room.store.events().find((e) => e.type === "agent.swapped")!;
    expect(ev).toMatchObject({ agent: "arch", cli: "mock", model: "opus", was: { cli: "mock" } });
    expect(renderEvent(ev)).toContain("arch now runs on mock opus");
  });

  it("swaps a support role's model, and a workspace member's record follows", () => {
    const r = setup();
    const room = r.create();
    room.swapModel("scribe", "mock", "haiku");
    expect(room.store.config().support.scribe).toEqual({ cli: "mock", model: "haiku" });
    new Workspace(r.repo).saveMember({ id: "arch", cli: "mock", persona: "architect" });
    room.swapModel("arch", "mock", "sonnet");
    expect(new Workspace(r.repo).members().find((m) => m.id === "arch")).toMatchObject({ model: "sonnet" });
    expect(() => room.swapModel("nobody", "mock")).toThrow(/no member/);
    const mockOnly = r.create({ clis: ["mock"] });
    expect(() => mockOnly.swapModel("arch", "claude")).toThrow(/isn't available here/);
  });
});

describe("Model guidance", () => {
  it("tells the assistant to pick models on purpose, with the menu when there is one", () => {
    const menu = "- claude claude-opus-5-5 — Claude Opus 5.5 (Anthropic): 1M context";
    const a = assistantActions(["claude", "kimi"], [], menu);
    expect(a).toContain("chosen on purpose");
    expect(a).toContain(menu);
    expect(a).toContain(">> swap: <member> | <cli> <model>");
    expect(assistantActions(["claude"], [])).not.toContain("Models you can run now");
    const s = setupPrompt({ repo: "/r", members: [], channels: [], clis: ["claude"], personas: [], history: [], models: menu });
    expect(s).toContain(menu);
  });

  it("puts the room's model menu in the assistant's prompt", async () => {
    const r = setup({ member: () => "PASS", assistant: ["ok"] });
    const room = r.create({ modelMenu: () => "- mock opus — the strong one" });
    await room.ask("who should we add?");
    const call = r.calls.find((c) => c.agent === "assistant")!;
    expect(call.prompt + (call.opts?.systemPrompt ?? "")).toContain("- mock opus — the strong one");
  });
});

describe("Spelling out the default model", () => {
  it("fills in the harness's default where the assistant named no model", async () => {
    const r = setup({ member: () => "PASS", assistant: ["x\n>> hire: qa | mock | QA lead | Breaks things. | nobody tests\n>> swap: arch | mock | cheaper"] });
    const room = r.create({ defaultModel: (cli) => (cli === "mock" ? "mock-large" : undefined) });
    await room.ask("who's missing?");
    expect(room.pending().map((s) => s.args.slice(0, 3))).toEqual([["qa", "mock", "mock-large"], ["arch", "mock", "mock-large"]]);
  });

  it("fills in older suggestions saved without a model, and pins it on approval", async () => {
    const r = setup({ member: () => "PASS" });
    const room = r.create({ defaultModel: (cli) => (cli === "mock" ? "mock-large" : undefined) });
    room.store.append({ type: "suggestion", id: 1, from: "assistant", action: "hire", args: ["qa", "mock", "", "QA lead", "Breaks things."], why: "" });
    expect(room.pending()[0].args).toEqual(["qa", "mock", "mock-large", "QA lead", "Breaks things."]);
    await room.resolve(1, true);
    expect(room.store.config().agents.find((a) => a.id === "qa")).toMatchObject({ cli: "mock", model: "mock-large" });
  });

  it("reads each harness's default from its own settings", async () => {
    const { defaultModel } = await import("../src/models.js");
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(tmpdir(), "qhome-"));
    const put = (f: string, text: string) => (mkdirSync(join(home, f, ".."), { recursive: true }), writeFileSync(join(home, f), text));
    put(".claude/settings.json", `{"model": "opus"}`);
    put(".codex/config.toml", `model = "gpt-6-astra"\n`);
    put(".gemini/antigravity-cli/settings.json", `{"model": "Gemini 4 Argon (Medium)"}`);
    put(".kimi-code/config.toml", `default_model = "k3"\n`);
    put(".zcode/v2/provider_config.json", `{"config":{"defaultModelSelection":{"providerId":"account:zai","modelId":"GLM-5.3"}}}`);
    put(".config/opencode/opencode.jsonc", `{\n  // mine\n  "model": "openrouter/qwen/qwen3"\n}`);
    expect(defaultModel("claude", home, {})).toBe("claude-opus-5-5");
    expect(defaultModel("claude", home, { ANTHROPIC_MODEL: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(defaultModel("codex", home, {})).toBe("gpt-6-astra");
    expect(defaultModel("agy", home, {})).toBe("gemini-4-argon-medium");
    expect(defaultModel("kimi", home, {})).toBe("k3");
    expect(defaultModel("zcode", home, {})).toBe("account:zai/GLM-5.3");
    expect(defaultModel("opencode", home, {})).toBe("openrouter/qwen/qwen3");
    expect(defaultModel("gemini", home, { PATH: "" })).toBeUndefined();
    rmSync(join(home, ".config/opencode/opencode.jsonc"));
    put(".local/state/opencode/model.json", `{"recent":[{"providerID":"openrouter","modelID":"qwen/qwen3-coder-next"}]}`);
    expect(defaultModel("opencode", home, {})).toBe("openrouter/qwen/qwen3-coder-next");
  });
});
