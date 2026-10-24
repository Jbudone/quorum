package ui

import (
	"fmt"
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

func fg(c color.Color) lipgloss.Style { return lipgloss.NewStyle().Foreground(c) }

func (s *session) memberColor(th theme.Theme, id string) color.Color {
	if id == "chair" {
		return th.Chair
	}
	if m := s.find(id); m != nil && m.color >= 0 {
		return th.Speaker(m.color)
	}
	return th.Muted
}

// prefixLines puts a colored bar in front of every line of body.
func prefixLines(body string, bar string) string {
	lines := strings.Split(body, "\n")
	for i, l := range lines {
		lines[i] = bar + " " + l
	}
	return strings.Join(lines, "\n")
}

// renderEntry renders one transcript block at the given width. spin is the current spinner frame.
func renderEntry(s *session, e *entry, th theme.Theme, width int, spin string) string {
	if !e.streaming && e.cache != "" && e.cacheW == width {
		return e.cache
	}
	out := drawEntry(s, e, th, width, spin)
	if !e.streaming {
		e.cache, e.cacheW = out, width
	}
	return out
}

func drawEntry(s *session, e *entry, th theme.Theme, width int, spin string) string {
	switch e.kind {
	case kindRound:
		label := fmt.Sprintf(" Round %d of %d ", e.round, e.total)
		side := (width - lipgloss.Width(label)) / 2
		if side < 2 {
			side = 2
		}
		rule := fg(th.Subtle).Render(strings.Repeat("─", side))
		return rule + fg(th.Muted).Bold(true).Render(label) + rule

	case kindSystem:
		return fg(th.Muted).Italic(true).Render(wrapPlain("· "+e.text, width, th))

	case kindError:
		return fg(th.Err).Render(ansi.Wrap("✗ "+e.text, width, ""))

	case kindSummary:
		box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(th.Chair).Padding(0, 1).Width(width)
		title := fg(th.Chair).Bold(true).Render(fmt.Sprintf("Chair · round %d summary", e.round))
		body := wrapPlain(e.text, width-4, th)
		if e.converged {
			body += "\n\n" + fg(th.OK).Bold(true).Render("✓ The council has converged")
		}
		return box.Render(title + "\n" + body)

	case kindHuman:
		bar := fg(th.Warn).Render("▌")
		head := bar + " " + fg(th.Warn).Bold(true).Render("you") + fg(th.Muted).Render(" → "+e.to)
		return head + "\n" + prefixLines(wrapPlain(e.text, width-2, th), bar)
	}

	// Agent entries.
	col := s.memberColor(th, e.speaker)
	bar := fg(col).Render("▌")
	name := e.speaker
	meta := ""
	if m := s.find(e.speaker); m != nil {
		meta = m.role
		if m.cli != "" {
			meta += " · " + m.cli
		}
	}
	head := bar + " " + fg(col).Bold(true).Render(name) + "  " + fg(th.Muted).Render(meta)

	var body string
	switch {
	case e.artifact == "chair-report" && !e.streaming:
		return "" // the Chair's summary callout replaces the raw report
	case e.artifact == "chair-report":
		body = fg(th.Muted).Italic(true).Render("writing the round report…")
	case e.artifact == "plan" && e.streaming:
		body = fg(th.Muted).Italic(true).Render(spin + " working on the plan…")
	case e.artifact == "plan":
		body = fg(th.OK).Render("✎ updated the plan") + fg(th.Muted).Render(fmt.Sprintf("  (%s)", humanSize(len(e.text))))
	case e.streaming && e.text == "":
		body = fg(th.Muted).Italic(true).Render(spin + " thinking…")
	default:
		body = wrapPlain(strings.TrimSpace(e.text), width-2, th)
		if e.streaming {
			body += fg(col).Render("▍")
		}
	}
	if len(e.tools) > 0 {
		t := fg(th.Subtle).Render("↳ " + strings.Join(e.tools, ", "))
		body = t + "\n" + body
	}
	return head + "\n" + prefixLines(body, bar)
}

func humanSize(n int) string {
	if n < 1000 {
		return fmt.Sprintf("%d chars", n)
	}
	return fmt.Sprintf("%.1fk chars", float64(n)/1000)
}

// renderTranscript renders every visible entry with a blank line between blocks.
func renderTranscript(s *session, th theme.Theme, width int, spin string) string {
	var blocks []string
	for _, e := range s.entries {
		if b := renderEntry(s, e, th, width, spin); b != "" {
			blocks = append(blocks, b)
		}
	}
	return strings.Join(blocks, "\n\n")
}

// ---- header / roster / footer ----

func renderHeader(s *session, th theme.Theme, width int, spin string) string {
	left := fg(th.Accent2).Render("✦ ") + theme.Gradient("Quorum", th.Accent2, th.Accent) +
		fg(th.Muted).Render("  "+s.preset.Name+" · "+s.preset.Protocol)

	var chips []string
	if s.total > 0 && s.round > 0 {
		dots := ""
		for i := 1; i <= s.total; i++ {
			switch {
			case i < s.round || (i == s.round && s.phase != phaseRunning):
				dots += fg(th.Accent).Render("●")
			case i == s.round:
				dots += fg(th.Accent2).Render("●")
			default:
				dots += fg(th.Subtle).Render("○")
			}
		}
		chips = append(chips, fg(th.Muted).Render("round ")+dots)
	}
	if s.pause != "" && s.pause != "round" {
		chips = append(chips, fg(th.Muted).Render("pause: "+s.pause))
	}
	if s.quota != nil {
		q := *s.quota
		c := th.Muted
		if q >= 0.9 {
			c = th.Err
		} else if q >= 0.7 {
			c = th.Warn
		}
		chips = append(chips, fg(c).Render(fmt.Sprintf("quota %d%%", int(q*100+0.5))))
	}
	if s.converged {
		chips = append(chips, fg(th.OK).Render("✓ converged"))
	}
	switch s.phase {
	case phaseStarting:
		chips = append(chips, fg(th.Muted).Render(spin+" starting"))
	case phaseRunning:
		chips = append(chips, fg(th.Accent2).Render(spin+" deliberating"))
	case phasePaused:
		if s.busy() {
			chips = append(chips, fg(th.Accent2).Render(spin+" replying"))
		} else {
			chips = append(chips, fg(th.Warn).Bold(true).Render("● your turn"))
		}
	case phaseDone:
		chips = append(chips, fg(th.OK).Render("✓ complete"))
	}
	right := strings.Join(chips, fg(th.Subtle).Render("  ·  "))
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		return ansi.Truncate(left, width, "…")
	}
	return left + strings.Repeat(" ", gap) + right
}

