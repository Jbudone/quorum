package ui

import (
	"fmt"
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

func (r *roomModel) colorOf(th theme.Theme, id string) color.Color {
	switch id {
	case "human":
		return th.Accent2
	case "chair":
		return th.Chair
	case "assistant", "scribe":
		return th.Info
	}
	return th.Speaker(r.color(id))
}

func renderRoomHeader(r *roomModel, th theme.Theme, width int, spin string) string {
	left := fg(th.Accent2).Render("▓▒░ ") + theme.GradientShift("QUORUM", r.frame/2, th.Accent2, th.Accent, th.Info, th.Speaker(2)) +
		fg(th.Accent2).Render(" ░▒▓ ") + fg(th.Muted).Render("// room // ") + fg(th.Text).Render(r.focus)
	var chips []string
	for cli, q := range r.quota {
		c := th.Muted
		if q >= r.tuning.QuotaStop {
			c = th.Err
		} else if q >= r.tuning.QuotaWarn {
			c = th.Warn
		}
		chips = append(chips, fg(c).Render(fmt.Sprintf("%s %d%%", strings.ToUpper(cli), int(q*100+0.5))))
	}
	if n := len(r.pending); n > 0 {
		chips = append(chips, fg(th.Warn).Render(fmt.Sprintf("%d SUGGESTION%s", n, map[bool]string{true: "", false: "S"}[n == 1])))
	}
	switch r.state {
	case "running":
		chips = append(chips, fg(th.Accent2).Render(spin+" IN SESSION"))
	case "idle":
		chips = append(chips, fg(th.Info).Render("◌ QUIET"))
	default:
		chips = append(chips, fg(th.Warn).Bold(true).Render("❚❚ PAUSED"))
	}
	right := strings.Join(chips, fg(th.Subtle).Render("  ·  "))
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		return ansi.Truncate(left, width, "…")
	}
	return left + strings.Repeat(" ", gap) + right
}

// renderFeedItem draws one log entry; returns "" for entries the feed doesn't show.
func renderFeedItem(r *roomModel, it *feedItem, th theme.Theme, width int) string {
	if it.cache != "" && it.cacheW == width {
		return it.cache
	}
	e := it.ev
	seq := fg(th.Subtle).Render(fmt.Sprintf("#%d", e.Seq))
	line := func(glyph string, c color.Color, text string) string {
		return ansi.Truncate(fg(c).Render(glyph+" ")+fg(th.Muted).Render(text)+" "+seq, width, "…")
	}
	var out string
	switch e.Type {
	case "message":
		col := r.colorOf(th, e.From)
		head := fg(col).Bold(true).Render(e.From)
		if e.To != "room" {
			head += fg(th.Warn).Render(" → " + e.To + " (private)")
		}
		if e.ReplyTo > 0 {
			head += fg(th.Subtle).Render(fmt.Sprintf(" re #%d", e.ReplyTo))
		}
		if e.Topic != "" && e.Topic != r.focus {
			head += fg(th.Info).Render(" [" + e.Topic + "]")
		}
		head += " " + seq
		body := renderMarkdown(e.Text, max(width-2, 10), th)
		out = head + "\n" + prefixLines(body, fg(col).Render("│"))
	case "pass":
		out = line("·", th.Subtle, e.From+" passed")
	case "topic.raised":
		out = line("◆", th.Info, fmt.Sprintf("%s raised a topic: “%s” (%s)", e.By, e.Title, e.Slug))
	case "topic.focus":
		out = sectionTitle("focus → "+e.Slug, width, th, true)
	case "topic.closed":
		out = line("✓", th.OK, "topic "+e.Slug+" closed"+suffix(": ", e.Why))
	case "doc.revised":
		out = line("✎", th.Accent, fmt.Sprintf("%s wrote %s v%d%s  (/doc %s)", e.By, e.Slug, e.Version, suffix(" — ", e.Note), e.Slug))
	case "doc.accepted":
		out = fg(th.OK).Bold(true).Render(fmt.Sprintf("✓ %s v%d accepted", e.Slug, e.Version)) + " " + seq
	case "docs.updated":
		out = line("≡", th.Subtle, "scribe updated "+strings.Join(e.Files, ", "))
	case "agent.joined":
		out = line("+", th.OK, fmt.Sprintf("%s joined (%s on %s)", e.Agent, e.Persona, e.CLI))
	case "agent.left":
		out = line("−", th.Muted, e.Agent+" left"+suffix(" · memo: ", firstLine(e.Memo)))
	case "budget":
		c := th.Warn
		if e.Level == "stop" {
			c = th.Err
		}
		out = line("$", c, e.Detail)
	case "paused":
		out = fg(th.Warn).Render("❚❚ paused: "+e.Reason) + " " + seq
	case "resumed":
		out = fg(th.Subtle).Render("▶ resumed") + " " + seq
	case "turn.failed":
		out = line("✗", th.Err, e.Agent+": "+firstLine(e.Message))
	}
	it.cache, it.cacheW = out, width
	return out
}

