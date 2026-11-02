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
