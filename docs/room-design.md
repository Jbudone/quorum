# Room mode: design

A long-running discussion where agents work in parallel on a problem, with the human present and a
personal assistant beside them. It runs until the human or the assistant pauses it, and can be resumed
days later.

Status: built (engine, RPC and TUI). See the README's "Channels" section for how to use it.

### Revision 3 (workspace, channels, threads)

The human's picture after using revision 2: a Slack workspace with top researchers and engineers that lives
for weeks, where they come back to ask questions, steer, and add feature requests. Their calls:

| Area | Decision |
| --- | --- |
| Structure | Workspace (the repo's `.quorum/`) → channels (rooms) → threads. Members belong to the workspace: invented personas live in `personas/`, notebooks in `members/<id>.md` and carry across channels, and each member sees its other channels' digests. |
| First run | No channel until the human approves a lineup. A setup chat with the assistant (`setup.*` RPC): short questions, then `>> channel / read / member` lines shown as a card; `ctrl+s` creates it, and every member gets a kickoff turn to read the reading list and give a first take. |
| Personas | Invented per problem by the assistant (research specialties, UX, use-case/edge-case roles), saved to the workspace; the built-in personas stay as templates. Mid-channel the assistant proposes `>> hire:` (new) or `>> add:` (a workspace member). |
| Reading list | Per channel. Members read it on their first turn and note what matters in their notebook; afterwards they're told which files changed (mtime) or were added. |
| Threads | A side conversation off any message (`/ask`, `/thread N`). Members see the channel digest, the root and the thread; each thread has its own vendor session per member. When it goes quiet the scribe posts a one-line outcome back. |
| Stats | The floor tags each message it reads (idea, critique, agreement, concession, question, evidence, decision; headline; whom it challenges) in the same call: a full-width strip of recent events, discussions (agreed/open) and member activity. |
| Assistant | Short, natural replies (one to three sentences). Column: a "needs you" card (selected only in `ctrl+n` review, so Enter always sends text), a two-line status, then the chat. Visible "typing" for the assistant and every support role. |
| Independent takes | Per-channel knob, default off (`/independent on`): members picked together draft from the same snapshot, then revise after reading whoever answered first. To be measured. |
| Rule | The human is never left unanswered: if the floor picks nobody after the human speaks, the member who spoke least recently in that conversation answers. |

Verified live (Claude Sonnet assistant, Haiku/Codex/opencode members, opencode floor): setup reply in ~8 s with
invented roles and a reading list it found; members cited real lines, conceded and retracted, drafted a
versioned spec; the assistant paused for review when the design converged and answered in ~4.5 s; a thread
question was answered in one line and its outcome posted back in ~30 s.

### Revision 2 (after the first review)

The first build woke every member on every new message, two at a time, so each one replied or passed in
turn: a round robin with extra steps. It also hid the room behind a toggle on the council's start screen.
The human's calls on the rework:

| Area | Decision |
| --- | --- |
| Placement | The room is the app. `quorum` opens this repo's latest room, or an empty one; `--council` keeps the round-based flow. |
| First launch | An empty room: the human and the assistant. The human's first message becomes the topic, and the assistant proposes members (`>> add:` lines) for one-key approval. |
| Turn-taking | Relevance-driven, behind a swappable `FloorPolicy` (a Chair-moderated policy can replace it later). After new messages one cheap call (`[floor]` in settings) names who, if anyone, should speak, and why. Silence is normal. A DM, or an `@name` from the human or the Chair, always gets an answer; between members `@name` is a hint to the floor (otherwise members ping-pong). Nobody answers their own message. |
| Speech | Members speak in their reply text, streamed live into the feed. Tools are side actions only (`dm`, `raise_topic`, `doc_draft`, `read_doc`, `read_room`, `notebook_*`); text written before a tool call is dropped as thinking aloud. A reply to a DM goes back privately. `PASS` says nothing. |
| Feed | Live chat: name, reply arrow, time and number above each message; members' words appear as they type; passes, floor decisions and scribe updates stay out of the feed. |
| Assistant | Always on screen (beside the feed, or under it below 64 columns). A pinned digest ("where we are") rewritten at each check-in, plus a note only when something shifts. |
| Reopening | A room paused only because the app closed carries on by itself; one paused by the human, the assistant, a milestone or the budget waits for `ctrl+p`. |

Implementation notes:
- Support roles (assistant, Chair) act through `>> verb: args | why` lines at the end of their replies rather than
  tools, so they work on every CLI. The scribe answers with whole files (`=== decisions.md ===`).
- Owed turns (the floor picked a member, but the room paused first) are saved, so a restart keeps them.
- Accepting a document (the Chair's call) pauses the room as a milestone; the assistant then explains why.
- Verified live (Claude Haiku, Codex, opencode, with an opencode floor): the first message lands in about 15 s,
  members cite code and concede points, and a 3-turn-per-CLI room settles in under two minutes.

## Decisions (first build; revision 2 above takes precedence)

| Area | Decision |
| --- | --- |
| Placement | New mode beside the round-based Council on the start screen. Shares transports, personas, digests, animations. Stored in `.quorum/rooms/<id>/`, resumable from a list. |
| Lifetime | Tied to the TUI. Closing the TUI pauses the room; reopening resumes from disk. Runs until the human or the assistant pauses it. |
| Source of truth | Append-only `events.jsonl`: messages, focus changes, joins/leaves, doc revisions, budget events. Everything else is derived. |
| Messaging | Addressed messages (room, topic thread, DM). Inboxes are filtered views of the log. Agents act only through a Quorum MCP server (`post`, `reply`, `dm`, `pass`, `read_inbox`, `doc_draft`, `raise_topic`, `notebook_*`). No direct file writes. |
| DMs | Allowed. Always visible to the assistant, which flags anything important. |
| Turn-taking | Event-driven: an agent wakes on a message to it, activity in its topic, or a mention. Concurrency cap, default 2, `/parallel N`. The Chair can nudge quiet agents. A turn must add a claim, evidence or a question, or `pass`. |
| Roles | Members (the discussion), Chair (runs the room: focus, topics, rules, accepts documents), Assistant (works for the human), Scribe (keeps the shared docs). |
| Assistant | Translates and summarizes with message-id citations, suggests next steps, flags tunnel vision, recommends roster changes (another role, a stronger model, several cheaper varied models), drafts messages to the room. Acts on its own only to pause. Every other change is a one-key approval in its pane. |
| Auto-pause triggers | Stuck or looping (no new claims, repeated arguments, a steer that didn't help); a decision only the human can make; budget threshold; milestone (topic done, document accepted). Each pause gives a one-line reason. |
| Topics | Agents raise topics (parked by default). One topic is in focus. Agents may leave short notes on parked topics. The Chair proposes focus switches and the human approves; the human can switch anytime. Each topic has exit criteria. |
| Memory | Three layers: the event log (raw); shared docs maintained by the Scribe (topic pages, decisions, facts, open questions, code notes); a private notebook per agent. Context is hybrid: resume the vendor session while fresh (ids saved to disk); rebuild from docs + notebook + inbox + recent activity after a restart, after N turns, or when context grows large. |
| Outputs | Dynamic: plan, issue list, decision records, whatever the discussion calls for. Any agent drafts or revises through `doc_draft` (versioned); the Chair marks a version accepted. Shown in a documents panel. |
| Issues | Room documents. Pushed to GitHub with `gh` only when the human approves (directly or via an assistant suggestion). |
| Code understanding | Read-only Read/Grep/Glob as today. Findings go into a code-notes doc tagged with the git commit; flagged stale when HEAD moves. Graphify later, only if it proves its worth. |
| Roster | Auto-designed at the start (reusing the council designer); agents can be added mid-room by persona + CLI or from an assistant suggestion. New agents get an onboarding brief built from the docs. |
| Removal | The agent gets a final turn to write an exit memo; its notebook is archived; it can be brought back later with its memory intact. |
| Budget | Hard stop on subscription quota % where the CLI reports it; per-CLI turn cap per resume where it doesn't. The assistant warns before the limit. |
| Support models | Per-role CLI and model in `settings.toml` (`[assistant]`, `[chair]`, `[scribe]`), like `[illustrator]`. Cheap model for the Scribe by default. Claude is never used silently; choices are visible in the roster drawer. |
| TUI | Side by side: room feed (wide, left) and assistant (narrow, right), each with its own input; Tab switches focus; falls back to tabs on narrow terminals. |
| Deferred | Repo write access (later via per-agent git worktrees); outside agents joining (keep the event format documented so it's possible). |

## Room folder

```
.quorum/rooms/<id>/
  room.json            config, roster, budgets, settings snapshot
  events.jsonl         append-only log (source of truth)
  agents/<id>.json     vendor session id, turn count, last-read event, status
  notebooks/<id>.md    private per-agent notes (archived on removal)
  docs/                Scribe-maintained shared docs
    topics/<slug>.md
    decisions.md  facts.md  open-questions.md  code-notes.md
  outputs/<slug>/      room-produced documents, one file per version + accepted marker
```

## Tool server (built)

Each turn gets a fresh token. The engine serves the room tools on a localhost port, and the CLI launches
`engine/bin/quorum-room-mcp.mjs`, a dependency-free stdio MCP bridge that forwards calls with the token, so
a member can only act as itself and only during its own turn. Since revision 2 the tools are side actions
(`dm`, `raise_topic`, `doc_draft`, `read_doc`, `read_room`, `notebook_*`); what a member says is its reply
text. Injection, verified live: Claude `--mcp-config` + `--allowedTools mcp__quorum`; Codex
`-c mcp_servers.quorum.*` with `default_tools_approval_mode="approve"`; opencode's inline config, run with
`--standalone` in the repo directory.

## Build order

Each step ends with something runnable, mostly against the mock transport.

1. **Log + scheduler + resume.** `events.jsonl`, the room store, an event-driven scheduler with the concurrency cap, vendor session ids persisted, pause/resume across an engine restart. Two mock agents.
2. **Quorum MCP server.** The agent tools, wired into each transport's MCP config; message validation and attribution.
3. **TUI room view.** Side-by-side panes, room feed, agent status (thinking / idle / waiting), pause/resume, posting as human.
4. **Assistant.** Summaries with citations, "since you left" digest, suggestions with one-key approval, auto-pause triggers.
5. **Scribe + docs + notebooks.** Context rebuild on wake; hybrid resume policy.
6. **Chair, topics and outputs.** Focus, parking, exit criteria, `doc_draft` versions, acceptance, documents panel, issue export.
7. **Roster changes.** Auto-design at start, add mid-room, onboarding brief, exit memo, bring back.
8. **Budgets and tunnel-vision signals.** Quota/turn caps, staleness and repetition metrics feeding the assistant.
9. **Dogfood.** Run a room on Quorum itself.

## Open for implementation

- The floor sees recent public messages only, so an objection older than its window can be dropped silently
  (a live room found this one itself). Candidates: give the floor `decisions.md` behind a flag, log empty
  floor decisions, and a replay test with an old open blocker.
- Thresholds for the hybrid context switch and the staleness metric; tune on real runs.
- Gemini and agy have no per-run way to add an MCP server, so they speak but can't take side actions. Revisit if either gains a flag.

## Future

- **Remote control from a phone (web interface).** Keep a room running on this machine and follow or steer it
  from a phone, like Claude Code's remote control. Shape: the engine (not the TUI) owns the running room, and a
  small authenticated web server exposes the same room RPC methods and event stream (SSE or WebSocket) that the
  TUI uses, with a mobile page showing the feed, the assistant pane and suggestion approvals. Things to settle
  first: whether the room keeps running when the TUI closes (today closing it pauses the room), how the phone
  reaches the machine (tailnet, tunnel, or relay), auth (pairing code + per-device token), and making the RPC
  multi-client so the TUI and phone can watch the same room at once.
