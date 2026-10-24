import {
  DEFAULT_ASSETS,
  listPersonas,
  loadPersona,
  userDir,
  type CliName,
  type CouncilConfig,
} from "./config.js";
import type { CliInfo } from "./doctor.js";
import { createTransport } from "./transports/index.js";
import { validateCouncil } from "./library.js";

/** Sends one prompt to a model and returns its full reply. Injected so tests and mock mode need no CLI. */
export type Ask = (prompt: string) => Promise<string>;

export interface Design {
  config: CouncilConfig;
  /** Plain-language reasons for the choices, shown to the human before they approve. */
  rationale: string;
  /** "model" when the designer's proposal was used, "fallback" when it could not be validated. */
  source: "model" | "fallback";
}

export interface DesignInput {
  topic: string;
  clis: CliInfo[];
  assetsDir?: string;
  user?: string;
}

const PROTOCOLS = [
  "- draft-critique-revise: one drafter writes the plan, critics attack it, the drafter revises. Best default; needs 2+ members.",
  "- delphi: members answer blind and anonymously, then see the spread and revise. Best for estimates and judgment calls under uncertainty; needs 3+ members to be worth it.",
  "- round-robin: members take turns building on each other. Best for brainstorming or a tiny council.",
];

export function designPrompt(input: DesignInput, retryErrors: string[] = []): string {
  const assets = input.assetsDir ?? DEFAULT_ASSETS;
  const user = input.user ?? userDir();
  const usable = input.clis.filter((c) => c.usable);
  const personas = listPersonas(assets, user).map((p) => {
    const body = loadPersona(p.key, assets, user).body.replace(/\s+/g, " ");
    return `- ${p.key} (${p.role}): ${body.slice(0, 150)}`;
  });
  return [
    "You design the council for Quorum, a tool where several AI agents debate a hard feature and write a plan.",
    "Choose the smallest council that will do the job well: 2-3 members for narrow work, 4-5 for contested or high-stakes work, at most 6.",
    "Mix vendors when several CLIs are available, because different models catch different mistakes. Put a stronger model on the drafter and cheaper ones on critics when that saves quota.",
    "",
    `Topic:\n${input.topic}`,
    "",
    "Agent CLIs you may use (model names are optional; omit to use the CLI's default):",
    ...usable.map((c) => `- ${c.cli}${c.models.length ? ` (models: ${c.models.join(", ")})` : ""}`),
    "",
    "Personas (each member takes exactly one):",
    ...personas,
    "",
    "Protocols:",
    ...PROTOCOLS,
    "",
    "Reply with ONLY a JSON object, no prose and no code fence:",
    '{"rationale": "2-3 plain sentences on why this shape fits the topic",',
    ' "protocol": "draft-critique-revise|delphi|round-robin", "rounds": 2-4,',
    ' "pause": "round", "readOnly": true, "requireEvidence": true|false,',
    ' "chair": {"cli": "<cli>", "model": "<optional>"},',
    ' "agents": [{"persona": "<persona key>", "cli": "<cli>", "model": "<optional>"}]}',
    "Include an architect (or another drafter) when using draft-critique-revise. Set requireEvidence true when the topic is about changing existing code.",
    ...(retryErrors.length ? ["", `Your previous answer was rejected: ${retryErrors.join("; ")}. Fix these and answer again.`] : []),
  ].join("\n");
}

/** A member id from a persona key, made unique among the ids already taken. */
function idFor(persona: string, taken: Set<string>): string {
  const base = persona.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "member";
  let id = base === "chair" ? "member" : base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function extractJson(reply: string): any {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the reply had no JSON object");
  return JSON.parse(reply.slice(start, end + 1));
}

function toConfig(raw: any, input: DesignInput): CouncilConfig {
  const taken = new Set<string>();
  const usable = new Set(input.clis.filter((c) => c.usable).map((c) => c.cli));
  const first = [...usable][0] ?? "claude";
  const cli = (v: unknown): CliName => (usable.has(v as CliName) ? (v as CliName) : first);
  const model = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    name: "auto",
    description: "Designed for this topic",
    protocol: String(raw.protocol ?? "draft-critique-revise"),
    rounds: Number(raw.rounds ?? 3),
    pause: raw.pause === "message" || raw.pause === "auto" ? raw.pause : "round",
    readOnly: raw.readOnly ?? true,
    requireEvidence: raw.requireEvidence ?? false,
    chair: { cli: cli(raw.chair?.cli), model: model(raw.chair?.model) },
    agents: (Array.isArray(raw.agents) ? raw.agents : []).map((a: any) => ({
      id: idFor(String(a?.persona ?? ""), taken),
      cli: cli(a?.cli),
      model: model(a?.model),
      persona: String(a?.persona ?? ""),
    })),
  };
}