func suffix(sep, s string) string {
	if strings.TrimSpace(s) == "" {
		return ""
	}
	return sep + s
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " …"
	}
	return s
}

func renderFeed(r *roomModel, th theme.Theme, width int, spin string) string {
	var blocks []string
	for _, it := range r.feed {
		if b := renderFeedItem(r, it, th, width); b != "" {
			blocks = append(blocks, b)
		}
	}
	// Members mid-turn: who, what tool, and the tail of what they're writing.
	for _, id := range r.speaking() {
		t := r.live[id]
		head := fg(r.colorOf(th, id)).Render(spin+" "+id) + fg(th.Muted).Italic(true).Render(" is thinking")
		if t.tool != "" {
			head += fg(th.Subtle).Render(" · " + t.tool)
		}
		if tail := lastLines(t.text, 2); tail != "" && t.tool == "" {
			head += "\n" + fg(th.Subtle).Italic(true).Render(ansi.Truncate(tail, width-2, "…"))
		}
		blocks = append(blocks, head)
	}
	if len(blocks) == 0 {
		return fg(th.Muted).Italic(true).Render("The room is empty so far.")
	}
	return strings.Join(blocks, "\n\n")
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " ")
}

// renderAssistant draws the assistant pane: the conversation, then open suggestions.
func renderAssistant(r *roomModel, th theme.Theme, width int, spin string, focused bool) string {
	var b []string
	if len(r.asides) == 0 && !r.asking {
		b = append(b, fg(th.Muted).Italic(true).Render("I read everything in the room, including private messages. Ask me what they mean, what to do next, or /catchup for a recap. I'll leave notes here when something needs you."))
	}
	for _, n := range r.asides {
		switch n.kind {
		case "you":
			b = append(b, fg(th.Accent2).Bold(true).Render("you")+"\n"+prefixLines(renderMarkdown(n.text, width-2, th), fg(th.Accent2).Render("│")))
		case "answer":
			b = append(b, fg(th.Info).Bold(true).Render("assistant")+"\n"+prefixLines(renderMarkdown(n.text, width-2, th), fg(th.Info).Render("│")))
		case "note":
			b = append(b, fg(th.Info).Render("◆ note")+"\n"+prefixLines(renderMarkdown(n.text, width-2, th), fg(th.Subtle).Render("│")))
		case "system":
			b = append(b, fg(th.Muted).Render(ansi.Wrap(n.text, width, "")))
		case "error":
			b = append(b, fg(th.Err).Render(ansi.Wrap("✗ "+n.text, width, "")))
		}
	}
	if r.asking {
		head := fg(th.Info).Bold(true).Render("assistant") + " " + fg(th.Muted).Render(spin)
		if a := r.streamingAnswer(); a != "" {
			head += "\n" + prefixLines(renderMarkdown(a, width-2, th), fg(th.Info).Render("│"))
		}
		b = append(b, head)
	}
	return strings.Join(b, "\n\n")
}

