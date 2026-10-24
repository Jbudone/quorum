/**
 * A small structured diagram that the TUI animates: a message sequence or an attack chain.
 * Agents never draw frames; a model only fills these fields, and this module validates and repairs
 * them so a bad answer can be fixed or dropped without a second model call.
 */
export const ICONS = ["user", "agent", "server", "db", "lock", "key", "file", "bug", "skull", "cloud", "clock"] as const;
export type Icon = (typeof ICONS)[number];

export interface DiagramActor {
  id: string;
  label: string;
  icon: Icon;
}
export interface DiagramStep {
  from: string;
  to: string;
  text: string;
  /** The threat succeeds or the dangerous thing happens at this step. */
  danger: boolean;
}
export interface Diagram {
  kind: "sequence" | "attack";
  title: string;
  actors: DiagramActor[];
  steps: DiagramStep[];
}

export const LIMITS = { actors: 4, steps: 6, label: 12, text: 24, title: 40 };

export type Checked = { ok: true; diagram: Diagram; repairs: string[] } | { ok: false; errors: string[] };

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…";
};
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 12);

/** Checks a model's diagram and repairs what can be repaired deterministically. */
export function checkDiagram(raw: any): Checked {
  const errors: string[] = [];
  const repairs: string[] = [];
  const kind = raw?.kind;
  if (kind !== "sequence" && kind !== "attack") errors.push(`kind must be "sequence" or "attack"`);

  const rawActors: any[] = Array.isArray(raw?.actors) ? raw.actors : [];
  if (rawActors.length < 2) errors.push("a diagram needs at least 2 actors");
  if (rawActors.length > LIMITS.actors) repairs.push(`kept the first ${LIMITS.actors} actors`);
  const actors: DiagramActor[] = [];
  for (const a of rawActors.slice(0, LIMITS.actors)) {
    const label = clip(a?.label ?? a?.id, LIMITS.label);
    let id = slug(String(a?.id ?? label));
    if (!id) id = `a${actors.length + 1}`;
    if (actors.some((x) => x.id === id)) {
      errors.push(`two actors are called "${id}"`);
      continue;
    }
    let icon = a?.icon as Icon;
    if (!ICONS.includes(icon)) {
      repairs.push(`unknown icon for ${id}`);
      icon = "server";
    }
    actors.push({ id, label: label || id, icon });
  }

  // Accept an actor's label or id in either case when a step refers to it.
  const resolve = (v: unknown): string | undefined => {
    const k = String(v ?? "").toLowerCase();
    return actors.find((a) => a.id === k || a.label.toLowerCase() === k)?.id;
  };
  const rawSteps: any[] = Array.isArray(raw?.steps) ? raw.steps : [];
  if (rawSteps.length < 1) errors.push("a diagram needs at least 1 step");
  if (rawSteps.length > LIMITS.steps) repairs.push(`kept the first ${LIMITS.steps} steps`);
  const steps: DiagramStep[] = [];
  rawSteps.slice(0, LIMITS.steps).forEach((s, i) => {
    const from = resolve(s?.from);
    const to = resolve(s?.to);
    if (!from || !to) {
      errors.push(`step ${i + 1} refers to an actor that does not exist (${String(s?.from)} -> ${String(s?.to)})`);
      return;
    }
    const text = clip(s?.text, LIMITS.text);
    if (!text) errors.push(`step ${i + 1} has no text`);
    steps.push({ from, to, text, danger: s?.danger === true });
  });

  if (errors.length) return { ok: false, errors };
  if (kind === "attack" && !steps.some((s) => s.danger)) {
    steps[steps.length - 1].danger = true;
    repairs.push("marked the last step as the breach");
  }
  return { ok: true, repairs, diagram: { kind, title: clip(raw?.title, LIMITS.title), actors, steps } };
}
