import type { AgentEvent, AgentTransport, SendOptions } from "../transports/index.js";
import type { TransportFactory } from "./room.js";

/**
 * Token-free room cast for `--mock` and the TUI. Members call the real room tools over the bridge's
 * HTTP endpoint (so posts, drafts and topics all go through the same code as live agents), and the
 * support roles answer in their real formats. Every script cycles, so a mock room runs until its cap.
 */
type Step =
  | { post: string; replyToLast?: boolean }
  | { pass: true }
  | { draft: { name: string; kind: string; text: string; note: string } }
  | { raise: { title: string; why: string } };

const PLAN = (v: number) => `# Plan: cache layer for the product API

## Decision
An in-process LRU per instance (64 MB), with a 30 s TTL on product reads and explicit invalidation on writes.

## Steps
1. Wrap the product repository with a read-through cache.
2. Invalidate on the three write paths (update, delete, bulk import).
3. Export hit rate and eviction counts.
${v > 1 ? "4. Load-test with production-shaped traffic before turning it on per tenant.\n\n## Risks\n- Stale reads during bulk import: invalidate per batch, not at the end." : ""}`;

const MEMBERS: Record<string, Step[]> = {
  architect: [
    { post: "Starting point: an in-process LRU per instance. Our reads are ~90% product lookups by id, so a read-through cache in front of the repository gets most of the win without new infrastructure." },
    { draft: { name: "plan", kind: "plan", text: PLAN(1), note: "first draft" } },
    { post: "Fair point on bulk imports. I'll fold per-batch invalidation into the plan.", replyToLast: true },
    { draft: { name: "plan", kind: "plan", text: PLAN(2), note: "per-batch invalidation, load test" } },
    { pass: true },
  ],
  skeptic: [
    { post: "Before we pick a cache: what's the consistency requirement? If a price changes, how long may a stale price be shown? Nobody has said.", replyToLast: true },
    { post: "Bulk import writes thousands of rows. If we invalidate only at the end, readers see a half-updated catalog for the whole import.", replyToLast: true },
    { raise: { title: "Cache consistency during bulk import", why: "it keeps coming up and needs its own answer" } },
    { post: "With per-batch invalidation I can live with the plan, as long as the TTL stays short.", replyToLast: true },
    { pass: true },
  ],
  pragmatist: [
    { post: "Agree with an in-process LRU for now. Redis is a new thing to run and we don't have the traffic to justify it yet.", replyToLast: true },
    { post: "30 seconds of staleness is fine for product pages; checkout re-reads prices anyway.", replyToLast: true },
    { pass: true },
  ],
};
const GENERIC: Step[] = [
  { post: "One more angle: whatever we pick, we need a metric that tells us when it's wrong. Hit rate alone won't." },
  { pass: true },
];

const CHAIR = [
  "Good start. The architect proposed an in-process LRU; the skeptic wants a consistency requirement first. Skeptic, can you propose a number?\n>> nudge: pragmatist | You've been quiet on staleness. What would product accept?",
  "The room agrees on the LRU and is converging on short staleness. The bulk-import question keeps returning.\n>> raise: Cache consistency during bulk import | raised three times now",
  "Plan v2 addresses every objection on the table.\n>> accept: plan v2",
  "PASS",
];
const SCRIBE = [
  "=== decisions.md ===\n- Use an in-process LRU per instance, no shared cache yet (#5, #7).\n\n=== open-questions.md ===\n- How stale may a price be? (skeptic, #6)\n\n=== code-notes.md ===\n- Product reads go through the repository layer; writes come from update, delete and bulk import.",
  "=== decisions.md ===\n- Use an in-process LRU per instance (#5, #7).\n- 30 s TTL is acceptable for product pages; checkout re-reads prices (#9).\n\n=== open-questions.md ===\n- Invalidation strategy for bulk import (skeptic).",
  "NOTHING",
];
const WATCH = [
  "The room settled on an in-process cache quickly; the only real disagreement is about staleness during bulk imports (#8). Nothing needs you yet.",
  "They've repeated the bulk-import point a few times. A dedicated security view might catch what they're missing.\n>> add: security claude | nobody is looking at cache poisoning",
  "NOTHING",
];
const ANSWERS = [
  "In short: they agree on a simple in-process cache (#5, #7) and are debating how stale data may get. The skeptic's concern about bulk imports (#8) is the open thread.\n>> steer: Settle the staleness limit first, then the bulk-import strategy.",
  "The plan document is at v{plan}. The main risk they've named is stale reads during imports; nobody has argued for Redis since #7.",
];

