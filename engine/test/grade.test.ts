import { describe, expect, it } from "vitest";
import { formatGrade, gradeRoom } from "../src/room/grade.js";
import type { RoomEvent } from "../src/room/store.js";

let seq = 0;
const ev = (body: object, ts = "2026-11-01T00:00:00Z") => ({ seq: ++seq, ts, ...body }) as RoomEvent;
const say = (from: string, text: string) => ev({ type: "message", from, to: "room", text });

describe("grading a channel", () => {
  it("flags probes nobody sent, no evidence, shared jobs and a support-heavy room", () => {
    seq = 0;
    const events = [
      ev({ type: "agent.joined", agent: "ideas-a", persona: "ideas-a", cli: "claude" }),
      ev({ type: "agent.joined", agent: "ideas-b", persona: "ideas-b", cli: "codex" }),
      ev({ type: "agent.joined", agent: "critic", persona: "critic", cli: "codex" }),
      say("human", "Find a research direction."),
      ...Array.from({ length: 4 }, (_, i) => ev({ type: "aside", from: "assistant", text: `note ${i}` })),
      say("ideas-a", "We could run a probe on the solver to see whether lazy resolution holds."),
      say("ideas-b", "An experiment on hand-painted tiles would test the override story."),
      say("critic", "Neither claim has evidence yet; a probe would settle the first."),
      ev({ type: "suggestion", id: 1, from: "assistant", action: "mail", args: ["devin", "Run the probe", "body"], why: "test it" }),
    ];
    const g = gradeRoom(events, [], { roles: { "ideas-a": "Master researcher", "ideas-b": "master researcher", critic: "adversarial reviewer" } });
    expect(g.counts).toMatchObject({ memberMessages: 3, probeTalk: 3, mailDrafted: 1, mailSent: 0, evidence: 0, pending: 1 });
    expect(g.sharedRoles).toEqual([{ role: "master researcher", ids: ["ideas-a", "ideas-b"] }]);
    const poor = g.findings.filter((f) => f.level === "poor").map((f) => f.area);
    expect(poor).toEqual(expect.arrayContaining(["evidence", "probes", "lineup", "support"]));
    expect(g.findings[0].level).toBe("poor");
    expect(formatGrade("demo", g)).toMatch(/^# demo\n\n- ✗ /);
  });

  it("checks only the document the channel ended on, counts old aside exports, and compares cost with metered turns", () => {
    seq = 0;
    const events = [
      ev({ type: "agent.joined", agent: "a", persona: "a", cli: "claude" }),
      ev({ type: "agent.joined", agent: "b", persona: "b", cli: "codex" }),
      ev({ type: "doc.revised", slug: "draft", version: 1, kind: "plan", by: "a" }),
      say("a", "First point."),
      ev({ type: "tags", items: [{ seq: 4, from: "a", kind: "decision", headline: "x" }] }),
      say("b", "Second point."),
      ev({ type: "tags", items: [{ seq: 6, from: "b", kind: "decision", headline: "y" }] }),
      ev({ type: "doc.revised", slug: "final", version: 1, kind: "plan", by: "a" }),
      ev({ type: "doc.accepted", slug: "final", version: 1, by: "human" }),
      ev({ type: "aside", from: "assistant", kind: "note", text: "Exported final to docs/final.md." }),
      say("a", "Mail went out.", ),
      ev({ type: "mail.out", file: "m.md", to: "devin", subject: "probe", by: "human" }, "2026-11-02T00:00:00Z"),
      ev({ type: "message", from: "mail:devin", to: "room", text: "9/10 pass" }, "2026-11-02T00:01:00Z"),
    ];
    const g = gradeRoom(events, [
      { ts: "2026-11-01T00:00:00Z", agent: "a", role: "member", cli: "claude", input: 1, output: 1, listUsd: 1 },
      { ts: "2026-11-01T00:00:00Z", agent: "assistant", role: "support", cli: "claude", input: 1, output: 1, listUsd: 3 },
    ]);
    expect(g.lag.map((l) => l.slug)).toEqual(["final"]);
    expect(g.counts).toMatchObject({ docsAccepted: 1, docsExported: 1, mailSent: 1, mailReplies: 1, evidence: 1 });
    expect(g.cost).toMatchObject({ listUsd: 4, memberShare: 0.25, meteredTurns: 1, memberTurns: 3, perAcceptedDoc: 4 });
    const text = g.findings.map((f) => f.text).join("\n");
    expect(text).toContain("Only 1 of 3 member turns recorded usage");
    expect(text).toContain("Support roles took 75% of the cost");
    expect(text).not.toContain("draft v1");
  });
});
