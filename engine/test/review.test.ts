import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { floorPrompt } from "../src/room/floor.js";
import { parseSetup } from "../src/room/prompts.js";
import { changedSections, lineDiff, sections, sectionText, unifiedDiff } from "../src/room/review.js";
import { ENGINE_BUILD } from "../src/room/room.js";
import { messages, rig } from "./roomRig.js";

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

const V1 = "# Plan\n\n## Cache\nUse an LRU.\n\n## Rollout\nShip it.";
const V2 = "# Plan\n\n## Cache\nUse an LRU with a 30 s TTL.\n\n## Rollout\nShip it.";

/** arch drafts plan v1, answers questions, and saves v2 when asked to revise; skeptic passes. */
const author = (agent: string, n: number, prompt: string) => {
  if (agent !== "arch") return "PASS";
  if (n === 1) return { tools: [["doc_draft", { name: "plan", kind: "plan", text: V1 }]] as [string, Record<string, unknown>][], say: "Drafted plan v1." };
  if (prompt.includes("please revise")) return { tools: [["doc_draft", { name: "plan", kind: "plan", text: V2, note: "TTL" }]] as [string, Record<string, unknown>][], say: "Saved v2 with the TTL." };
  if (prompt.includes("Question about plan")) return "An LRU because reads are 90% by id.";
  return "PASS";
};

/** A room where arch drafted the plan and the Chair put v1 up for review. */
async function underReview() {
  const r = setup({ member: author, chair: ["Agreed.\n>> accept: plan v1", "PASS"] });
  const room = r.create({ parallel: 1 });
  room.resume();
  await room.settled();
  return { r, room };
}

describe("document review", () => {
  it("the Chair only puts a version up for review, and the status says so", async () => {
    const { room } = await underReview();
    expect(room.docs()[0]).toMatchObject({ slug: "plan", version: 1, ready: 1, by: "arch" });
    expect(room.docs()[0].accepted).toBeUndefined();
    expect(room.state).toBe("paused");
    expect(room.status().line).toBe("paused · review plan v1");
    expect(room.status().detail).toContain("Waiting on the human: review of plan v1.");
  });

  it("approving accepts the version, closes open workstreams, and offers an export path", async () => {
    const { room } = await underReview();
    const ws = room.workstream("Edge cases", "a list", ["skeptic"]);
    room.pause();
    expect(room.review("plan", "approve")).toEqual({ version: 1, exportPath: "docs/plan.md" });
    expect(room.docs()[0]).toMatchObject({ accepted: 1, reviewed: 1 });
    expect(room.workstreams().find((w) => w.thread === ws)?.settled).toBe(true);
    expect(room.store.events().filter((e) => e.type === "doc.accepted")).toMatchObject([{ slug: "plan", version: 1, by: "human" }]);
    expect(room.status().line).not.toContain("review");
  });

  it("a question goes to the authors, and the room pauses again once it's answered", async () => {
    const { room } = await underReview();
    room.review("plan", "clarify", { section: "Cache", text: "why an LRU?" });
    await room.settled();
    const ask = messages(room).find((e) => e.type === "message" && e.from === "human" && e.text.includes("Question about"));
    expect(ask && ask.type === "message" && ask.text).toBe('@arch Question about plan v1, section "Cache". Answer it; change the document only if the answer shows it\'s wrong.\n\nwhy an LRU?');
    expect(messages(room).some((e) => e.type === "message" && e.from === "arch" && e.text.includes("90% by id"))).toBe(true);
    expect(room.state).toBe("paused");
    expect(room.store.events().filter((e) => e.type === "paused").at(-1)).toMatchObject({ reason: "review: answers on plan" });
    // Still the same version under review.
    expect(room.docs()[0]).toMatchObject({ version: 1, ready: 1, reviewed: 1 });
  });

  it("changes go to the latest author, and the new version comes back for review", async () => {
    const { room } = await underReview();
    room.review("plan", "revise", { section: "Cache", text: "add a TTL" });
    await room.settled();
    expect(room.docs()[0]).toMatchObject({ version: 2, ready: 2, reviewed: 1 });
    expect(room.state).toBe("paused");
    expect(room.store.events().filter((e) => e.type === "paused").at(-1)).toMatchObject({ reason: "ready for review: plan v2" });
  });

  it("refuses feedback with nothing in it, and unknown documents or versions", async () => {
    const { room } = await underReview();
    expect(() => room.review("plan", "revise", { text: " " })).toThrow("say what to change");
    expect(() => room.review("nope", "approve")).toThrow('no document "nope"');
    expect(() => room.review("plan", "approve", { version: 9 })).toThrow("plan has no v9");
  });

  it("the assistant sees the open document, the section, and the diff from the last reviewed version", async () => {
    const r = setup({ member: author, chair: ["Agreed.\n>> accept: plan v1", "PASS"], assistant: ["The TTL bounds staleness."] });
    const room = r.create({ parallel: 1 });
    room.resume();
    await room.settled();
    room.review("plan", "revise", { text: "add a TTL" });
    await room.settled();
    await room.ask("why the TTL?", undefined, { slug: "plan", version: 2, section: "Cache" });
    const prompt = r.calls.filter((c) => c.agent === "assistant").at(-1)!.prompt;
    expect(prompt).toContain('The human has plan v2 open for review and is looking at the section "Cache".');
    expect(prompt).toContain("That section:\n\n## Cache\nUse an LRU with a 30 s TTL.");
    expect(prompt).toContain("What changed since v1, the version they last reviewed:");
    expect(prompt).toContain("+ Use an LRU with a 30 s TTL.");
    expect(prompt).toContain("Live state (from the engine, always current):\nRoom: paused (ready for review: plan v2).");
  });
});

