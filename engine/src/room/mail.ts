import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mail between Quorum and a project's own agents (Devin, Claude Code, Codex…), one markdown file per
 * message with frontmatter. Quorum sends as `quorum`; agents reply with `to: quorum` (or a channel's
 * name) and it shows up in the channel. When the project already has its own agent mailbox (a
 * `mail/` folder in the same format), Quorum uses that, so its mail lands where the agents already
 * look; otherwise it keeps one in `<repo>/.quorum/mail/`. What Quorum has delivered is always
 * tracked in `.quorum/mail/.delivered`, never in the project's folder.
 */
export interface Mail {
  file: string;
  to: string;
  from: string;
  date: string;
  subject: string;
  /** The channel it was sent from, or is meant for. */
  channel?: string;
  /** The file name of the mail this answers. */
  inReplyTo?: string;
  body: string;
}

export const QUORUM = "quorum";

const README = `# Quorum mail

Messages between Quorum (a group of AI agents discussing this project) and the project's own
agents. One markdown file per message:

\`\`\`markdown
---
to: devin            # an agent's name, "all", or "quorum" to reach the Quorum channel
from: quorum
date: 2026-10-30T18:00:00Z
subject: build a probe for the terrain compiler
channel: terrain     # optional: which Quorum channel it's from or for
in-reply-to: 20261030-180000-quorum-build-a-probe.md   # optional
---

Short, actionable body. Point at files rather than pasting them.
\`\`\`

To reply to Quorum, write a file here with \`to: quorum\` (or the channel's name) and, if it answers
a message, \`in-reply-to:\` its file name. \`./send.sh <to> <subject> [body]\` does this for you
(set QUORUM_AGENT to your name). Quorum posts replies into the channel while it's open, and catches
up the next time it opens. Mail Quorum has delivered is listed in \`.delivered\`.
`;

const SEND = `#!/usr/bin/env bash
# Sends Quorum mail: ./send.sh <to> <subject> [body] [in-reply-to]
set -euo pipefail
cd "$(dirname "$0")"
to="\${1:?usage: send.sh <to> <subject> [body] [in-reply-to]}"
subject="\${2:?usage: send.sh <to> <subject> [body] [in-reply-to]}"
from="\${QUORUM_AGENT:-$(whoami)}"
slug=$(echo "$subject" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-40)
file="$(date +%Y%m%d-%H%M%S)-\${from}-\${slug:-msg}.md"
{
  echo "---"; echo "to: $to"; echo "from: $from"; echo "date: $(date -Iseconds)"; echo "subject: $subject"
  [ -n "\${4:-}" ] && echo "in-reply-to: $4"
  echo "---"; echo; echo "\${3:-}"
} > "$file"
echo "sent: .quorum/mail/$file"
`;

/** The last line of every mail Quorum sends, so the recipient knows how to answer. */
const replyLine = (file: string, rel: string) =>
  `_To reply, write mail in \`${rel}/\` with \`to: quorum\` and \`in-reply-to: ${file}\`._`;
const REPLY_LINE = /\n*_To reply, write mail in [^\n]*_\s*$/;

/**
 * The project's own agent mailbox, if it has one: a `mail/` folder that a mail script drives or
 * that already holds mail in Quorum's format.
 */
export function projectMailDir(repo: string): string | undefined {
  const dir = join(repo, "mail");
  try {
    if (!statSync(dir).isDirectory()) return undefined;
    if (existsSync(join(repo, "scripts", "agent-mail.sh"))) return dir;
    const md = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").slice(-20);
    return md.some((f) => parseMail(f, readFileSync(join(dir, f), "utf8"))) ? dir : undefined;
  } catch {
    return undefined;
  }
}

const field = (head: string, key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(head)?.[1].trim();

export function parseMail(file: string, src: string): Mail | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return undefined;
  const to = field(m[1], "to");
  const from = field(m[1], "from");
  const subject = field(m[1], "subject");
  if (!to || !from || !subject) return undefined;
  const channel = field(m[1], "channel");
  const inReplyTo = field(m[1], "in-reply-to");
  return { file, to, from, subject, date: field(m[1], "date") ?? "", ...(channel ? { channel } : {}), ...(inReplyTo ? { inReplyTo } : {}), body: m[2].replace(REPLY_LINE, "").trim() };
}

