/**
 * Client for TypeSafe's Jev, a non-generative "System One" classifier served by OpenRouter's
 * Decisions API. It answers typed questions about a piece of text with calibrated probabilities;
 * it never writes prose, so Quorum uses it only to gate and verify, not to generate.
 *
 * The API is alpha and its docs disagree on a few details, so parsing here is deliberately
 * tolerant (answers may sit under `decisions` or `answers`).
 */
export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; categories: string[] }
  | { type: "score"; instructions: string; levels: string[] };

export interface Decision {
  value: unknown;
  probabilities: Record<string, number>;
}

export type Decide = (state: string, questions: Record<string, Question>) => Promise<Record<string, Decision>>;

export interface JevOptions {
  /** OpenRouter key. Read from OPENROUTER_API_KEY by default; never written to disk or logged. */
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

export function makeJev(o: JevOptions = {}): Decide | undefined {
  const apiKey = o.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;
  const doFetch = o.fetch ?? fetch;
  return async (state, questions) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 20_000);
    try {
      const res = await doFetch(o.endpoint ?? JEV_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: o.model ?? JEV_MODEL, state, questions }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`Jev returned HTTP ${res.status}`);
      const body: any = await res.json();
      const answers = body?.decisions ?? body?.answers;
      if (!answers || typeof answers !== "object") throw new Error("Jev reply had no decisions");
      const out: Record<string, Decision> = {};
      for (const [k, v] of Object.entries<any>(answers)) {
        out[k] = { value: v?.value, probabilities: v?.probabilities ?? {} };
        // Some responses give only a confidence for the chosen value.
        if (!Object.keys(out[k].probabilities).length && typeof v?.confidence === "number" && typeof v?.value === "boolean") {
          out[k].probabilities = { true: v.value ? v.confidence : 1 - v.confidence, false: v.value ? 1 - v.confidence : v.confidence };
        }
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Probability that a noul question is true; 0 when the answer is missing. */
export const probTrue = (d: Decision | undefined): number => {
  if (!d) return 0;
  if (typeof d.probabilities.true === "number") return d.probabilities.true;
  return d.value === true ? 1 : 0;
};
