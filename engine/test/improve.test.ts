import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCalls, type CallRow } from "../src/improve/calls.js";
import { checkReply, fingerprint } from "../src/improve/purposes.js";
import { analyze, autoReport, diagnosePrompt, formatHealth } from "../src/improve/report.js";
import { messages, rig } from "./roomRig.js";

describe("prompt rules", () => {
  it("catches a card that runs long", () => {
    const good = "Kimi found that resizing deletes content. It breaks undo.\n\n- shrink drops tiles\n- undo can't restore them";
    expect(checkReply("card", good)).toEqual([]);
    const bad = `Kimi found a thing. It matters. Here is why. And more.\n\n- a\n- b\n- c\n- d\n- e\n\n\`\`\`\n1\n2\n3\n4\n5\n6\n7\n\`\`\``;
    expect(checkReply("card", bad)).toEqual(expect.arrayContaining(["4 sentences in the paragraph, asked for at most two", "5 bullets, asked for two or three", "diagram of 7 lines, asked for at most five"]));
  });

  it("catches long gists, unknown actions, and empty replies", () => {
    expect(checkReply("highlights", '{"highlights":[{"msg":3,"gist":"found that the resize step silently deletes all content outside"}]}')).toEqual(["1 gist over 8 words"]);
    expect(checkReply("highlights", "sure!")).toEqual(["no JSON highlights list"]);
    expect(checkReply("assistant.watch", "Fine.\n>> hire: x | claude | r | p | w\n>> fire: kimi")).toEqual(['unknown action ">> fire"']);
    expect(checkReply("assistant.watch", "Fine.\n>> write: plan | v1\n# Plan\nlots of words here\n>> end")).toEqual([]);
    expect(checkReply("chair", "   ")).toEqual(["empty reply"]);
  });

  it("versions each prompt by its own code", () => {
    expect(fingerprint("card")).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint("card")).toBe(fingerprint("card"));
    expect(fingerprint("card")).not.toBe(fingerprint("highlights"));
  });
});

