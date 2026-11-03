# CLAUDE.md

Quorum is a TypeScript engine (`engine/`, vitest) and a Go TUI (`tui/`) talking JSON lines over
stdio. The README explains how it works; `pnpm test:all` runs both test suites.

## Quorum mail

A Quorum workspace (AI agents discussing this project) sends requests and findings as mail in
`.quorum/mail/` (format and `send.sh` in its README). Check it for mail to you or `all`; reply
with `to: quorum` and `in-reply-to:` the file you're answering.

## Prompt health

The engine mails prompts that newly need work (from channels' call logs) to `.quorum/mail/` as
`Prompt health: …`. `pnpm improve` prints the full report and `--diagnose` proposes edits. When
you change a prompt, its version changes by itself; the next report shows whether it helped.
