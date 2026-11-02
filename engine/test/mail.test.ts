import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBlocks } from "../src/room/directives.js";
import { Mailbox, parseMail } from "../src/room/mail.js";
import { splitDigest } from "../src/room/prompts.js";
import { callTool, messages, rig } from "./roomRig.js";

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

describe("mailbox", () => {
  it("writes mail with frontmatter, a README and a send script, and finds undelivered replies", () => {
    const repo = mkdtempSync(join(tmpdir(), "mail-"));
    const box = new Mailbox(repo);
    const sent = box.send({ to: "devin", from: "quorum", subject: "Build the probe", body: "In a worktree.", channel: "levels" }, new Date("2026-10-30T18:00:00Z"));
    expect(sent.file).toBe("20261030-180000-quorum-build-the-probe.md");
    expect(existsSync(join(box.dir, "README.md")) && existsSync(join(box.dir, "send.sh"))).toBe(true);
    expect(parseMail(sent.file, readFileSync(join(box.dir, sent.file), "utf8"))).toMatchObject({ to: "devin", from: "quorum", subject: "Build the probe", channel: "levels", body: "In a worktree." });
    writeFileSync(join(box.dir, "20261030-181000-devin-done.md"), `---\nto: quorum\nfrom: devin\ndate: x\nsubject: done\nin-reply-to: ${sent.file}\n---\n\nProbe passes 9/10.\n`);
    writeFileSync(join(box.dir, "20261030-182000-devin-other.md"), "---\nto: claude\nfrom: devin\ndate: x\nsubject: not for us\n---\n\nx\n");
    expect(box.undelivered("levels").map((m) => m.subject)).toEqual(["done"]);
    box.markDelivered("20261030-181000-devin-done.md");
    expect(box.undelivered("levels")).toEqual([]);
  });
});

describe("parsers", () => {
  it("reads multi-line blocks and a trailing status", () => {
    const { rest, blocks } = parseBlocks("Saved.\n>> write: plan | first cut\n# Plan\n- a\n>> end\n>> mail: devin | probe\nBuild it.\n>> end\n>> pause: x", ["write", "mail"]);
    expect(rest).toBe("Saved.\n>> pause: x");
    expect(blocks).toEqual([
      { verb: "write", args: ["plan", "# Plan\n- a"], why: "first cut" },
      { verb: "mail", args: ["devin", "Build it."], why: "probe" },
    ]);
    expect(splitDigest("Yes.\nDIGEST: Plan agreed; probe next.")).toEqual({ answer: "Yes.", digest: "Plan agreed; probe next." });
    expect(splitDigest("Just an answer.")).toEqual({ answer: "Just an answer." });
  });
});