// renderSuggestions is the approval list pinned under the assistant's conversation.
func renderSuggestions(r *roomModel, th theme.Theme, width int, focused bool) string {
	if len(r.pending) == 0 {
		return ""
	}
	lines := []string{sectionTitle(fmt.Sprintf("suggestions · %d", len(r.pending)), width, th, focused)}
	for i, s := range r.pending {
		mark := fg(th.Subtle).Render("  ")
		label := fg(th.Text).Render(suggestionLabel(s))
		if i == r.sugCur && focused {
			mark = fg(th.Accent2).Render("❯ ")
			label = fg(th.Accent2).Bold(true).Render(suggestionLabel(s))
		}
		who := fg(th.Subtle).Render(" (" + s.From + ")")
		lines = append(lines, ansi.Truncate(mark+label+who, width, "…"))
		if s.Why != "" {
			lines = append(lines, fg(th.Muted).Render(ansi.Truncate("  "+s.Why, width, "…")))
		}
	}
	if focused {
		lines = append(lines, fg(th.Subtle).Render("y approve · n decline · ↑↓ choose"))
	}
	return strings.Join(lines, "\n")
}

// renderRoster is the one-line member strip above the inputs.
func renderRoomRoster(r *roomModel, th theme.Theme, width int, spin string) string {
	var parts []string
	for _, a := range r.agents {
		g := fg(th.Subtle).Render("○")
		if _, ok := r.live[a.ID]; ok {
			g = fg(th.Accent2).Render(spin)
		}
		parts = append(parts, g+" "+fg(r.colorOf(th, a.ID)).Render(a.ID)+fg(th.Subtle).Render(" "+a.CLI))
	}
	parts = append(parts, fg(th.Subtle).Render(fmt.Sprintf("· %d at once", r.tuning.Parallel)))
	return ansi.Truncate(strings.Join(parts, "  "), width, "…")
}

func renderTopics(r *roomModel) string {
	var b strings.Builder
	b.WriteString("Topics:\n")
	for _, t := range r.topics {
		mark := "  "
		state := ""
		switch {
		case t.Slug == r.focus:
			mark, state = "▶ ", " (in focus)"
		case t.Closed:
			state = " (closed)"
		default:
			state = " (parked)"
		}
		b.WriteString(mark + t.Slug + " — " + t.Title + state + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// docList builds the documents overlay: the room's outputs, then the scribe's notes.
func (r *roomModel) docList() []docRef {
	var refs []docRef
	for _, d := range r.docs {
		label := fmt.Sprintf("%s  %s v%d", d.Slug, d.Kind, d.Version)
		if d.Accepted > 0 {
			label += fmt.Sprintf("  ✓ v%d accepted", d.Accepted)
		}
		refs = append(refs, docRef{name: d.Slug, label: label})
	}
	for _, n := range r.notes {
		refs = append(refs, docRef{name: n, label: n + "  (scribe's notes)"})
	}
	return refs
}

func renderOverlay(o *docOverlay, th theme.Theme, width int) string {
	if o.list != nil {
		lines := []string{sectionTitle(o.title, width, th, true), ""}
		if len(o.list) == 0 {
			lines = append(lines, fg(th.Muted).Italic(true).Render("Nothing yet. Members write documents with doc_draft; the scribe keeps notes as the room talks."))
		}
		for i, d := range o.list {
			if i == o.cur {
				lines = append(lines, fg(th.Accent2).Bold(true).Render("❯ "+d.label))
			} else {
				lines = append(lines, fg(th.Text).Render("  "+d.label))
			}
		}
		lines = append(lines, "", fg(th.Subtle).Render("↑↓ choose · enter open · esc close"))
		return strings.Join(lines, "\n")
	}
	return sectionTitle(o.title, width, th, true) + "\n\n" + renderMarkdown(o.text, width, th) + "\n\n" + fg(th.Subtle).Render("esc close · pgup/pgdn scroll")
}

func roomFooter(r *roomModel, th theme.Theme, width int) string {
	k := func(key, what string) string { return fg(th.Text).Render(key) + " " + fg(th.Muted).Render(what) }
	sep := fg(th.Subtle).Render(" · ")
	pause := k("ctrl+p", "pause")
	if r.state == "paused" {
		pause = k("ctrl+p", "resume")
	}
	parts := []string{k("tab", "switch box"), pause, k("@name", "private"), k("ctrl+o", "docs"), k("/help", "commands"), k("ctrl+c", "quit")}
	if r.overlay != nil {
		parts = []string{k("esc", "close"), k("↑↓", "move"), k("enter", "open")}
	}
	for len(parts) > 1 && lipgloss.Width(strings.Join(parts, sep)) > width {
		parts = parts[:len(parts)-1]
	}
	return ansi.Truncate(strings.Join(parts, sep), width, "")
}
