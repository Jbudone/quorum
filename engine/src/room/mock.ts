import type { AgentEvent, AgentTransport, SendOptions } from "../transports/index.js";
import type { TransportFactory } from "./room.js";

/**
 * Token-free room cast for `--mock` and the TUI. It plays one coherent discussion and then runs
 * out of things to say, the way a real room settles. Members speak in their reply text and take
 * side actions through the real room tools (over the bridge's HTTP endpoint), the floor picks
 * whoever still has something to add, and the support roles answer in their real formats.
 */
type Line = { say: string; draft?: { name: string; kind: string; text: string; note: string }; raise?: { title: string; why: string } };

const PLAN = (v: number) => `# Plan: cache layer for the product API

## Decision
An in-process LRU per instance (64 MB), with a 30 s TTL on product reads and explicit invalidation on writes.

## Steps
1. Wrap the product repository with a read-through cache.
2. Invalidate on the three write paths (update, delete, bulk import).
3. Export hit rate and eviction counts.
${v > 1 ? "4. Load-test with production-shaped traffic before turning it on per tenant.\n\n## Risks\n- Stale reads during bulk import: invalidate per batch, not at the end." : ""}`;

const LINES: Record<string, Line[]> = {
  architect: [
    { say: "Starting point: an in-process LRU per instance. About 90% of our reads are product lookups by id, so a read-through cache in front of the repository gets most of the win without new infrastructure." },
    {
      say: "I've put up a first plan (plan v1): LRU, 30 s TTL, invalidate on the three write paths. @skeptic, does a 30 second bound answer your staleness question?",
      draft: { name: "plan", kind: "plan", text: PLAN(1), note: "first draft" },
    },
    {
      say: "@skeptic is right about bulk imports. Plan v2 invalidates per batch instead of at the end, and adds a load test before we turn it on.",
      draft: { name: "plan", kind: "plan", text: PLAN(2), note: "per-batch invalidation, load test" },
    },
  ],
  skeptic: [
    { say: "Before we pick a cache: what's the consistency requirement? If a price changes, how long may a stale price be shown? Nobody has said." },
    {
      say: "For single writes, yes. But bulk import writes thousands of rows; if we only invalidate at the end, readers see a half-updated catalog for the whole import.",
      raise: { title: "Cache consistency during bulk import", why: "it needs its own answer before we ship" },
    },
    { say: "If we invalidate per batch instead of at the end, I can live with it, as long as the TTL stays short." },
  ],
  pragmatist: [
    { say: "Agree with an in-process LRU for now. Redis is one more thing to run, and we don't have the traffic to justify it yet." },
    { say: "30 seconds of staleness is fine for product pages; checkout re-reads prices anyway." },
  ],
  security: [{ say: "One angle nobody has covered: a cache keyed only by product id will happily serve one tenant's draft prices to another if ids ever collide across tenants. Key by tenant and id." }],
};
const GENERIC: Line[] = [{ say: "Whatever we pick, we need a metric that tells us when it's wrong; hit rate alone won't." }];

const STAFF = `For a caching decision I'd start with three people who will disagree usefully: someone to propose the design, someone to attack its consistency story, and someone to keep it simple.
>> add: architect mock | proposes the design and writes the plan
>> add: skeptic mock | will press on consistency and failure modes
>> add: pragmatist mock | keeps scope and operational cost honest`;

/** Shared script state, so the floor knows who still has something to say. */
class Cast {
  readonly used = new Map<string, number>();
  watches = 0;
  answers = 0;
  scribes = 0;
  chairs = 0;
  lines(persona: string): Line[] {
    return LINES[persona] ?? GENERIC;
  }
  left(persona: string): number {
    return this.lines(persona).length - (this.used.get(persona) ?? 0);
  }
  next(persona: string): Line | undefined {
    const i = this.used.get(persona) ?? 0;
    this.used.set(persona, i + 1);
    return this.lines(persona)[i];
  }
}

class ScriptedRoomMock implements AgentTransport {
  readonly supportsMcp: boolean;

  constructor(
    readonly id: string,
    private readonly role: string,
    private readonly delayMs: number,
    private readonly cast: Cast,
    private readonly personaOf: (id: string) => string,
  ) {
    this.supportsMcp = !["assistant", "chair", "scribe", "floor"].includes(role);
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
    const c = this.cast;
    if (this.role === "floor") yield* this.stream(this.floor(prompt), opts.signal);
    else if (this.role === "chair") yield* this.stream(this.chair(prompt), opts.signal);
    else if (this.role === "scribe") yield* this.stream(c.scribes++ < 2 ? SCRIBE[c.scribes - 1] : "NOTHING", opts.signal);
    else if (this.role === "assistant") yield* this.stream(this.assistant(prompt), opts.signal);
    else if (/You are leaving this Quorum room/.test(prompt)) {
      yield* this.stream("- Left open: the exact staleness limit.\n- Still believe the LRU is enough for now.", opts.signal);
    } else yield* this.member(prompt, opts);
    yield { type: "done", sessionId: `${this.id}-mock` };
  }

