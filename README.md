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
`/steer <directive>` to guide the next round, or `/stop` to finish. `ctrl+p` shows the plan. `/rounds N` and `/pause round|message|auto` retune pacing mid-session.

On the start screen, `ctrl+a` (or `e`) opens the settings drawer for the selected council: change protocol, rounds, pause, repo access, the Chair, and each member's persona, CLI and model, add or remove members, and press `s` to save it as your own council (stored in `~/.config/quorum/presets/`).
Sessions are saved as plain files in `<repo>/.quorum/sessions/<id>/`.

Opt-in end-to-end tests: `cd tui && go test ./e2e` drives the real binary and engine in a pty
(`QUORUM_E2E_LIVE=1` runs one real Claude round; `QUORUM_E2E_OUT=dir` writes HTML screenshots).

## Digests and the Auto council

Every council reply ends with a machine-readable TL;DR (headline, up to three bullets, a stance and a confidence). The TUI shows that card first, with a consensus board in the sidebar; press `ctrl+o` to show full replies.

Pick **auto** on the start screen and a model reads your topic, then proposes the council: protocol, rounds, which CLIs and models, and each member's role. You review it in the settings drawer, tweak anything, and press `g` to start.

## Animated diagrams

Fresh replies decode into view (scrambled glyphs resolving left to right). Replies can also gain a small animated diagram a moment after they land: a message **sequence** (a packet travels between actors), an **attack chain** (the threat moves step by step and the breach flashes), or a **verdict** when options are compared (a little figure tries each one, spits out the bad ones, beams at the good one, and a green box draws itself around the agreed winner). Agents never draw; a cheap model fills a fixed template and Quorum validates, repairs and animates it. `ctrl+r` replays the newest one; `--calm` (or `QUORUM_CALM=1`) shows final frames only.

The drawing model is the first usable of opencode, agy, codex (Claude is never used silently). Pick your own in `~/.config/quorum/settings.toml`:

```toml
[illustrator]        # cli = an agent CLI, or "openrouter" for a fast direct call (uses OPENROUTER_API_KEY)
cli = "openrouter"
model = "qwen/qwen3-30b-a3b-instruct-2507"

[jev]                # optional, opt-in: TypeSafe's Jev classifier gates and verifies diagrams
enabled = true       # needs OPENROUTER_API_KEY in your environment; reply text is sent to OpenRouter
```

With Jev on, a classifier first decides whether a diagram helps (skipping the generator call when not), then checks the finished diagram is faithful to the reply. If Jev is unreachable no unverified diagram is shown.

## Round debate map, open questions, and effects

- At the end of each round a **debate map** shows the council as a table: an agreement gauge, a line to each member (disagreement crackles with ⚡), their stance, and their headline typing itself into a bubble. It is built from the digests members already gave, so it always appears and needs no model.
- When the Chair leaves **open questions**, the TUI asks them one at a time before the next round: type an answer (it becomes a steering directive and is recorded in `decisions.md`), press Enter to skip one, or Esc to skip them all. `@name` and `/commands` still work while a question is up.
- Fresh text arrives with a mix of effects: decode, glitch-in, wipe and typewriter, followed by a shimmer across the headline. Force one with `QUORUM_FX=decode|glitch|wipe|type` to compare. Convergence gets a short sparkle in the header. `--calm` turns all of it off.
- If a diagram never appears, `~/.cache/quorum/engine.log` says why (gate score, rejected attempt, or Jev's faithfulness score).

## Speed, the split, option forms, and the topic picture

- Animations redraw at 24 fps and play 2 steps per tick (about 4.8x the original pace). `QUORUM_SPEED=1..8` changes the pace of everything together, `QUORUM_FPS=5..60` the redraw rate.
- The debate map opens with a **split**: twelve nodes fly out of the centre box to an *agree* branch (left) and a *differ* branch (right, red for disagree, yellow for mixed), so the proportions are visible before you read a word.
- Open questions are a **form** when the Chair offers answers: `↑↓` move, `space` picks (ticks, when several apply), `1-9` jump to an option, and you can still type your own answer or a note in the chat box. The Chair now gives each question 2-4 suggested answers (`Question? :: A | B | C`, `[multi]` for tick-several); plain yes/no questions get Yes / No / Decide later automatically.
- Every session opens with a full-screen **topic picture** (it holds the screen, looping, until an agent speaks) and keeps a copy at the top of the transcript: a small animated ASCII sprite chosen from the topic (burrito, pizza, coffee, chocolate, lock, database, server, cloud, bug, rocket and more; a lightbulb when nothing matches). Pieces fall in as it builds, then steam, sparkles or bits drift around it. In verdict scenes the taster holds the topic's own item.

## Rooms: an open-ended discussion

Press `ctrl+r` on the start screen to switch from **Council** (rounds, then a plan) to **Room**: the members talk continuously, in parallel, until you or your assistant pause them. Pick who's in the room the same way (a preset, the settings drawer, or auto), say what to work out, and press Enter. Saved rooms are listed under the topic box and reopen where they left off.

- **Two boxes.** The left one talks to the room (`@name` for a private message, `/help` for commands); the right one talks to your **assistant**, who reads everything (private messages included), answers with message numbers you can check, suggests next steps, and notices when the room is going in circles. `tab` switches boxes.
- **Suggestions** (add a member, change focus, steer, …) appear under the assistant. With its box empty, `↑↓` picks one, `y` approves, `n` declines. The assistant can pause the room on its own when it's stuck, needs your call, hits a budget limit, or reaches a milestone; everything else waits for you.
- **The Chair** keeps the discussion on the topic in focus, nudges quiet members, raises recurring side questions as parked topics, and accepts a document once members agree (the room then pauses for you to review it). **The scribe** keeps short shared notes (decisions, facts, open questions, code notes, a page per topic) that members read when they start fresh.
- **Members** speak through Quorum's tools (Claude, Codex and opencode; Gemini and agy use their reply text instead): post, private messages, pass, raise a topic, draft or revise a document, and a private notebook that survives restarts.
- `ctrl+p` pauses or resumes, `ctrl+o` browses documents and notes, `/focus`, `/raise`, `/add security claude`, `/remove skeptic` (it writes an exit memo first), `/parallel 3`, `/export issue-…` (files an issue document with `gh`), `/leave`. Quitting pauses the room.
- **Budgets.** A CLI that reports its quota warns at 75% and pauses the room at 90%; others are held to a turn cap per resume (`/turns N`, default 40).
- Rooms are plain files in `<repo>/.quorum/rooms/<id>/`: `events.jsonl` (the whole history), `docs/`, `outputs/<doc>/vN.md`, `notebooks/`. Headless: `pnpm -C engine exec tsx src/cli.ts room --repo "$PWD" --topic "..." [--mock] [--turns N]`.

Choose who runs the support roles in `~/.config/quorum/settings.toml` (by default the assistant and Chair use the council's Chair model, and the scribe the first of opencode, agy, codex):

```toml
[assistant]
cli = "claude"
model = "opus"

[scribe]
cli = "opencode"
```

