# Council Analysis Script

Analyze Quorum council sessions using Langfuse traces.

## Quick Start

```bash
# Set up Langfuse credentials
export LANGFUSE_PUBLIC_KEY=pk-lf-xxxxx
export LANGFUSE_SECRET_KEY=sk-lf-xxxxx
export LANGFUSE_BASE_URL=https://cloud.langfuse.com

# Optional: for LLM-as-a-judge quality evaluation
export OPENROUTER_API_KEY=sk-or-xxxxx
export JUDGE_MODEL=anthropic/claude-haiku-5.5  # optional; any OpenRouter model id

# Run analysis on latest session
pnpm -C engine analyze

# Run on specific session
pnpm -C engine analyze --session abc-123-def

# Output as JSON
pnpm -C engine analyze --json
```

## What It Does

1. **Fetches traces** from Langfuse tagged with `quorum` and `council`
2. **Computes model performance** per agent:
   - Token usage (input/output/total)
   - Cost (USD)
   - Latency (avg per turn)
   - Error count
3. **Runs LLM-as-a-judge evaluations** (if API key provided):
   - Chair summary quality (clarity, completeness, actionability, neutrality)
   - Plan coherence (structure, specificity, consistency, feasibility)
   - Agent response relevance per agent
4. **Generates recommendations** based on thresholds:
   - Slow agents (>5s avg)
   - High error rates
   - Low relevance scores (<3/5)
   - Cost outliers
   - Quality issues

## Output

### Markdown (default)
Formatted box-drawing report saved to `engine/analysis/council-analysis-<session>-<timestamp>.md`

### JSON (`--json`)
Structured data for further processing

## Example Output

```
╔═══════════════════════════════════════════════════════════════╗
║  COUNCIL ANALYSIS REPORT                                       ║
╠═══════════════════════════════════════════════════════════════╣
║  Session: abc12345 | Topic: Design auth system | 2026-11-01  ║
║  Rounds: 5 | Converged: Yes | Cost: $0.28 | Tokens: 42,350    ║
╠═══════════════════════════════════════════════════════════════╣
║  MODEL PERFORMANCE                                             ║
║  Agent         Model                 Tokens   Cost      Lat   ║
║  ──────────────────────────────────────────────────────────    ║
║  architect     gpt-4 (codex)       15,600  $0.124    5.8s ⚠   ║
║  visionary     claude-3-5-sonnet   12,450  $0.089    3.2s     ║
║  skeptic       gpt-4o               8,200  $0.041    2.1s     ║
║  chair         claude-3-5-haiku     4,100  $0.021    1.4s     ║
╠═══════════════════════════════════════════════════════════════╣
║  QUALITY SCORES                                                ║
║  Chair:     Clarity 4.2 | Complete 3.8 | Action 4.1 | Neut 4.0║
║  Plan:      Struct 4.5 | Spec 3.2 | Consist 4.0 | Feas 3.9   ║
║  Relevance: Avg 3.7 (architect: 4.1, skeptic: 2.9 ⚠)         ║
╠═══════════════════════════════════════════════════════════════╣
║  RECOMMENDATIONS                                               ║
║  ⚠ architect (gpt-4): 5.8s avg latency — try faster model     ║
║  ⚠ skeptic relevance low (2.9/5) — review persona/prompt      ║
║  💰 architect costs $0.124 (44% of total) — evaluate value     ║
╚═══════════════════════════════════════════════════════════════╝
```

## Requirements

- Langfuse project with traces from Quorum (auto-tagged)
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`
- Optional: `OPENROUTER_API_KEY` (or Anthropic/OpenAI) for quality evaluation

## Langfuse Tags Used

The script filters traces with these tags (added automatically by Quorum tracing):
- `quorum` — all Quorum traces
- `council` — council sessions
- `agent:<name>` — per-agent turns
- `model:<model-id>` — per-model turns
- `round` — round spans
- `turn` — turn generations
- `tool` — tool calls

## Troubleshooting

**"No council traces found"**
- Verify Langfuse credentials are correct
- Run a council session first (`pnpm tui:mock` or `pnpm -C engine run --topic "test"`)
- Check Langfuse dashboard for traces with tags `quorum`, `council`

**"Judge evaluation failed"**
- Set `OPENROUTER_API_KEY` (recommended, works with any model)
- Or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- The script uses `anthropic/claude-3.5-haiku` via OpenRouter by default

**TypeScript errors**
- Run `pnpm -C engine typecheck` to verify