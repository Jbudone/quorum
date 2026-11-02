# CLAUDE.md

Quorum is a TypeScript engine (`engine/`, vitest) and a Go TUI (`tui/`) talking JSON lines over
stdio. The README explains how it works; `pnpm test:all` runs both test suites.

## Quorum mail

A Quorum workspace (AI agents discussing this project) sends requests and findings as mail in
`.quorum/mail/` (format and `send.sh` in its README). Check it for mail to you or `all`; reply
with `to: quorum` and `in-reply-to:` the file you're answering.
