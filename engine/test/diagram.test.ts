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
  steps: [{ from: "client", to: "api", text: "POST /login", evidence: "client sends login request to the API" }, { from: "api", to: "client", text: "200 OK", evidence: "client sends login request" }],
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
    expect(r.ok && r.diagram.steps[1].danger).toBe(true);
  });

  it("rejects what cannot be repaired", () => {
    expect(checkDiagram({ ...base, kind: "pie" }).ok).toBe(false);
    expect(checkDiagram({ ...base, actors: [base.actors[0]] }).ok).toBe(false);
    const r = checkDiagram({ ...base, steps: [{ from: "client", to: "ghost", text: "boo" }] });
    expect(!r.ok && r.errors[0]).toContain("does not exist");
  });
});

describe("verdict", () => {
  const body = "Dairy Dream is waxy and cloying, so skip it. Nocturne Dark is smooth and balanced, the clear best.";
  const v = (o: any = {}) => ({
    kind: "verdict", title: "Best bar", winner: 1,
    options: [
      { name: "Dairy Dream", rating: "bad", note: "waxy", evidence: "Dairy Dream is waxy and cloying" },
      { name: "Nocturne Dark", rating: "good", note: "smooth", evidence: "Nocturne Dark is smooth and balanced" },
    ],
    ...o,
  });
  it("accepts a quoted verdict with a winner", () => {
    const r = checkDiagram(v(), body);
    expect(r.ok && r.diagram).toMatchObject({ kind: "verdict", winner: 1, steps: [], actors: [] });
  });
  it("resolves the winner by name and refuses a bad winner", () => {
    expect(checkDiagram(v({ winner: "nocturne dark" }), body).ok && (checkDiagram(v({ winner: "nocturne dark" }), body) as any).diagram.winner).toBe(1);
    const r = checkDiagram(v({ winner: 0 }), body);
    expect(r.ok && r.diagram.winner).toBeNull();
  });
  it("drops invented options and needs two left", () => {
    const r = checkDiagram(v({ options: [v().options[0], { name: "Mystery", rating: "good", evidence: "truffle with sea salt flakes" }] }), body);
    expect(r.ok).toBe(false);
  });
});

describe("evidence check", () => {
  const body = "An attacker steals the refresh token and exchanges it at the token API for new tokens.";
  const mk = (steps: any[]) => ({ ...base, kind: "attack", actors: [{ id: "x", label: "Attacker", icon: "skull" }, { id: "api", label: "API", icon: "server" }, { id: "db", label: "DB", icon: "db" }], steps });
  it("keeps quoted steps, drops invented ones, and prunes unused actors", () => {
    const r = checkDiagram(mk([
      { from: "x", to: "api", text: "exchanges token", evidence: "exchanges it at the token API for new tokens" },
      { from: "api", to: "x", text: "new tokens", evidence: "for new tokens" },
      { from: "api", to: "db", text: "check token", evidence: "validates the token against the database" },
    ]), body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.diagram.steps).toHaveLength(2);
      expect(r.diagram.actors.map((a) => a.id)).toEqual(["x", "api"]);
      expect(r.repairs.join()).toContain("dropped step 3");
    }
  });
  it("fails when too little of the diagram is backed by the message", () => {
    const r = checkDiagram(mk([{ from: "x", to: "api", text: "a", evidence: "completely unrelated words here" }, { from: "api", to: "db", text: "b" }]), body);
    expect(r.ok).toBe(false);
  });
  it("is skipped when no message is given", () => {
    expect(checkDiagram(mk([{ from: "x", to: "api", text: "a" }])).ok).toBe(true);
  });
});

describe("makeIllustrator", () => {
  const input = { agent: "skeptic", body: "The client sends login request to the API every time." };
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
