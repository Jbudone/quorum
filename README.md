# Quorum

A terminal UI where a council of AI agent CLIs (Claude Code, Codex, Antigravity/Gemini, Opencode) debates a hard feature and converges on a written plan. It drives the official CLIs headlessly, so it runs on your existing subscriptions, with no API keys.

- `engine/` TypeScript + Mastra: transports, protocols, Chair, sessions
- `tui/` Go + Bubble Tea: the interface (talks to the engine via NDJSON over stdio)
- `playground/` token-free scripted council and a fixture repo
- `presets/` `personas/` the four built-in councils and their roles

## Try it

```sh
cd quorum && pnpm install
./quorum --mock      # scripted agents, no tokens; works from any directory
./quorum             # real agents, grounded in the directory you run it from
pnpm tui:mock        # same, via pnpm (from quorum/ or quorum/engine/ only)
pnpm test:all        # engine + Go unit tests
```

Run `pnpm -C engine exec tsx src/cli.ts doctor` once first to see which agent CLIs are usable.
To start it from anywhere: `ln -s "$PWD/quorum" ~/.local/bin/quorum`, then run `quorum` inside any project.
`pnpm tui` only exists inside this checkout; from elsewhere use `./quorum` or `pnpm -C path/to/quorum tui`.

In the TUI: pick a council, say what to work out, and the council runs one round, then pauses.
At a pause, press Enter to continue, type to ask the Chair, `@name` to ask one member,
`/steer <directive>` to guide the next round, or `/stop` to finish. `ctrl+p` shows the plan.
Sessions are saved as plain files in `<repo>/.quorum/sessions/<id>/`.

Opt-in end-to-end tests: `cd tui && go test ./e2e` drives the real binary and engine in a pty
(`QUORUM_E2E_LIVE=1` runs one real Claude round; `QUORUM_E2E_OUT=dir` writes HTML screenshots).
