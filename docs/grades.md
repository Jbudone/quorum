# Channel grades

Baselines from `pnpm grade`, to compare later channels against. Each was graded with the grader as
first committed; rerun older rooms after changing the grader so the numbers stay comparable.

What the grader can't see: whether the channel worked on the right problem. The loom-postmortem
graded fairly well here, but it aimed part of its output at Loom instead of Quorum (fixed in
`b96e156`). Read the final document as well as the grade.

## Baseline: the Loom research trial (Loom, 2026-10-30, engine before `dd8be40`)

Nine members, four of them the same "master researcher" job on different models. Fifteen member
messages discussed probes and none were sent; the assistant posted more than the members did, and
withdrew 16 of its 29 suggestions. Recorded before usage was tracked, so its cost is unknown.

- ✗ **probes:** 15 member messages discuss probes or experiments; 1 were drafted as mail and none were sent.
- ✗ **lineup:** 4 seats share one job (master researcher): ideas-claude, ideas-codex, ideas-deepseek, ideas-kimi.
- ✗ **support:** Support roles posted 34 times against 24 member messages.
- ! **evidence:** 16 member messages in a row with no evidence.
- ! **documents:** 9 document versions and none approved.
- ! **lineup:** 9 members; past six, seats tend to overlap.
- ! **support:** 16 of 29 suggestions were withdrawn and replaced before the human answered.
- ! **closure:** 2 of 2 tagged questions got no direct reply.
- ! **closure:** 2 suggestions were still waiting on the human at the end.
- ! **cost:** No usage was recorded, so the channel's cost is unknown.

Members: pcg-researcher 3, edge-case-critic 3, level-artist 3, agents-researcher 3, eval-scientist 3, ideas-claude 3, ideas-codex 2, ideas-deepseek 1, ideas-kimi 3
Messages: 24 member, 2 human, 7 support, 27 assistant asides, 0 passes
Suggestions: 29 (11 accepted, 0 declined, 16 withdrawn, 2 pending)
Tags: 1 evidence, 6 decisions, 2 questions
Docs: 9 versions, 0 approved, 1 exported
Mail: 1 drafted, 0 sent, 0 replies
Closest seats: pcg-researcher/level-artist 19%, pcg-researcher/eval-scientist 17%, agents-researcher/eval-scientist 15%

## Baseline: the loom-postmortem (Quorum, 2026-10-31)

Five members with distinct jobs, 13 pieces of evidence and one approved, exported document. The
probe it drafted was never sent; process-skeptic wrote almost half the member messages.

- ✗ **probes:** 4 member messages discuss probes or experiments; 1 were drafted as mail and none were sent.
- ! **evidence:** 17 member messages in a row with no evidence.
- ! **lineup:** process-skeptic wrote 45% of the member messages.
- ! **closure:** 2 suggestions were still waiting on the human at the end.
- ✓ **closure:** 1 of 3 tagged questions got no direct reply.
- ✓ **cost:** $10.57 at list prices, $10.57 per approved document.

Members: process-skeptic 28, pm-lead 11, loom-reviewer 5, engine-architect 13, prompt-ux 5
Messages: 62 member, 7 human, 4 support, 19 assistant asides, 0 passes
Suggestions: 2 (0 accepted, 0 declined, 0 withdrawn, 2 pending)
Tags: 13 evidence, 12 decisions, 3 questions
Docs: 27 versions, 1 approved, 1 exported
Mail: 1 drafted, 0 sent, 0 replies
Closest seats: process-skeptic/engine-architect 12%, pm-lead/engine-architect 10%, pm-lead/loom-reviewer 8%
