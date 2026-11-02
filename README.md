# Quorum

A terminal UI where you sit in a room with AI agent CLIs (Claude Code, Codex, Antigravity/Gemini, Opencode, Kimi Code, ZCode) while they work through a hard problem, with your own assistant beside you. It drives the official CLIs headlessly, so it runs on your existing subscriptions, with no API keys. A round-based council that converges on a written plan is still there with `--council`.

- `engine/` TypeScript + Mastra: transports, protocols, Chair, sessions
- `tui/` Go + Bubble Tea: the interface (talks to the engine via NDJSON over stdio)
- `playground/` token-free scripted council and a fixture repo
- `presets/` `personas/` the four built-in councils and their roles

## Try it

```sh
cd quorum && pnpm install
./quorum --mock      # scripted agents, no tokens; works from any directory
./quorum             # the room, grounded in the directory you run it from
./quorum --council   # the round-based council instead
pnpm tui:mock        # same, via pnpm (from quorum/ or quorum/engine/ only)
pnpm test:all        # engine + Go unit tests
```

Run `pnpm -C engine exec tsx src/cli.ts doctor` once first to see which agent CLIs are usable.
To start it from anywhere: `ln -s "$PWD/quorum" ~/.local/bin/quorum`, then run `quorum` inside any project.
`pnpm tui` only exists inside this checkout; from elsewhere use `./quorum` or `pnpm -C path/to/quorum tui`.

With `--council`: pick a council, say what to work out, and the council runs one round, then pauses.
At a pause, press Enter to continue, type to ask the Chair, `@name` to ask one member,
`/steer <directive>` to guide the next round, or `/stop` to finish. `alt+p` shows the plan. `/rounds N` and `/pause round|message|auto` retune pacing mid-session.

On the start screen, `alt+a` (or `e`) opens the settings drawer for the selected council: change protocol, rounds, pause, repo access, the Chair, and each member's persona, CLI and model, add or remove members, and press `s` to save it as your own council (stored in `~/.config/quorum/presets/`).
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

## Channels

`quorum` opens this project's workspace: long-lived channels where AI members work on a problem with you, like a team chat with researchers and engineers you can come back to for weeks.

The first time, there's no channel yet: you plan one with your assistant. Describe the problem and point it at the folder where earlier discussions are written up. It narrows things down with choice-card questions (arrow keys and Enter, or type your own answer), then proposes a plan: a vision pinned for every member, what must be considered, the docs to read first, a group it invents for the problem (say, a research lead, a movement-and-reachability specialist, an edge-case hunter, a feasibility analyst) and starter workstreams, each owned by two or three members working in parallel (real use cases, edge cases, what's impossible, the formal vision). `ctrl+s` opens the plan as a form: leave out anything, change any member's CLI (`c`) or model (`m`), and Enter applies it. Later, `alt+g` (or `/plan`) plans the next steps of the channel you're in the same way. After that, `quorum` picks up the latest channel where it left off. `alt+k` switches between channels and threads, or starts a new channel.

