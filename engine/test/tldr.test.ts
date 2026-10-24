import { describe, expect, it } from "vitest";
import { fallbackTldr, splitTldr } from "../src/tldr.js";

describe("tldr", () => {
  it("splits a declared block off the reply", () => {
    const r = splitTldr("Full argument here.\n\n<tldr>\nheadline: Ship it behind a flag\nstance: Agree\nconfidence: 82\n- one\n- two\n</tldr>");
    expect(r.body).toBe("Full argument here.");
    expect(r.tldr).toEqual({ headline: "Ship it behind a flag", bullets: ["one", "two"], stance: "agree", confidence: 82 });
  });

  it("tolerates junk values and caps lengths", () => {
    const r = splitTldr("x\n<tldr>\nheadline: a b c d e f g h i j k l m n o\nstance: ???\nconfidence: 900\n- 1\n- 2\n- 3\n- 4\n</tldr>");
    expect(r.tldr?.stance).toBe("neutral");
    expect(r.tldr?.confidence).toBe(100);
    expect(r.tldr?.bullets).toHaveLength(3);
    expect(r.tldr?.headline.endsWith("…")).toBe(true);
  });

  it("drops an unterminated block rather than leaking it", () => {
    expect(splitTldr("Body\n<tldr>\nheadline: cut off").body).toBe("Body");
  });

  it("falls back to a digest when the agent skipped the block", () => {
    const t = fallbackTldr("1. **Critical:** rotation lacks reuse detection.\n2. **High:** no exit criteria.");
    expect(t.bullets).toEqual(["Critical: rotation lacks reuse detection.", "High: no exit criteria."]);
    expect(t.headline).not.toBe("");
  });
});
