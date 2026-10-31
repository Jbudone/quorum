import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accessNote } from "../src/room/prompts.js";
import { grantableDir } from "../src/room/room.js";
import { MOCK_SUPPORT } from "../src/room/setup.js";
import { SetupChat } from "../src/room/setupchat.js";
import { ClaudeTransport } from "../src/transports/claude.js";
import { OpencodeTransport } from "../src/transports/opencode.js";
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
const elsewhere = () => {
  const d = mkdtempSync(join(tmpdir(), "quorum-other-"));
  writeFileSync(join(d, "notes.md"), "hi");
  return d;
};

describe("Letting a channel read a folder outside the project", () => {
  it("accepts an existing folder outside the repo, or a file's folder, and nothing inside it", () => {
    const repo = mkdtempSync(join(tmpdir(), "quorum-repo-"));
    mkdirSync(join(repo, "docs"));
    const other = elsewhere();
    expect(grantableDir(other, repo)).toBe(other);
    expect(grantableDir(join(other, "notes.md"), repo)).toBe(other);
    expect(() => grantableDir("docs", repo)).toThrow(/inside the project/);
    expect(() => grantableDir(join(other, "nope"), repo)).toThrow(/there's no/);
  });

  it("is something the assistant can suggest; approving it gives every member's CLI the folder", async () => {
    const other = elsewhere();
    const r = setup({ member: () => "PASS", assistant: [`I need the other project.\n>> read: ${other} | the transcript lives there`] });
    const room = r.create();
    await room.ask("review the loom session");
    const sug = room.pending().find((s) => s.action === "read")!;
    expect(sug).toMatchObject({ args: [other], why: "the transcript lives there" });
    await room.resolve(sug.id, true);
    expect(room.store.config().dirs).toEqual([other]);
    expect(room.store.events().some((e) => e.type === "access.granted" && e.path === other)).toBe(true);
    room.post("go");
    room.resume();
    await room.settled();
    const call = r.memberCalls().at(-1)!;
    expect(call.opts?.dirs).toEqual([other]);
    expect(call.opts?.systemPrompt).toContain(other);
  });

  it("/read puts project paths on the reading list and grants folders outside it", async () => {
    const other = elsewhere();
    const r = setup({ member: () => "PASS" });
    const room = r.create();
    mkdirSync(join(r.repo, "docs"), { recursive: true });
    expect(room.read(["docs", other])).toEqual({ reading: ["docs"], dirs: [other] });
    expect(room.read([other])).toEqual({ reading: ["docs"], dirs: [other] }); // the reading list stays
    expect(room.dirs()).toEqual([other]);
  });

  it("carries a folder granted while planning into the channel it creates", async () => {
    const other = elsewhere();
    const r = setup({ member: () => "PASS" });
    const seen: any[] = [];
    const plan = ">> channel: retro | review\n>> member: pcg | mock | PCG researcher | Knows PCG.";
    const transports = (spec: any) =>
      spec.id === "assistant" ? { id: "assistant", async *send(_p: string, o: any) { seen.push(o); yield { type: "text" as const, delta: plan }; } } : r.transports(spec);
    const chat = new SetupChat({ repo: r.repo, transports, clis: ["mock"], support: MOCK_SUPPORT, floor: r.floor, head: () => "abc" });
    expect(chat.allowRead(other)).toBe(other);
    await chat.say("review the loom session");
    expect(seen[0].dirs).toEqual([other]);
    expect(seen[0].systemPrompt).toContain("/read <folder>");
    const { room } = chat.create();
    expect(room.store.config().dirs).toEqual([other]);
  });

  it("tells agents the truth about permission prompts, and passes folders to each CLI", () => {
    const note = accessNote("/work/quorum", ["/work/loom"]);
    expect(note).toContain("`/work/quorum`, `/work/loom`");
    expect(note).toMatch(/no permission prompts/);
    const args = new ClaudeTransport().buildArgs({ cwd: "/work/quorum", dirs: ["/work/loom"] });
    expect(args.join(" ")).toContain("--add-dir /work/quorum --add-dir /work/loom");
    const { env } = (new OpencodeTransport() as any).invocation("p", { cwd: "/work/quorum", dirs: ["/work/loom"] });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).agent.quorum.permission.external_directory).toEqual({ "/work/loom/**": "allow" });
  });
});