- **Nobody takes turns.** After each message the *floor* (one cheap model call) decides who, if anyone, has something to add, and those members speak, several at once, streaming in as they write. Your messages always get an answer; `@name` asks one member, and between members an `@name` is only a hint. A quiet channel is normal.
- **Threads.** `/ask …` asks in a side thread so a quick question doesn't fill the channel's context; `/thread N` opens one on message N. Members in a thread see the channel's summary and the thread, and its outcome posts back to the channel when it settles. `esc` returns.
- **The stats strip** across the top is a glance at where things stand: recent happenings (ideas, critiques, concessions, decisions), each discussion with what's agreed and what's open, and how each member is taking part. The floor tags every message as it reads it, so it costs nothing extra. `alt+s` hides it.
- **Your assistant** (the right-hand column) reads everything, private messages included, and talks in short plain sentences. At the top: what *needs you* (its suggestions, like bringing someone in or steering) and a two-line *where we are*. `alt+n` reviews the suggestions (`y`, `n`, `a` for all, `esc`); otherwise typing always goes to the chat. It can pause the channel itself when it's stuck, needs your call, hits a budget limit or reaches a milestone.
- **Bringing someone in.** `alt+a` (or `/add`) opens a short flow: an existing workspace member (with their memory) or someone new; a preset role (including research ones: research lead, literature scout, experimentalist, theorist, use-case scout, edge-case hunter, UX researcher, visionary, feasibility analyst), or one line the assistant turns into a persona you can edit; then a model from the model search (below); then onboarding: a catch-up brief written for their role, what they read first, and an optional first question they answer when they join. Approving an assistant's "bring in" suggestion (`y`) opens the same flow, filled in.
- **Members belong to the workspace.** They keep a private notebook across channels and see where their other channels stand, so the same researcher can bring what it learned in one channel to another. `/read docs/…` sets a channel's reading list; when files on it change, members read what changed. `/read ~/other-project` (any folder outside the project) lets everyone in the channel read it; agents run headless and can't ask for that permission themselves. It works in the planning chat too, and the assistant can propose it.
- **The Chair** keeps the discussion on the topic in focus, nudges quiet members, and accepts a document once members agree (the channel then pauses for you to review it). **The scribe** keeps short shared notes and writes each thread's outcome.
- `/dm name …` writes privately, `alt+p` pauses or resumes (a bar under the header always says which: a solid amber bar with the reason while paused, `● LIVE` otherwise), `ctrl+o` browses documents and notes, `/independent on` has members picked together draft without seeing each other and then revise (an experiment), and `/help` lists the rest. Quitting pauses the channel.
- **Picking models.** One search covers every model your harnesses and providers can run (about 9,000, from [models.dev](https://models.dev) plus each harness's own list). Pick a model and the harness that runs it is chosen for you, in your preferred order; `tab` switches to another (Claude Opus runs on `claude`, on `agy` at three effort levels, or on `opencode` with a key). Typing fuzzy-matches names, ids and providers (`opus5`, `sonet`); filter words narrow it: `provider:openrouter`, `via:kimi`, `free`, `fav`, `ready`, `reasoning`, `tools`, `vision`, `open`, `ctx>200k`, `$<3`. Results are grouped by provider, runnable first; providers you have no key for are folded and marked. Rows show context, price per Mtok and capabilities (R reasoning, T tools, V vision, O open weights); a side pane has details and every way to run the model. `alt+f` stars a favourite, `alt+c` folds a group. Favourites and recent picks lead the empty search, and the assistant sees them too.
- **Editing what the assistant proposes.** Reviewing suggestions (`alt+n`), `e` opens one as a form: rename a hire, rewrite its persona or a steer, pick its model in the search, change a mail's body. Your version is what's approved, and the log records that you changed it. The assistant now picks a harness and model for every member it proposes, from your favourites, what's runnable, prices and quota, and can suggest moving a member to another model (`swap`), which keeps the member's memory. `/swap <member>` does that directly, for support roles too (`/swap scribe`).
- **Budget** (the stats strip, `alt+s`): quota left on each harness the channel uses, with when it resets, and money left on pay-per-token providers, read from [OpenUsage](https://github.com/janekbaraniewski/openusage) (`openusage export`) when it's installed. Every turn, support roles' included, is recorded with its tokens, what it was billed (opencode and kimi) and what it would cost at API list prices (every harness, subscriptions too). `alt+v` switches the column between this sitting (since you opened the channel, with how far each quota moved), the whole channel, and the whole project; `alt+u` (or `/usage`) shows it all: every quota window and reset, then members, support roles, models, channels and past sittings.
- **Providers & models** (`alt+o`, or `/models`): star favourites; order harnesses (the first that can run a model is picked); see each provider's key status; name the env var a key lives in if it isn't the usual one (keys are never stored, only the variable's name); add custom OpenAI-compatible endpoints (LM Studio, vLLM, a proxy), which run through opencode. A local ollama shows up by itself. Saved in `~/.config/quorum/providers.toml`, which you can also edit by hand.
- **Budgets.** A CLI that reports its quota warns at 75% and pauses at 90%; others are held to a turn cap per resume (`/turns N`, default 40).
- **Reviewing documents.** When the Chair thinks the members agree on a document, it puts that version up for your review and the channel pauses; only you accept it. The review opens over the feed (`ctrl+r` brings it back, and `ctrl+o` opens any document the same way), with your assistant still beside it: `tab` asks about the document and the section you're on. It opens on the assistant's **brief**: what kind of document it is, whether it records work done or only proposes it, its main points in plain words, what approving means, and its weak spots: claims it leans on with no evidence or reason given. `[`/`]` move between sections, and sections that changed since the version you last reviewed are marked; `d` shows the diff. `a` approves, then offers to export it into the project (to the path an earlier export or suggestion used, and other export suggestions for it are withdrawn so you don't get two copies) and to hand it to the project's agents as mail asking them to carry it out. `c` asks its authors a question, and `r` asks its latest author for changes. Either way the channel picks it up and pauses again when it's done: with the answers, or with the new version for review. Approving closes the channel's open workstreams.
- **Accurate status.** The top of the assistant's column is the engine's own status line (who's speaking, how many are queued, which workstreams are open, what waits on you), with the assistant's one-line read under it. Ask the assistant where things stand and it answers from that live state, with a short **TL;DR** (done, in progress, waiting on you).
- **Planning works for this project.** A channel's deliverables are changes the project it runs in can make. Reviewing something from another project (say, a trial run there) turns its lessons into changes here: prompts, defaults, model choices, lineups. The planner asks only when you could mean work on the other project. Lineups give each seat a different job (no single role spread across several models), add an experimentalist who drafts probes for the project's agents to run, and a web-enabled literature scout when prior work matters.
- **The web, per member.** Members are offline by default. Mark a planned seat `+web`, approve the assistant's `>> web:` suggestion, or type `/web <member>` (`/web off <member>` takes it back). That member gets web search and fetch on Claude, Codex, OpenCode and ZCode, and is told to cite sources and never put project contents in a URL. This also turns off Codex's own default web search unless the member is granted the web.
- **Who can write what.** No agent in Quorum edits project files: members, Chair, scribe and assistant are all read-only. Shared work goes in channel documents, and only you put one into the project, by approving an export. The floor, scribe and Chair work from the transcript alone, with tools turned off where the CLI allows it (Claude, OpenCode, Kimi, ZCode), which keeps them fast and cheap.
- **Pauses.** Your pause (`alt+p`) stops turns at once, and the feed says whose turn was cut off; they pick up on resume. When the assistant pauses the channel because the work looks done, turns already underway finish first. Each sitting records the engine build that ran it (`sittings.jsonl`).
- **Records and mail.** Ask your assistant to note something down and it writes a channel document (versioned, `ctrl+o`); it can also export a document into the project and draft mail, both only once you approve. It withdraws its own suggestions when it replaces them.
- **Talking to the project's agents.** When the project already has an agent mailbox (a `mail/` folder in the same frontmatter format, or a `scripts/agent-mail.sh`), Quorum writes there, where its agents already look, and leaves the folder's own files alone. Otherwise its mail lives in `.quorum/mail/` (a README and `send.sh` explain the format), and the first mail offers to add a short pointer to the project's `AGENTS.md` or `CLAUDE.md` unless one is already there. Members and the assistant draft mail ("build this probe in a worktree"); you approve each one before it's sent. Every mail ends with how to reply; replies addressed `to: quorum` (or broadcasts answering Quorum's mail) show up in the channel, in the thread they answer.
- **Keeping the record honest.** The assistant watches for two kinds of drift as well as stalls: decisions piling up after the latest document was saved, and members describing probes that nobody has mailed. It asks for a new version or drafts the probe. Closing a round lists every proposed probe and whether it went out, and the Chair checks a document's load-bearing claims before accepting it.
- **Grading a channel.** `pnpm grade <room dir> [...]` scores finished channels from their logs, worst first: evidence (and the longest stretch without any), probes talked about vs sent vs answered, whether the final document kept up, seats that share a job or echo each other, how much the support roles posted, open questions and pending suggestions, and cost. It's model-free and read-only, so it's safe on live channels and comparable across engine versions; `--json` gives the numbers. `docs/grades.md` keeps baselines.
- **Selecting, pasting, typing.** Drag over the feed or the assistant's column to select; releasing copies it. `ctrl+v` pastes text, or an image from the clipboard as an `[image N]` chip (saved under `.quorum/attachments/`; whoever you send it to can look at it). The boxes grow as you type. `alt+w` widens the assistant's column (it's wide by itself until members start talking).
- **Keys.** Typing works as in a terminal (`ctrl+a`/`ctrl+e`, `ctrl+u`/`ctrl+k`, `ctrl+w`, `alt+b`/`alt+f`), so app actions use `alt`+letter; scroll with `pgup`/`pgdn` or the mouse.
- Everything is plain files in `<repo>/.quorum/`: `rooms/<id>/` per channel (`events.jsonl` is the whole history), `members/<id>.md` notebooks, `personas/` for invented members, `workspace.json`. Add `.quorum/` to the project's `.gitignore`.
- **Keeping every conversation.** `pnpm history:sync` copies Quorum's development sessions (Claude Code), every project's `.quorum/` (it remembers projects Quorum ran in; add one with `--project <path>`) and members' own vendor transcripts into `~/.local/share/quorum/history/raw/`, add-only: nothing there is ever summarized, replaced or deleted. Readable copies with likely secrets redacted go to `.quorum/history/` (index in its `README.md`), ready to give a channel as its reading list. Set `"cleanupPeriodDays": 100000` in `~/.claude/settings.json` so Claude Code keeps its transcripts, and a `SessionEnd` hook running `pnpm -s history:sync --quiet` keeps the copy current.

Choose who runs the support roles in `~/.config/quorum/settings.toml`. By default the assistant and Chair use the most capable CLI you have (Claude Sonnet first, so the assistant answers quickly), and the scribe and floor, which run often, the first of opencode, agy, codex:

```toml
[assistant]
cli = "claude"
model = "opus"

[scribe]
cli = "opencode"

[floor]
cli = "claude"
model = "haiku"
```


## Tracing

Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` to trace channels and council sessions to Langfuse. It sends prompts and replies (truncated), so read [what gets sent](docs/langfuse-integration.md#what-gets-sent) first.

## License

MIT. See [LICENSE](LICENSE).
