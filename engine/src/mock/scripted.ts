import { MockTransport } from "../transports/mock.js";

/** Plausible, role-aware replies so the TUI and playground can be exercised without spending tokens. */
const PLAN_V1 = `# Plan: replace session cookies with short-lived JWTs

## Goals
- Issue 10-minute access tokens and rotate refresh tokens server-side.
- Keep existing cookie sessions working during a dual-read window.

## Non-goals
- No SSO changes in this milestone.

## Design
- A token service signs access tokens and stores refresh-token hashes with a family id.
- Middleware accepts either a valid JWT or a legacy cookie, and logs which one it saw.

## Sequencing
1. Ship the token service behind a per-tenant flag.
2. Turn on dual-read, then measure the login error rate.
3. Retire cookies once the error rate holds for two weeks.

## Risks
- Refresh-token theft, and no defined exit criteria for dual-read.`;

const PLAN_V2 = `${PLAN_V1}

## Revision notes
- Added refresh-token reuse detection: reuse revokes the whole family.
- Dual-read exits when cookie traffic is under 1% for 14 days; rollback is the tenant flag.

## Rejected objections
- **Dropping the dual-read window:** too risky for mobile clients that cannot update quickly.`;

const CRITIQUES: Record<string, string> = {
  skeptic:
    "1. **Critical:** refresh rotation without reuse detection is a theft vector.\n2. **High:** the dual-read window has no exit criteria or rollback path.\n3. **Medium:** nothing says where signing keys live or how they rotate.",
  pragmatist:
    "1. **High:** this is two migrations in one. Ship the token service first, behind a flag, and cut SSO entirely.\n2. **Medium:** the two-week soak is a guess; tie it to an error-rate threshold instead.",
  security:
    "Use asymmetric signing so verifiers never hold the signing key. Bind refresh tokens to a device id and rate-limit the refresh endpoint.",
  operator:
    "I need a kill switch per tenant, a dashboard of cookie vs JWT traffic, and a runbook for key rotation before this goes live.",
  "user-advocate":
    "Forced logouts are the worst outcome. Make rotation silent, and show a clear message when a session is revoked.",
};

const POSITIONS: Record<string, [string, number]> = {
  architect: ["Short-lived JWTs with server-side refresh rotation behind a tenant flag.", 78],
  skeptic: ["Same design, but only with reuse detection and defined dual-read exit criteria.", 55],
  pragmatist: ["Ship only the token service this milestone; defer dual-read tuning.", 70],
  security: ["Adopt asymmetric signing and device-bound refresh tokens.", 72],
  operator: ["Fine if there is a per-tenant kill switch and a key-rotation runbook.", 65],
};

function chairReport(round: number, total: number): string {
  const done = round >= total;
  return [
    done
      ? "The council has settled on the token service behind a flag, with reuse detection and measurable dual-read exit criteria. The remaining question is key rotation ownership."
      : "They agree on short-lived tokens and a flag-based rollout. They still disagree on how much to ship at once: the Pragmatist wants the token service alone, the Skeptic wants reuse detection first. You could steer toward either scope.",
    "## DISSENT",
    done ? "- Pragmatist: still prefers shipping the token service alone." : "- Pragmatist: ship only the token service this milestone.\n- Skeptic: reuse detection must land in the same release.",
    "## OPEN QUESTIONS",
    "- Who owns signing-key rotation?\n- What cookie-traffic threshold ends the dual-read window?",
    `CONVERGED: ${done ? "yes" : "no"}`,
  ].join("\n");
}

const TLDRS: Record<string, string> = {
  skeptic: "headline: Rotation needs reuse detection and an exit plan\nstance: disagree\nconfidence: 80\n- Refresh theft is the critical gap\n- Dual-read has no exit or rollback\n- Key custody is undefined",
  pragmatist: "headline: Ship the token service alone first\nstance: mixed\nconfidence: 70\n- Two migrations in one is too big\n- Cut SSO from this milestone\n- Tie the soak to an error rate",
  security: "headline: Asymmetric signing, device-bound refresh\nstance: mixed\nconfidence: 72\n- Verifiers must not hold signing keys\n- Rate-limit the refresh endpoint",
  operator: "headline: Needs a kill switch and runbook\nstance: mixed\nconfidence: 65\n- Per-tenant kill switch\n- Cookie vs JWT traffic dashboard\n- Key-rotation runbook",
  "user-advocate": "headline: Never force a surprise logout\nstance: mixed\nconfidence: 68\n- Make rotation silent\n- Explain revoked sessions clearly",
  architect: "headline: Short-lived JWTs with refresh rotation\nstance: agree\nconfidence: 78\n- Flag-gated per tenant\n- Dual-read bridges old cookies\n- Reuse detection revokes the family",
};

const withTldr = (reply: string, block: string): string => `${reply}\n\n<tldr>\n${block}\n</tldr>`;

export function scriptedMock(id: string, personaKey: string, chunkDelayMs = 10): MockTransport {
  const t = new MockTransport(id, { rules: [], chunkDelayMs });
  t.send = (prompt, opts) => {
    let reply: string;
    const close = /closing round (\d+) of (\d+)/.exec(prompt);
    if (close) reply = chairReport(Number(close[1]), Number(close[2]));
    else if (/first full draft/.test(prompt)) reply = PLAN_V1;
    else if (/Independent critiques|Produce the full revised plan/.test(prompt)) reply = PLAN_V2;
    else if (/Synthesize the panel/.test(prompt)) reply = PLAN_V2;
    else if (/POSITION:/.test(prompt)) {
      const [pos, conf] = POSITIONS[personaKey] ?? ["Proceed with the flagged rollout.", 60];
      reply = `POSITION: ${pos}\nREASONS: Limits blast radius, reversible, measurable.\nRISKS: Underestimating client update lag.\nCONFIDENCE: ${conf}`;
    } else if (/The human says to you:/.test(prompt)) reply = `Understood. ${(CRITIQUES[personaKey] ?? "I will take that into account.").split("\n")[0]}`;
    else if (/The human asks:/.test(prompt))
      reply = "The Skeptic and Pragmatist disagree about scope, not direction: one wants more safety in the first release, the other wants a smaller first release. Either is defensible; the deciding factor is how costly a token-theft incident would be for you.";
    else reply = CRITIQUES[personaKey] ?? "I broadly agree with the direction, with a few caveats worth tracking.";
    if (!close && personaKey !== "chair" && !/POSITION:/.test(prompt)) {
      const own = TLDRS[personaKey] ?? "headline: Broadly agree, with caveats\nstance: agree\nconfidence: 60\n- Direction is sound\n- A few caveats to track";
      reply = withTldr(reply, /first full draft|Produce the full revised plan|Synthesize/.test(prompt) ? TLDRS.architect : own);
    }
    return new MockTransport(id, { rules: [], fallback: reply, chunkDelayMs }).send(prompt, opts);
  };
  return t;
}