  /** Picks whoever has the most left to say, never the latest speaker; nobody once the script is spent. */
  private floor(prompt: string): string {
    const roster = prompt.slice(prompt.indexOf("Members:\n"), prompt.indexOf("\n\n", prompt.indexOf("Members:\n")));
    const members = [...roster.matchAll(/^- ([\w-]+):/gm)].map((m) => m[1]);
    const fresh = prompt.slice(prompt.indexOf("New since you last decided:"));
    const said = [...fresh.matchAll(/\[#(\d+)\] ([\w-]+)/g)];
    const last = said.at(-1);
    const busy = new Set([...roster.matchAll(/^- ([\w-]+):.*\(speaking right now\)$/gm)].map((m) => m[1]));
    const pick = members
      .filter((m) => m !== last?.[2] && !busy.has(m) && this.cast.left(this.personaOf(m)) > 0)
      .sort((a, b) => this.cast.left(this.personaOf(b)) - this.cast.left(this.personaOf(a)))[0];
    return JSON.stringify({ speak: pick ? [{ member: pick, reply_to: Number(last?.[1]) || undefined, why: "has something to add on this" }] : [] });
  }

  private chair(prompt: string): string {
    if (/plan \(plan\) v2/.test(prompt) && !/v2 accepted/.test(prompt)) return "Plan v2 answers every objection raised so far.\n>> accept: plan";
    if (this.cast.chairs++ === 0) return "Quick summary: everyone backs an in-process LRU; the open question is how stale a read may be during bulk import. @pragmatist, what will product accept?";
    return "PASS";
  }

  private assistant(prompt: string): string {
    const c = this.cast;
    if (/The room has no members yet/.test(prompt)) return STAFF;
    const plan = /plan \(plan\) v(\d+)/.exec(prompt)?.[1];
    if (/The human asks you:/.test(prompt)) {
      return c.answers++ === 0
        ? `In short: they agree on a simple in-process cache and are now arguing about how stale data may get. The skeptic's bulk-import concern is the open thread${plan ? `; the plan is at v${plan}` : ""}.\n>> steer: Settle the staleness limit first, then the bulk-import strategy.`
        : `The plan document is at v${plan ?? "0"}. The main risk they've named is stale reads during imports; nobody has argued for Redis.`;
    }
    const digest = `DIGEST:\n- Agreed: an in-process LRU per instance, no Redis yet.\n- Contested: staleness during bulk import (skeptic).\n- ${plan ? `Plan is at v${plan}.` : "No plan drafted yet."}`;
    const n = c.watches++;
    if (n === 0) return `${digest}\nNOTE: They converged on the LRU quickly; the only real disagreement is bulk-import staleness. Nothing needs you yet.`;
    if (n === 1) return `${digest}\nNOTE: Nobody is looking at tenant isolation in the cache keys.\n>> add: security mock | nobody covers cache poisoning or tenant isolation`;
    return digest;
  }

  private async *member(prompt: string, opts: SendOptions): AsyncIterable<AgentEvent> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs * 8));
    const line = this.cast.next(this.role);
    if (!line) {
      yield* this.stream("PASS", opts.signal);
      return;
    }
    const action: [string, Record<string, unknown>] | undefined = line.draft ? ["doc_draft", line.draft] : line.raise ? ["raise_topic", line.raise] : undefined;
    if (action && opts.mcp) {
      yield { type: "text", delta: "Let me write that down first." };
      yield { type: "tool", name: `mcp__quorum__${action[0]}` };
      if (opts.signal?.aborted) return;
      await fetch(`${opts.mcp.env.QUORUM_ROOM_URL}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.mcp.env.QUORUM_ROOM_TOKEN}` },
        body: JSON.stringify({ name: action[0], arguments: action[1] }),
      }).catch(() => {});
    }
    yield* this.stream(line.say, opts.signal);
  }
}

const SCRIBE = [
  "=== decisions.md ===\n- Use an in-process LRU per instance, no shared cache yet.\n\n=== open-questions.md ===\n- How stale may a price be? (skeptic)\n\n=== code-notes.md ===\n- Product reads go through the repository layer; writes come from update, delete and bulk import.",
  "=== decisions.md ===\n- Use an in-process LRU per instance.\n- 30 s TTL is acceptable for product pages; checkout re-reads prices.\n\n=== open-questions.md ===\n- Invalidation strategy for bulk import (skeptic).",
];

/** Mock transports for a room; the persona (or support role) picks the script. */
export function mockRoomTransports(personaOf: (id: string) => string, delayMs = 25): TransportFactory {
  const cast = new Cast();
  const made = new Map<string, ScriptedRoomMock>();
  return (spec) => {
    let t = made.get(spec.id);
    if (!t) made.set(spec.id, (t = new ScriptedRoomMock(spec.id, personaOf(spec.id), delayMs, cast, personaOf)));
    return t;
  };
}