const BRIEF = "**What it is:** a plan for the cache; nothing is built yet.\n**What it says:**\n- use an LRU\n**If you approve:** someone still has to build it.";

describe("the brief", () => {
  it("the assistant writes a plain-English brief of each version that comes up for review", async () => {
    const r = setup({ member: author, chair: ["Agreed.\n>> accept: plan v1", "PASS"], assistant: [BRIEF] });
    const room = r.create({ parallel: 1 });
    room.resume();
    await room.settled();
    expect(room.briefOf("plan", 1)).toBe(BRIEF);
    // Opening it again doesn't write another; a draft nobody put up for review doesn't get one.
    expect(room.ensureBrief("plan", 1)).toBe(false);
    room.writeDoc("plan", "# Plan\n\nDraft two.", "arch");
    expect(room.ensureBrief("plan", 2)).toBe(false);
    const prompt = r.calls.find((c) => c.agent === "assistant" && c.prompt.includes("Write them a brief"))!.prompt;
    expect(prompt).toContain("## Cache\nUse an LRU.");
    expect(prompt).toContain("whether it records things already done or proposes things nobody has done yet");
    // Members never see it; it's for the human.
    expect(r.memberCalls().some((c) => c.prompt.includes("nothing is built yet"))).toBe(false);
  });
});

describe("after approval", () => {
  it("offers the path a pending export suggestion named, and exporting withdraws the other copies", async () => {
    const { room } = await underReview();
    (room as any).suggest("assistant", "export", ["plan", "docs/research/plan.md"], "publish it");
    (room as any).suggest("assistant", "export", ["plan", "docs/plan-copy.md"], "publish it again");
    expect(room.review("plan", "approve").exportPath).toBe("docs/research/plan.md");
    expect(room.exportDoc("plan", "docs/research/plan.md")).toBe("docs/research/plan.md");
    expect(room.pending().filter((s) => s.action === "export")).toEqual([]);
    expect(room.store.events().filter((e) => e.type === "doc.exported")).toMatchObject([{ slug: "plan", version: 1, path: "docs/research/plan.md" }]);
    // The next time, it goes where it went before.
    expect((room as any).exportPathFor("plan")).toBe("docs/research/plan.md");
  });

  it("approving an export suggestion resolves it once, as approved", async () => {
    const { room } = await underReview();
    room.review("plan", "approve");
    (room as any).suggest("assistant", "export", ["plan", "docs/plan.md"], "publish it");
    const id = room.pending().find((s) => s.action === "export")!.id;
    await room.resolve(id, true);
    expect(room.store.events().filter((e) => e.type === "suggestion.resolved" && e.id === id)).toMatchObject([{ accepted: true }]);
  });

  it("hands the document to the project's agents as mail, with the brief and where to read it", async () => {
    const r = setup({ member: author, chair: ["Agreed.\n>> accept: plan v1", "PASS"], assistant: [BRIEF] });
    const room = r.create({ parallel: 1 });
    room.resume();
    await room.settled();
    room.review("plan", "approve");
    room.exportDoc("plan", "docs/plan.md");
    const { file, path } = room.handoff("plan");
    expect(path).toBe("docs/plan.md");
    const mail = readFileSync(join(r.repo, ".quorum", "mail", file), "utf8");
    expect(mail).toContain("Carry out plan v1");
    expect(mail).toContain("Read it: docs/plan.md");
    expect(mail).toContain("nothing is built yet");
    expect(room.store.events().filter((e) => e.type === "mail.out")).toMatchObject([{ to: "all", by: "human" }]);
  });

  it("a version accepted before briefs existed gets one when it's opened", async () => {
    const { room } = await underReview(); // its assistant has nothing to say, so v1 has no brief
    expect(room.briefOf("plan", 1)).toBeUndefined();
    expect(room.ensureBrief("plan", 1)).toBe(true);
  });

  it("without an export, the mail points at the channel's own copy", async () => {
    const { room } = await underReview();
    room.review("plan", "approve");
    expect(room.handoff("plan").path).toMatch(/^\.quorum\/rooms\/.+\/outputs\/plan\/v1\.md$/);
  });
});

