import { describe, expect, it } from "vitest";
import { checkDiagram } from "../src/diagram.js";
import { makeIllustrator } from "../src/illustrator.js";

const base = {
  kind: "sequence",
  title: "Login",
  actors: [
    { id: "client", label: "Client", icon: "user" },
    { id: "api", label: "API", icon: "server" },
  ],
  steps: [{ from: "client", to: "api", text: "POST /login" }],
};

describe("checkDiagram", () => {
  it("accepts a valid diagram", () => {
    const r = checkDiagram(base);
    expect(r.ok && r.diagram.steps[0]).toEqual({ from: "client", to: "api", text: "POST /login", danger: false });
  });

  it("repairs what it can: long text, extra steps, unknown icons, labels as ids", () => {
    const r = checkDiagram({
      ...base,
      actors: [{ id: "c", label: "Client", icon: "wizard" }, { id: "api", label: "API", icon: "server" }],
      steps: Array.from({ length: 9 }, () => ({ from: "Client", to: "api", text: "x".repeat(60) })),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.diagram.steps).toHaveLength(6);
      expect(r.diagram.steps[0].text.length).toBeLessThanOrEqual(24);
      expect(r.diagram.steps[0].from).toBe("c");
      expect(r.diagram.actors[0].icon).toBe("server");
      expect(r.repairs.length).toBeGreaterThan(0);
    }
  });

  it("marks the last attack step as the breach when none is", () => {
    const r = checkDiagram({ ...base, kind: "attack" });
    expect(r.ok && r.diagram.steps[0].danger).toBe(true);
  });

  it("rejects what cannot be repaired", () => {
    expect(checkDiagram({ ...base, kind: "pie" }).ok).toBe(false);
    expect(checkDiagram({ ...base, actors: [base.actors[0]] }).ok).toBe(false);
    const r = checkDiagram({ ...base, steps: [{ from: "client", to: "ghost", text: "boo" }] });
    expect(!r.ok && r.errors[0]).toContain("does not exist");
  });
});

describe("makeIllustrator", () => {
  const input = { agent: "skeptic", body: "Refresh tokens can be stolen." };
  it("returns undefined when the model says a diagram would not help", async () => {
    expect(await makeIllustrator(async () => '{"useful": false}')(input)).toBeUndefined();
  });
  it("retries once with the errors, then draws", async () => {
    const seen: string[] = [];
    const answers = [JSON.stringify({ ...base, steps: [{ from: "client", to: "ghost", text: "x" }] }), JSON.stringify(base)];
    const d = await makeIllustrator(async (p) => (seen.push(p), answers.shift()!))(input);
    expect(d?.title).toBe("Login");
    expect(seen[1]).toContain("does not exist");
  });
  it("gives up quietly after two bad answers or a throw", async () => {
    expect(await makeIllustrator(async () => "no json here")(input)).toBeUndefined();
    expect(await makeIllustrator(async () => { throw new Error("down"); })(input)).toBeUndefined();
  });
  it("drops a diagram the verifier calls unfaithful", async () => {
    const draw = makeIllustrator(async () => JSON.stringify(base), async () => '{"faithful": false}');
    expect(await draw(input)).toBeUndefined();
    const ok = makeIllustrator(async () => JSON.stringify(base), async () => '{"faithful": true}');
    expect(await ok(input)).toBeDefined();
  });
});
