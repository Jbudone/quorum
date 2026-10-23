# Quorum

A TUI council of AI agent CLIs (Claude Code, Codex, Gemini CLI, Opencode) that debate a hard feature and converge on a formal plan. Runs on your subscriptions by driving the official CLIs headlessly.

- `engine/` TypeScript + Mastra: transports, protocols, Chair, sessions
- `tui/` Go + Bubble Tea: the interface (talks to the engine via NDJSON over stdio)
- `playground/` token-free mock council and a fixture repo

Try it: `pnpm install && pnpm test && pnpm playground:run`

Plan: see `~/.claude/plans/we-are-creating-a-adaptive-rose.md`.
