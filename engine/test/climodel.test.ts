import { createCouncilAgent } from "../src/agents/index.js";
import { describe, expect, it } from "vitest";
import { flattenPrompt } from "../src/climodel/index.js";
import { MockTransport } from "../src/transports/mock.js";
import type { AgentEvent } from "../src/transports/types.js";

describe("flattenPrompt", () => {
  it("separates system text and returns the latest user message", () => {
    const f = flattenPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "two" }] },
    ]);
    expect(f.system).toBe("be brief");
    expect(f.last).toBe("two");
    expect(f.full).toContain("User: one");
  });
});

describe("CliModel in a Mastra Agent", () => {
  const make = (seen: AgentEvent[] = []) => {
    const transport = new MockTransport("skeptic", { rules: [], fallback: "What breaks first?" });
    const { agent } = createCouncilAgent(
      "skeptic",
      { name: "Skeptic", role: "critic", body: "You are the Skeptic." },
      transport,
      {},
      (e) => seen.push(e),
    );
    return { agent, seen, transport };
  };

  it("generates text through the CLI transport", async () => {
    const { agent } = make();
    const res = await agent.generate("Review the plan");
    expect(res.text).toBe("What breaks first?");
  });

  it("streams deltas and forwards raw events", async () => {
    const { agent, seen } = make();
    const out = await agent.stream("Review the plan");
    let text = "";
    for await (const chunk of out.textStream) text += chunk;
    expect(text).toBe("What breaks first?");
    expect(seen.at(-1)).toMatchObject({ type: "done" });
  });

  it("resumes the vendor session, sending only the newest message", async () => {
    const { agent, transport } = make();
    const prompts: string[] = [];
    const send = transport.send.bind(transport);
    transport.send = (p, o) => (prompts.push(`${o?.sessionId ?? "-"}|${p}`), send(p, o));
    await agent.generate("first");
    await agent.generate("second");
    expect(prompts[0].startsWith("-|")).toBe(true);
    expect(prompts[1]).toBe("skeptic-session|second");
  });
});