describe("pausing", () => {
  it("the assistant's pause lets the turns underway finish; nothing is cut off", async () => {
    const r = setup({ delayMs: 30 });
    const room = r.create({ parallel: 2 });
    room.resume();
    await new Promise((res) => setTimeout(res, 10));
    room.pauseAfterTurns("assistant: converged");
    expect(room.status().line).toContain("pausing when they finish");
    await room.settled();
    const es = room.store.events();
    expect(es.filter((e) => e.type === "turn.aborted")).toEqual([]);
    const paused = es.findIndex((e) => e.type === "paused");
    expect(es.slice(0, paused).filter((e) => e.type === "message" && e.from !== "human").length).toBe(2);
    expect(es[paused]).toMatchObject({ reason: "assistant: converged" });
  });

  it("the human's pause cuts turns off at once, and says so in the log", async () => {
    const r = setup({ delayMs: 30 });
    const room = r.create({ parallel: 1 });
    room.resume();
    await new Promise((res) => setTimeout(res, 10));
    room.pause();
    await room.settled();
    expect(room.store.events().filter((e) => e.type === "turn.aborted")).toMatchObject([{ reason: "paused by the human", replyTo: 3 }]);
  });
});

describe("support calls", () => {
  it("floor, scribe and Chair run without tools or the file-access note; the assistant keeps both", async () => {
    const r = setup({ member: author, chair: ["Agreed.\n>> accept: plan v1", "PASS"] });
    const room = r.create({ parallel: 1 });
    room.resume();
    await room.settled();
    const chair = r.calls.find((c) => c.agent === "chair")!;
    expect(chair.opts?.noTools).toBe(true);
    expect(chair.opts?.systemPrompt).not.toContain("You can read files");
    const assistant = r.calls.find((c) => c.agent === "assistant")!;
    expect(assistant.opts?.noTools).toBeUndefined();
    expect(assistant.opts?.systemPrompt).toContain("only the human puts one into the project");
  });

  it("the floor sees who is already queued", () => {
    const view = { topic: "t", topics: [], docs: [], members: ["arch", "skeptic"] };
    const p = floorPrompt({ view, members: [{ id: "arch", role: "a" }, { id: "skeptic", role: "s" }], speaking: ["arch"], queued: ["skeptic"], fresh: [], recent: [], max: 2 });
    expect(p).toContain("- arch: a (speaking right now)");
    expect(p).toContain("- skeptic: s (already queued to speak)");
  });

  it("each sitting records the engine build that ran it", async () => {
    const { room } = await underReview();
    room.startSitting();
    expect(ENGINE_BUILD).toMatch(/^[0-9a-f]{7}/);
    expect(room.store.sittings().at(-1)?.engine).toBe(ENGINE_BUILD);
  });

  it("setup that still has questions doesn't propose a plan yet", () => {
    const p = parseSetup("Which mode?\n>> question: Mode | What kind of work?\n>> option: Research | open\n>> option: Review | go/no-go\n>> member: arch | claude | architect");
    expect(p.questions).toHaveLength(1);
    expect(p.proposal).toBeUndefined();
  });
});

describe("live state", () => {
  it("names who is mid-turn and who is queued, and what each is answering", async () => {
    const r = setup({ delayMs: 30 });
    const room = r.create({ parallel: 1 });
    room.resume();
    await new Promise((res) => setTimeout(res, 10));
    const { detail, line } = room.status();
    expect(detail).toMatch(/Mid-turn now: (arch|skeptic) answering #3\./);
    expect(detail).toMatch(/Queued to speak next: (arch|skeptic) answering #3/);
    expect(line).toMatch(/^(arch|skeptic) speaking · 1 queued$/);
    room.pause();
    await room.settled();
  });
});

describe("the floor", () => {
  it("doesn't pick a member again while it's already answering the same sender", async () => {
    const r = setup({
      delayMs: 20,
      member: (agent, n) => (agent === "arch" && n === 1 ? "Use an LRU." : "PASS"),
      chair: ["Skeptic, your view on the plan?\n>> nudge: skeptic | weigh in on the plan", "PASS"],
    });
    const room = r.create({ parallel: 2 });
    room.resume();
    await room.settled();
    // The nudge started skeptic's turn; the Chair's public message right after must not queue a second one.
    const after = r.calls.findIndex((c) => c.agent === "chair");
    expect(r.calls.slice(after).filter((c) => c.agent === "skeptic")).toHaveLength(1);
  });
});

describe("review helpers", () => {
  it("finds sections outside code fences and their text", () => {
    const t = "# A\nx\n```\n# not a heading\n```\n## B\ny\n# C\nz";
    expect(sections(t).map((s) => s.title)).toEqual(["A", "B", "C"]);
    expect(sectionText(t, "B")).toBe("## B\ny");
    expect(sectionText(t, "A")).toBe("# A\nx\n```\n# not a heading\n```\n## B\ny");
  });

  it("diffs lines and names the changed sections", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "B" },
      { op: " ", text: "c" },
    ]);
    expect(unifiedDiff(V1, V2, 0)).toBe("- Use an LRU.\n+ Use an LRU with a 30 s TTL.");
    expect(changedSections(V1, V2)).toEqual(["Cache"]);
  });
});