/** The council used when the designer's answer cannot be made valid: the shipped trio shape on whatever is usable. */
export function fallbackDesign(input: DesignInput, why: string): Design {
  const usable = input.clis.filter((c) => c.usable).map((c) => c.cli);
  const pool: CliName[] = usable.length ? usable : ["claude"];
  const personas = ["architect", "skeptic", "pragmatist"];
  const taken = new Set<string>();
  return {
    source: "fallback",
    rationale: `Could not get a valid design from the model (${why}), so this is the standard three-member council.`,
    config: {
      name: "auto",
      description: "Standard council (design fallback)",
      protocol: "draft-critique-revise",
      rounds: 3,
      pause: "round",
      readOnly: true,
      requireEvidence: false,
      chair: { cli: pool[0] },
      agents: personas.map((persona, i) => ({ id: idFor(persona, taken), cli: pool[i % pool.length], persona })),
    },
  };
}

/** Asks a model to design the council for a topic; one corrective retry, then the standard council. */
export async function designCouncil(ask: Ask, input: DesignInput): Promise<Design> {
  const assets = input.assetsDir ?? DEFAULT_ASSETS;
  const user = input.user ?? userDir();
  let errors: string[] = [];
  let lastWhy = "no answer";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = extractJson(await ask(designPrompt(input, errors)));
      const config = toConfig(raw, input);
      errors = validateCouncil(config, assets, user);
      if (!errors.length) {
        const rationale = typeof raw.rationale === "string" && raw.rationale.trim() ? raw.rationale.trim() : "Designed for this topic.";
        return { config, rationale, source: "model" };
      }
      lastWhy = errors.join("; ");
    } catch (e) {
      lastWhy = e instanceof Error ? e.message : String(e);
      errors = [lastWhy];
    }
  }
  return fallbackDesign(input, lastWhy);
}

/** Canned design for mock sessions, so the whole flow runs without spending quota. */
export const mockDesigner: Ask = async () =>
  JSON.stringify({
    rationale:
      "A migration touches security, rollout and day-to-day operations, so three critics with different lenses will catch more than one. Two rounds is enough for the design to settle.",
    protocol: "draft-critique-revise",
    rounds: 2,
    pause: "round",
    readOnly: true,
    requireEvidence: true,
    chair: { cli: "mock" },
    agents: [
      { persona: "architect", cli: "mock" },
      { persona: "skeptic", cli: "mock" },
      { persona: "security", cli: "mock" },
      { persona: "operator", cli: "mock" },
    ],
  });

const DESIGNER_PREFERENCE: CliName[] = ["claude", "codex", "agy", "opencode", "gemini"];

/** A designer backed by the best usable CLI; read-only, with a time limit so a stuck CLI cannot hang the UI. */
export function realDesigner(clis: CliInfo[], repo: string, timeoutMs = 120_000): { ask: Ask; cli: CliName } {
  const usable = new Set(clis.filter((c) => c.usable).map((c) => c.cli));
  const cli = DESIGNER_PREFERENCE.find((c) => usable.has(c));
  if (!cli) throw new Error("no agent CLI is usable, so there is nothing to design a council from (run `quorum doctor`)");
  const ask: Ask = async (prompt) => {
    const transport = createTransport({ id: "designer", cli });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let text = "";
    try {
      for await (const e of transport.send(prompt, { cwd: repo, readOnly: true, signal: ctl.signal, systemPrompt: "You are the Quorum council designer. Answer with the JSON object only." })) {
        if (e.type === "text") text += e.delta;
        else if (e.type === "error") throw new Error(e.message);
      }
    } finally {
      clearTimeout(timer);
    }
    return text;
  };
  return { ask, cli };
}
