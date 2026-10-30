# Room mode: design

A long-running discussion where agents work in parallel on a problem, with the human present and a
personal assistant beside them. It runs until the human or the assistant pauses it, and can be resumed
days later.

Status: design agreed, not yet built.

## Decisions

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

- Exact wake rules (how much topic activity wakes a non-addressed agent) and per-agent cooldowns.
- Thresholds for the hybrid context switch and the staleness metric; tune on real runs.
- How each CLI's MCP config is injected per agent (Claude `--mcp-config`, Codex `-c mcp_servers…`, opencode / agy configs).