describe("the call log", () => {
  it("keeps each call with its prompt and the message it became, and shows the prompt behind a message", async () => {
    const r = rig({ floor: () => [], member: (a) => (a === "skeptic" ? "Two sentences. Of substance." : "PASS") });
    try {
      const room = r.create({ topic: undefined });
      room.resume();
      room.post("@skeptic what would break?");
      await room.settled();
      const { calls } = readCalls(room.store.dir);
      const said = messages(room).find((e) => e.type === "message" && e.from === "skeptic")!;
      const turn = calls.find((c) => c.agent === "skeptic")!;
      expect(turn).toMatchObject({ role: "member", purpose: "member", version: fingerprint("member"), cli: "mock", reply: "Two sentences. Of substance.", seq: said.seq });
      expect(turn.prompt).toMatch(/what would break/);
      // The persona is the system prompt, kept once by hash.
      expect(readFileSync(join(room.store.dir, "prompts", `${turn.system}.txt`), "utf8")).toMatch(/skeptic|Skeptic/);
      const md = room.promptFor(said.seq);
      expect(md).toMatch(/^# The prompt behind #\d+/);
      expect(md).toMatch(/what would break/);
      expect(() => room.promptFor(9999)).toThrow();
      expect(room.improve()).toMatch(/Prompt health in #/);
    } finally {
      await r.closeAll();
    }
  });
});

let n = 0;
function row(o: Partial<CallRow> & { purpose: CallRow["purpose"] }): CallRow {
  n++;
  return { n, ts: 1_000_000 + n * 1000, ms: 2000, agent: "assistant", role: "support", version: "v1", cli: "claude", system: "s", prompt: "p", reply: "r", ...o };
}

function roomDir(rows: CallRow[], events: object[] = []): string {
  const dir = join(mkdtempSync(join(tmpdir(), "quorum-improve-")), "proj", ".quorum", "rooms", "r1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "room.json"), JSON.stringify({ name: "probe" }));
  writeFileSync(join(dir, "calls.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(dir, "events.jsonl"), events.map((e, i) => JSON.stringify({ seq: i + 1, ts: new Date(2_000_000 + i).toISOString(), ...e })).join("\n") + "\n");
  return dir;
}

describe("the prompt-health report", () => {
  it("flags a prompt whose replies break its rules, and shows a prompt edit helped", () => {
    const bad = (v: string) => row({ purpose: "card", version: v, problems: ["5 bullets, asked for two or three"] });
    const ok = (v: string) => row({ purpose: "card", version: v });
    const before = roomDir([bad("v1"), bad("v1"), bad("v1"), bad("v1"), ok("v1"), bad("v2"), ok("v2"), ok("v2"), ok("v2"), ok("v2")]);
    const h = analyze([before]);
    const card = h.purposes.find((p) => p.purpose === "card")!;
    expect(card.versions.map((v) => [v.version, v.calls, v.offFormat])).toEqual([["v1", 5, 4], ["v2", 5, 1]]);
    expect(card.versions[0].problems).toEqual([["N bullets, asked for two or three", 4]]);
    expect(h.findings).toContainEqual({ purpose: "card", level: "ok", text: "Improved after the prompt changed (v1 → v2): off-format 80% → 20%." });
    expect(h.findings).toContainEqual(expect.objectContaining({ purpose: "card", level: "watch" }));
    const md = formatHealth(h);
    expect(md).toMatch(/\| \*\*card\*\* \| v2 \| 5 \| 0 \| 20% \|/);
    expect(md).toMatch(/engine\/src\/room\/floor.ts highlightCardPrompt/);
    expect(diagnosePrompt(h)).toMatch(/## card: the hover card/);

    const worse = roomDir([ok("v1"), ok("v1"), ok("v1"), ok("v1"), ok("v1"), bad("v2"), bad("v2"), bad("v2"), ok("v2"), ok("v2")]);
    expect(analyze([worse]).findings).toContainEqual({ purpose: "card", level: "poor", text: "Got worse after the prompt changed (v1 → v2): off-format 0% → 60%." });
  });

  it("credits suggestions to the assistant's prompt, counts passes against the floor, and quotes pushback", () => {
    const watch = row({ purpose: "assistant.watch", ts: 1000, ms: 10 });
    const passes = Array.from({ length: 10 }, (_, i) => row({ purpose: "member", agent: "kimi", role: "member", reply: i < 5 ? "PASS" : "A view." }));
    const dir = roomDir([watch, ...passes], [
      ...[1, 2, 3, 4].flatMap((id) => [{ type: "suggestion", id, from: "assistant", action: "add", args: [], why: "" }, { type: "suggestion.resolved", id, accepted: id === 1 }]),
      { type: "message", from: "human", to: "assistant", text: "That card is way too wordy and confusing." },
    ]);
    const h = analyze([dir]);
    const w = h.purposes.find((p) => p.purpose === "assistant.watch")!.versions[0];
    expect(w.outcome).toBe("4 suggestions: 1 accepted, 3 declined, 0 withdrawn");
    expect(h.findings.map((f) => f.text)).toEqual(expect.arrayContaining(["The human declined 3 of 4 suggestions they answered.", "5 of 10 member turns were passes: the floor woke members who had nothing to add."]));
    expect(h.pushback).toEqual([{ room: "proj/probe", seq: 9, text: "That card is way too wordy and confusing." }]);
  });

  it("writes a daily report and mails Quorum's developers only about prompts newly flagged", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ purpose: "card", ...(i % 2 ? { problems: ["5 bullets, asked for two or three"] } : {}) }));
    const dir = roomDir(rows);
    const root = mkdtempSync(join(tmpdir(), "quorum-src-"));
    mkdirSync(join(root, "engine", "src", "improve"), { recursive: true });
    const day = Date.parse("2026-11-02T12:00:00Z");
    const file = autoReport({ now: day, root, rooms: [dir] })!;
    expect(file).toMatch(/2026-11-02\.md$/);
    expect(readFileSync(file, "utf8")).toMatch(/✗ \*\*card:\*\* 20 of 40 replies broke the prompt's rules/);
    const mail = () => readdirSync(join(root, ".quorum", "mail")).filter((f) => f.endsWith(".md") && f !== "README.md");
    expect(mail()).toHaveLength(1);
    expect(readFileSync(join(root, ".quorum", "mail", mail()[0]), "utf8")).toMatch(/to: all\nfrom: quorum[\s\S]*Prompt health: 1 prompt needs work/);
    // Too soon: nothing. A day later with no new calls: nothing.
    expect(autoReport({ now: day + 3600_000, root, rooms: [dir] })).toBeUndefined();
    expect(autoReport({ now: day + 2 * 86_400_000, root, rooms: [dir] })).toBeUndefined();
    // New calls, same finding: a report, but no second mail.
    writeFileSync(join(dir, "calls.jsonl"), [...rows, ...rows.map((r) => ({ ...r, n: r.n + 1000 }))].map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(autoReport({ now: day + 3 * 86_400_000, root, rooms: [dir] })).toBeDefined();
    expect(mail()).toHaveLength(1);
    expect(existsSync(join(root, ".quorum", "mail", "README.md"))).toBe(true);
  });
});
