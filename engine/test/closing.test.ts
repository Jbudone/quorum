import { describe, expect, it } from "vitest";
import { ASSISTANT_SYSTEM, assistantActions, CHAIR_SYSTEM, docBriefPrompt } from "../src/room/prompts.js";

describe("closing a round", () => {
  it("has the assistant act on a lagging document and unsent probes, and close rounds with the probes accounted for", () => {
    expect(ASSISTANT_SYSTEM).toMatch(/latest document is behind/);
    expect(ASSISTANT_SYSTEM).toMatch(/a probe left in the transcript never runs/);
    expect(assistantActions(["claude"], [])).toMatch(/list each probe or experiment the channel proposed and whether it was mailed/);
  });

  it("has the Chair check a document's claims before accepting it", () => {
    expect(CHAIR_SYSTEM).toMatch(/check it as a critic would/);
    expect(CHAIR_SYSTEM).toMatch(/a threshold nobody justified/);
  });

  it("asks the brief for the document's weak spots", () => {
    expect(docBriefPrompt({ slug: "plan", version: 2, text: "# Plan" })).toMatch(/\*\*Weak spots:\*\*/);
  });
});

describe("planning questions", () => {
  it("never offers an 'I'll type it' option, and waits for what the human said they'd give", async () => {
    const { setupPrompt } = await import("../src/room/prompts.js");
    const s = setupPrompt({ repo: "/r", members: [], channels: [], clis: ["claude"], personas: [], history: [] });
    expect(s).toMatch(/never add an option like "I'll type it"/);
    expect(s).toMatch(/never fill in a guess for something the human said they would give you/);
  });
});