describe("the assistant keeps records and talks to the project", () => {
  it("writes channel documents, withdraws what it replaced, and exports or mails only with approval", async () => {
    const r = setup({
      member: () => "PASS",
      floor: () => [],
      assistant: [
        "Here's the steer.\n>> steer: first version",
        "Use this one instead.\n>> steer: better version\n>> withdraw: 1 | replaced by 2",
        "Noted.\n>> write: research-plan | from our chat\n# Research plan\n1. Text-first.\n>> end\n>> export: research-plan | docs/research/README.md | so Loom's agents can read it\n>> mail: devin | Build the scenario runner\nSee docs/research/README.md, issue 1.\n>> end\nDIGEST: Research plan written; waiting on your OK to export and mail.",
      ],
    });
    const room = r.create();
    await room.ask("what should we steer?");
    await room.ask("hmm, better?");
    // The first steer was withdrawn by the assistant itself, not left for the human to decline.
    expect(room.pending().map((p) => p.args[0])).toEqual(["better version"]);
    expect(room.store.events().find((e) => e.type === "suggestion.resolved")).toMatchObject({ id: 1, withdrawn: true, accepted: false });

    await room.ask("please note all of that down");
    expect(room.docs()).toMatchObject([{ slug: "research-plan", version: 1 }]);
    expect(room.store.readOutput("research-plan")).toBe("# Research plan\n1. Text-first.\n");
    expect(room.digest()).toBe("Research plan written; waiting on your OK to export and mail.");
    const asides = room.store.events().filter((e) => e.type === "aside" && e.kind === "answer");
    expect(asides.at(-1)).toMatchObject({ text: "Noted." });

    const exp = room.pending().find((p) => p.action === "export")!;
    const mail = room.pending().find((p) => p.action === "mail")!;
    expect(existsSync(join(r.repo, "docs/research/README.md"))).toBe(false);
    await room.resolve(exp.id, true);
    expect(readFileSync(join(r.repo, "docs/research/README.md"), "utf8")).toContain("# Research plan");
    await room.resolve(mail.id, true);
    const out = room.store.events().find((e) => e.type === "mail.out")!;
    expect(out).toMatchObject({ to: "devin", subject: "Build the scenario runner", by: "assistant" });
    // The first mail offers to tell the project's agents where mail lives.
    const pointer = room.pending().find((p) => p.action === "pointer")!;
    expect(pointer.args).toEqual(["AGENTS.md"]);
    await room.resolve(pointer.id, true);
    expect(readFileSync(join(r.repo, "AGENTS.md"), "utf8")).toContain("## Quorum mail");
  });

  it("won't overwrite a project file Quorum didn't write", async () => {
    const r = setup({ assistant: ["x\n>> write: notes | n\nhello\n>> end\n>> export: notes | README.md | y"] });
    writeFileSync(join(r.repo, "README.md"), "theirs");
    const room = r.create();
    await room.ask("export it");
    await expect(room.resolve(room.pending()[0].id, true)).rejects.toThrow(/already exists and Quorum didn't write it/);
    expect(readFileSync(join(r.repo, "README.md"), "utf8")).toBe("theirs");
  });

  it("delivers replies from the project's agents into the channel, in the thread they answer", async () => {
    const r = setup({ member: () => "PASS", floor: () => [] });
    const room = r.create({ name: "levels" });
    const q = room.post("Can someone build the probe?", "room", "new");
    const file = room.sendMail("devin", "Build the probe", "Please.", "human", q.seq);
    writeFileSync(join(r.repo, ".quorum", "mail", "20991231-000000-devin-done.md"), `---\nto: quorum\nfrom: devin\ndate: x\nsubject: done\nin-reply-to: ${file}\n---\n\n9/10 pass.\n`);
    room.checkMail();
    const reply = messages(room).at(-1)!;
    expect(reply).toMatchObject({ from: "mail:devin", thread: q.seq });
    expect(reply.type === "message" && reply.text).toContain("9/10 pass.");
    room.checkMail();
    expect(messages(room).filter((m) => m.type === "message" && m.from === "mail:devin")).toHaveLength(1);
  });

  it("lets members draft mail for the human to approve", async () => {
    const r = setup({ member: (a, n) => (a === "arch" && n === 1 ? { tools: [["mail_draft", { to: "devin", subject: "Run the probe", body: "In a worktree." }]], say: "Drafted mail." } : "PASS") });
    const room = r.create({ parallel: 1 });
    room.resume();
    await room.settled();
    expect(r.results.arch[0].text).toMatch(/human approves/);
    expect(room.pending()).toMatchObject([{ from: "arch", action: "mail", args: ["devin", "Run the probe", "In a worktree."] }]);
    void callTool;
  });
});

describe("a project's own mailbox", () => {
  it("writes into the project's mail/ folder, leaves it untouched otherwise, and only takes answers to Quorum", () => {
    const repo = mkdtempSync(join(tmpdir(), "mail-"));
    mkdirSync(join(repo, "mail", "read"), { recursive: true });
    writeFileSync(join(repo, "mail", "20261029-000000-qwen-hello.md"), "---\nto: all\nfrom: qwen\ndate: x\nsubject: hello everyone\n---\n\nhi\n");
    const box = new Mailbox(repo);
    expect(box.shared).toBe(true);
    expect(box.rel).toBe("mail");
    const sent = box.send({ to: "all", from: "quorum", subject: "Run the probe", body: "In a worktree." }, new Date("2026-10-30T18:00:00Z"));
    expect(existsSync(join(repo, "mail", sent.file))).toBe(true);
    expect(existsSync(join(repo, "mail", "README.md")) || existsSync(join(repo, "mail", "send.sh"))).toBe(false);
    const raw = readFileSync(join(repo, "mail", sent.file), "utf8");
    expect(raw).toContain(`in-reply-to: ${sent.file}`);
    expect(parseMail(sent.file, raw)?.body).toBe("In a worktree.");
    // A broadcast that answers Quorum's mail counts, archived or not; the project's own broadcasts don't.
    writeFileSync(join(repo, "mail", "read", "20261030-190000-devin-done.md"), `---\nto: all\nfrom: devin\ndate: x\nsubject: done\nin-reply-to: ${sent.file}\n---\n\n9/10.\n`);
    expect(box.undelivered("levels").map((m) => m.subject)).toEqual(["done"]);
    box.markDelivered("20261030-190000-devin-done.md");
    expect(box.undelivered("levels")).toEqual([]);
    expect(existsSync(join(repo, "mail", ".delivered"))).toBe(false);
    expect(existsSync(join(repo, ".quorum", "mail", ".delivered"))).toBe(true);
  });

  it("records where mail went and doesn't offer the pointer when the project has its own mailbox", async () => {
    const r = setup({ member: () => "PASS", floor: () => [] });
    mkdirSync(join(r.repo, "mail"), { recursive: true });
    mkdirSync(join(r.repo, "scripts"), { recursive: true });
    writeFileSync(join(r.repo, "scripts", "agent-mail.sh"), "#!/bin/sh\n");
    const room = r.create({ name: "levels" });
    const file = room.sendMail("devin", "Build the probe", "Please.", "human");
    expect(room.store.events().find((e) => e.type === "mail.out")).toMatchObject({ file, path: `mail/${file}` });
    expect(room.pending().some((p) => p.action === "pointer")).toBe(false);
  });
});
