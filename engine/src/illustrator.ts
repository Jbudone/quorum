import { checkDiagram, ICONS, LIMITS, type Diagram } from "./diagram.js";
import { probTrue, type Decide } from "./jev.js";
import type { Tldr } from "./tldr.js";

export type Ask = (prompt: string) => Promise<string>;

export interface IllustrateInput {
  agent: string;
  body: string;
  tldr?: Tldr;
}

/** Turns a council reply into a diagram, or undefined when none would help. Never throws. */
export type Illustrate = (input: IllustrateInput) => Promise<Diagram | undefined>;

export function illustratePrompt(input: IllustrateInput, errors: string[] = [], kindHint = ""): string {
  return [
    "You decide whether a short diagram would help a reader grasp this message from a design discussion, and if so describe it.",
    'Use kind "sequence" for flows: who sends what to whom, in order. Use kind "attack" for security threats: each step is one move of how the exploit happens, and "danger": true marks the one step where the attacker gets what they were after (not the later reaction of the victim).',
    'Use kind "verdict" when the message compares options and judges them (this one is bad, that one is good, this one wins): list 2-3 options, rate each "bad", "mixed" or "good" with a few words why, and set "winner" to the index of the agreed best one (or null).',
    'If the message is a process note or too vague to draw faithfully, answer {"useful": false}. Use ONLY actors, steps and options the message explicitly states or directly implies. Do not add databases, checks, validations or components it never mentions, even if they would be typical. Prefer 3-4 short steps over a complete-looking one.',
    ...(kindHint ? [`A classifier already judged that a diagram of kind "${kindHint}" fits; use it unless the message clearly cannot support one.`] : []),
    "",
    `Limits: ${LIMITS.actors} actors max, ${LIMITS.steps} steps max, labels under ${LIMITS.label} characters, step text under ${LIMITS.text} characters.`,
    `Icons: ${ICONS.join(", ")}.`,
    "",
    "Reply with ONLY JSON:",
    'For sequence or attack:',
    '{"useful": true, "kind": "sequence|attack", "title": "...",',
    ' "actors": [{"id": "client", "label": "Client", "icon": "user"}],',
    ' "steps": [{"from": "client", "to": "api", "text": "POST /login", "danger": false, "evidence": "exact words copied from the message"}]}',
    'For verdict:',
    '{"useful": true, "kind": "verdict", "title": "...", "winner": 0,',
    ' "options": [{"name": "Milk bar", "rating": "bad|mixed|good", "note": "a few words why", "evidence": "exact words copied from the message"}]}',
    "Every step and option MUST carry an \"evidence\" phrase copied word for word from the message. One you cannot quote is invented: leave it out.",
    "",
    `Message from ${input.agent}:`,
    input.tldr ? `Summary: ${input.tldr.headline}\n${input.tldr.bullets.map((b) => `- ${b}`).join("\n")}\n` : "",
    input.body.slice(0, 3500),
    ...(errors.length ? ["", `Your previous answer was rejected: ${errors.join("; ")}. Fix these and answer again.`] : []),
  ].join("\n");
}

function extractJson(reply: string): any {
  const s = reply.indexOf("{");
  const e = reply.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("the reply had no JSON object");
  return JSON.parse(reply.slice(s, e + 1));
}

export function verifyPrompt(d: Diagram, body: string): string {
  return [
    "Check that this diagram faithfully depicts the message. It must not add steps, actors or threats the message does not support.",
    'Reply with ONLY JSON: {"faithful": true|false, "problem": "..."}',
    "",
    `Diagram: ${JSON.stringify(d)}`,
    "",
    `Message:\n${body.slice(0, 3500)}`,
  ].join("\n");
}

export interface IllustratorOptions {
  /** A second generative model that judges faithfulness (used only when no Jev is configured). */
  verify?: Ask;
  /** Jev: gates whether a diagram is worth generating and verifies it afterwards. */
  jev?: Decide;
  /** Minimum probability that a diagram helps before the generator is asked. */
  gate?: number;
  /** Minimum probability that the diagram is faithful before it is shown. */
  faithful?: number;
}

/**
 * Builds an Illustrate from a cheap generator. With Jev: a classifier first decides whether a
 * diagram helps and of what kind (saving the generator call), then verifies the result. Without
 * it, programmatic checks and an optional verifier model do the job. A Jev outage skips the gate
 * but never skips verification: an unverified diagram is not shown.
 */