func statusGlyph(m member, th theme.Theme, spin string) string {
	switch m.status {
	case statusThinking:
		return fg(th.Accent2).Render(spin)
	case statusDone:
		return fg(th.OK).Render("✓")
	case statusFailed:
		return fg(th.Err).Render("✗")
	}
	return fg(th.Subtle).Render("○")
}

func sectionTitle(label string, width int, th theme.Theme, focused bool) string {
	c := th.Muted
	if focused {
		c = th.Accent2
	}
	l := fg(c).Bold(true).Render(strings.ToUpper(label))
	rule := width - lipgloss.Width(l) - 1
	if rule < 0 {
		rule = 0
	}
	return l + " " + fg(th.Subtle).Render(strings.Repeat("─", rule))
}

func renderRoster(s *session, th theme.Theme, width int, spin string) string {
	rows := []string{sectionTitle("Council", width, th, false)}
	all := append(append([]member{}, s.members...), s.chair)
	for _, m := range all {
		col := th.Chair
		if m.color >= 0 {
			col = th.Speaker(m.color)
		}
		right := m.cli
		if m.status == statusThinking && m.tool != "" {
			right = "↳ " + m.tool
		}
		left := statusGlyph(m, th, spin) + " " + fg(col).Bold(true).Render(m.id)
		role := fg(th.Muted).Render(m.role)
		if m.id == "chair" {
			role = fg(th.Muted).Render("you talk to")
		}
		line := left + "  " + role
		r := fg(th.Subtle).Render(right)
		gap := width - lipgloss.Width(line) - lipgloss.Width(r)
		if gap < 1 {
			rows = append(rows, ansi.Truncate(line, width, "…"))
			continue
		}
		rows = append(rows, line+strings.Repeat(" ", gap)+r)
	}
	return strings.Join(rows, "\n")
}

// bullets returns up to maxItems list items from markdown-ish text, each wrapped to width.
func bullets(text string, width, maxItems, maxLines int, th theme.Theme) []string {
	var items []string
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		l = strings.TrimLeft(l, "-*• ")
		if l != "" {
			items = append(items, l)
		}
	}
	var out []string
	for i, it := range items {
		if i == maxItems {
			out = append(out, fg(th.Subtle).Render(fmt.Sprintf("  +%d more", len(items)-maxItems)))
			break
		}
		lines := strings.Split(ansi.Wrap(it, width-2, ""), "\n")
		if len(lines) > maxLines {
			lines = append(lines[:maxLines-1], ansi.Truncate(lines[maxLines-1], width-3, "…"))
		}
		for j, l := range lines {
			p := "  "
			if j == 0 {
				p = fg(th.Accent2).Render("• ")
			}
			out = append(out, p+fg(th.Text).Render(l))
		}
	}
	return out
}

func renderNotes(s *session, th theme.Theme, width, maxHeight int) string {
	var rows []string
	add := func(title, text string) {
		if strings.TrimSpace(text) == "" {
			return
		}
		items := bullets(text, width, 3, 2, th)
		if len(items) == 0 {
			return
		}
		rows = append(rows, "", sectionTitle(title, width, th, false))
		rows = append(rows, items...)
	}
	add("Open questions", s.questions)
	add("Dissent", s.dissent)
	if len(rows) > maxHeight {
		rows = rows[:maxHeight]
	}
	return strings.Join(rows, "\n")
}

// footerHint lists the keys that matter right now, dropping the least important to fit the width.
func footerHint(s *session, th theme.Theme, width int) string {
	k := func(key, what string) string { return fg(th.Text).Render(key) + " " + fg(th.Muted).Render(what) }
	sep := fg(th.Subtle).Render(" · ")
	var parts []string
	switch {
	case s.phase == phaseDone:
		parts = []string{k("n", "new session"), k("q", "quit"), k("tab", "focus"), k("ctrl+p", "plan")}
	case s.canType():
		parts = []string{k("enter", "continue / send"), k("@name", "ask one"), k("/steer", "direct"), k("/stop", "finish"), k("ctrl+p", "plan"), k("ctrl+c", "quit")}
	default:
		parts = []string{k("ctrl+x", "stop"), k("tab", "focus"), k("ctrl+p", "plan"), k("ctrl+c", "quit")}
	}
	for len(parts) > 1 && lipgloss.Width(strings.Join(parts, sep)) > width {
		parts = parts[:len(parts)-1]
	}
	return ansi.Truncate(strings.Join(parts, sep), width, "")
}
