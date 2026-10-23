import { describe, expect, it } from "vitest";
import { MockTransport } from "../src/transports/mock.js";
import type { AgentEvent } from "../src/transports/types.js";

async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("MockTransport", () => {
  it("streams the first matching rule then reports usage and done", async () => {
    const t = new MockTransport("skeptic", {
      rules: [{ match: /risk/i, reply: "What breaks first?" }],
    });
    const events = await collect(t.send("List the risks"));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe(
      "What breaks first?",
    );
    expect(events.at(-1)).toEqual({ type: "done", sessionId: "skeptic-session" });
  });

  it("stops with an error when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const t = new MockTransport("a", { rules: [], fallback: "one two three" });
    const events = await collect(t.send("x", { signal: ac.signal }));
    expect(events).toEqual([{ type: "error", message: "aborted" }]);
  });
});