export function makeIllustrator(ask: Ask, opts: IllustratorOptions | Ask = {}): Illustrate {
  const o: IllustratorOptions = typeof opts === "function" ? { verify: opts } : opts;
  const gate = o.gate ?? 0.6;
  const faithful = o.faithful ?? 0.7;
  return async (input) => {
    let hint = "";
    if (o.jev) {
      try {
        const g = await o.jev(input.body, {
          helps: { type: "noul", instructions: "Would a small diagram make this message easier to grasp: an ordered flow, the steps of a security exploit, or options being compared and judged (one liked, another disliked)? Answer false for vague remarks or process notes with nothing concrete to draw." },
          kind: { type: "choice", instructions: "Which diagram fits this message best?", criteria: { sequence: "an ordered flow of messages or data between parties", attack: "the steps of a security exploit or failure scenario", verdict: "options being compared and judged, with one preferred or ranked", none: "no concrete sequence, threat or comparison to draw" } },
        });
        if (probTrue(g.helps) < gate || g.kind?.value === "none") return undefined;
        if (g.kind?.value === "sequence" || g.kind?.value === "attack" || g.kind?.value === "verdict") hint = String(g.kind.value);
      } catch {
        // Gate unavailable: fall through and let the generator decide.
      }
    }
    let errors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = extractJson(await ask(illustratePrompt(input, errors, hint)));
        if (raw.useful === false) return undefined;
        const checked = checkDiagram(raw, input.body);
        if (!checked.ok) {
          errors = checked.errors;
          continue;
        }
        const d = checked.diagram;
        if (o.jev) {
          const v = await o.jev(`Message:\n${input.body}\n\nDiagram:\n${describe(d)}`, {
            faithful: { type: "noul", instructions: "Every actor and step in the diagram is supported by the message. Nothing is invented, reversed or exaggerated." },
          });
          if (probTrue(v.faithful) >= faithful) return d;
          errors = ["a fact-checker found steps or actors the message does not state; use only what it explicitly says"];
          continue;
        }
        if (o.verify) {
          const verdict = extractJson(await o.verify(verifyPrompt(d, input.body)));
          if (verdict.faithful !== true) return undefined;
        }
        return d;
      } catch (e) {
        errors = [e instanceof Error ? e.message : String(e)];
      }
    }
    return undefined;
  };
}

/** The diagram as plain sentences, which is what a classifier can judge. */
function describe(d: Diagram): string {
  if (d.kind === "verdict") {
    return [`verdict: ${d.title}`, ...d.options.map((o, i) => `${i + 1}. ${o.name} is ${o.rating}${o.note ? ` (${o.note})` : ""}${d.winner === i ? " - the agreed best" : ""}`)].join("\n");
  }
  const name = new Map(d.actors.map((a) => [a.id, a.label]));
  return [`${d.kind}: ${d.title}`, ...d.steps.map((s, i) => `${i + 1}. ${name.get(s.from)} -> ${name.get(s.to)}: ${s.text}${s.danger ? " (the breach)" : ""}`)].join("\n");
}

const MOCK: Record<string, Diagram> = {
  pragmatist: {
    kind: "verdict",
    title: "Rollout scope",
    actors: [],
    steps: [],
    options: [
      { name: "All at once", rating: "bad", note: "two migrations in one" },
      { name: "Token service", rating: "good", note: "first, behind a flag" },
    ],
    winner: 1,
  },
  skeptic: {
    kind: "attack",
    title: "Refresh-token theft without reuse detection",
    actors: [
      { id: "attacker", label: "Attacker", icon: "skull" },
      { id: "client", label: "Client", icon: "user" },
      { id: "api", label: "Token API", icon: "server" },
    ],
    options: [],
    winner: null,
    steps: [
      { from: "attacker", to: "client", text: "steals refresh token", danger: false },
      { from: "attacker", to: "api", text: "refresh with stolen", danger: false },
      { from: "api", to: "attacker", text: "issues new tokens", danger: true },
      { from: "client", to: "api", text: "refresh: still valid", danger: false },
    ],
  },
  architect: {
    kind: "sequence",
    title: "Login with rotating refresh tokens",
    actors: [
      { id: "client", label: "Client", icon: "user" },
      { id: "api", label: "Token API", icon: "server" },
      { id: "db", label: "Token DB", icon: "db" },
    ],
    options: [],
    winner: null,
    steps: [
      { from: "client", to: "api", text: "POST /login", danger: false },
      { from: "api", to: "db", text: "store refresh hash", danger: false },
      { from: "api", to: "client", text: "JWT + refresh", danger: false },
      { from: "client", to: "api", text: "refresh (rotates)", danger: false },
    ],
  },
};

/** Canned diagrams for mock sessions, keyed by the speaking agent; others get none. */
export const mockIllustrator: Illustrate = async ({ agent }) => MOCK[agent];