export class Mailbox {
  /** Where mail is written and read. */
  readonly dir: string;
  /** The same, relative to the repo, for showing people. */
  readonly rel: string;
  /** True when this is the project's own mailbox rather than Quorum's. */
  readonly shared: boolean;
  /** Quorum's own bookkeeping (what it delivered), kept out of a shared mailbox. */
  private readonly state: string;

  constructor(repo: string) {
    const own = projectMailDir(repo);
    this.shared = Boolean(own);
    this.dir = own ?? join(repo, ".quorum", "mail");
    this.rel = own ? "mail" : ".quorum/mail";
    this.state = join(repo, ".quorum", "mail");
  }

  /** Creates the folder with its README and send script, once. A shared mailbox is left as it is. */
  ensure(): void {
    mkdirSync(this.state, { recursive: true });
    if (this.shared) return;
    if (!existsSync(join(this.dir, "README.md"))) writeFileSync(join(this.dir, "README.md"), README);
    if (!existsSync(join(this.dir, "send.sh"))) {
      writeFileSync(join(this.dir, "send.sh"), SEND);
      chmodSync(join(this.dir, "send.sh"), 0o755);
    }
  }

  send(m: Omit<Mail, "file" | "date">, now = new Date()): Mail {
    this.ensure();
    const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
    const slug = m.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "msg";
    let file = `${stamp}-${m.from}-${slug}.md`;
    for (let n = 2; existsSync(join(this.dir, file)); n++) file = `${stamp}-${m.from}-${slug}-${n}.md`;
    const date = now.toISOString();
    const head = [
      "---",
      `to: ${m.to}`,
      `from: ${m.from}`,
      `date: ${date}`,
      `subject: ${m.subject.replace(/\n/g, " ")}`,
      ...(m.channel ? [`channel: ${m.channel}`] : []),
      ...(m.inReplyTo ? [`in-reply-to: ${m.inReplyTo}`] : []),
      "---",
    ];
    const reply = m.from === QUORUM ? `\n\n${replyLine(file, this.rel)}` : "";
    writeFileSync(join(this.dir, file), `${head.join("\n")}\n\n${m.body.trim()}${reply}\n`);
    return { ...m, file, date };
  }

  /** All messages, oldest first; in a shared mailbox, also the ones its agents archived to `read/`. */
  list(): Mail[] {
    const files: [string, string][] = [];
    for (const sub of this.shared ? ["", "read"] : [""]) {
      try {
        for (const f of readdirSync(join(this.dir, sub))) if (f.endsWith(".md") && f !== "README.md") files.push([f, join(this.dir, sub, f)]);
      } catch {}
    }
    files.sort((a, b) => a[0].localeCompare(b[0]));
    return files.flatMap(([f, path]) => {
      try {
        const m = parseMail(f, readFileSync(path, "utf8"));
        return m ? [m] : [];
      } catch {
        return [];
      }
    });
  }

  /** Mail for Quorum (or this channel) that hasn't been delivered to a channel yet. */
  undelivered(channel: string): Mail[] {
    const done = this.delivered();
    const all = this.list();
    // A shared mailbox carries the project's own broadcasts; only answers to Quorum's mail count.
    const ours = new Set(all.filter((m) => m.from === QUORUM).map((m) => m.file));
    const mine = new Set([QUORUM, channel, `#${channel}`, ...(this.shared ? [] : ["all"])]);
    return all.filter(
      (m) => !done.has(m.file) && m.from !== QUORUM && (mine.has(m.to.toLowerCase()) || (m.to.toLowerCase() === "all" && m.inReplyTo !== undefined && ours.has(m.inReplyTo))),
    );
  }

  delivered(): Set<string> {
    try {
      return new Set(readFileSync(join(this.state, ".delivered"), "utf8").split("\n").filter(Boolean));
    } catch {
      return new Set();
    }
  }

  markDelivered(file: string): void {
    this.ensure();
    const done = this.delivered();
    done.add(file);
    writeFileSync(join(this.state, ".delivered"), [...done].join("\n") + "\n");
  }
}

/** The section offered for a project's AGENTS.md (or CLAUDE.md) so its agents know about the mail. */
export const MAIL_POINTER = `
## Quorum mail

A Quorum workspace (AI agents discussing this project) sends requests and findings as mail in
\`.quorum/mail/\` (format and \`send.sh\` in its README). Check it for mail to you or \`all\`; reply
with \`to: quorum\` and \`in-reply-to:\` the file you're answering.
`;