class ScriptedRoomMock implements AgentTransport {
  readonly supportsMcp: boolean;
  private n = 0;

  constructor(
    readonly id: string,
    private readonly role: string,
    private readonly delayMs: number,
  ) {
    this.supportsMcp = !["assistant", "chair", "scribe"].includes(role);
  }

  private async *stream(text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    for (const chunk of text.match(/\S+\s*|\n/g) ?? [text]) {
      if (signal?.aborted) {
        yield { type: "error", message: "aborted" };
        return;
      }
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      yield { type: "text", delta: chunk };
    }
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgentEvent> {
    const i = this.n++;
    const pick = <T>(xs: T[]) => xs[i % xs.length];
    if (this.role === "chair") yield* this.stream(pick(CHAIR), opts.signal);
    else if (this.role === "scribe") yield* this.stream(pick(SCRIBE), opts.signal);
    else if (this.role === "assistant") {
      const asked = /The human asks you:/.test(prompt);
      const plan = /plan \(plan\) v(\d+)/.exec(prompt)?.[1] ?? "1";
      yield* this.stream(asked ? pick(ANSWERS).replace("{plan}", plan) : pick(WATCH), opts.signal);
    } else if (/You are leaving this Quorum room/.test(prompt)) {
      yield* this.stream("- Left open: the exact staleness limit.\n- Still believe the LRU is enough for now.", opts.signal);
    } else {
      yield* this.member(pick(MEMBERS[this.role] ?? GENERIC), prompt, opts);
    }
    yield { type: "done", sessionId: `${this.id}-mock` };
  }

  private async *member(step: Step, prompt: string, opts: SendOptions): AsyncIterable<AgentEvent> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs * 8));
    // Messages render as "[#N] name…", other events as "[#N] — …".
    const last = Math.max(0, ...[...prompt.matchAll(/\[#(\d+)\] (?!—)/g)].map((m) => Number(m[1])));
    const [name, args]: [string, Record<string, unknown>] =
      "pass" in step
        ? ["pass", {}]
        : "draft" in step
          ? ["doc_draft", step.draft]
          : "raise" in step
            ? ["raise_topic", step.raise]
            : ["post", { text: step.post, ...(step.replyToLast && last ? { reply_to: last } : {}) }];
    if (!opts.mcp) {
      yield* this.stream("pass" in step ? "PASS" : "post" in step ? step.post : `(${name})`, opts.signal);
      return;
    }
    yield { type: "tool", name: `mcp__quorum__${name}` };
    if (opts.signal?.aborted) return;
    await fetch(`${opts.mcp.env.QUORUM_ROOM_URL}/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.mcp.env.QUORUM_ROOM_TOKEN}` },
      body: JSON.stringify({ name, arguments: args }),
    }).catch(() => {});
    yield { type: "text", delta: "done" };
  }
}

/** Mock transports for a room; the persona (or support role) picks the script. */
export function mockRoomTransports(personaOf: (id: string) => string, delayMs = 25): TransportFactory {
  const cast = new Map<string, ScriptedRoomMock>();
  return (spec) => {
    let t = cast.get(spec.id);
    if (!t) cast.set(spec.id, (t = new ScriptedRoomMock(spec.id, personaOf(spec.id), delayMs)));
    return t;
  };
}
