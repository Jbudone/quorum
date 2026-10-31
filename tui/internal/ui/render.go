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
	if e.kind != kindQuestion && !e.streaming && !e.playing(s) && e.cache != "" && e.cacheW == width {
		return e.cache
	}
	out := drawEntry(s, e, th, width, spin)
	if e.kind != kindQuestion && !e.streaming && !e.playing(s) {
		e.cache, e.cacheW = out, width
	}
	return out
}

func drawEntry(s *session, e *entry, th theme.Theme, width int, spin string) string {
	switch e.kind {
	case kindRound:
		return glitchRule(fmt.Sprintf("ROUND %d/%d", e.round, e.total), width, s.frame, th)

	case kindArt:
		return renderSprite(s.sprite, s.topic, width, th, s.frame-e.diagramAt, !s.calm)

	case kindMap:
		return renderDebate(e.debate, width, th, s.frame-e.diagramAt, !s.calm, s.frame)

	case kindQuestion:
		bar := fg(th.Warn).Render("▌")
		active := s.qa.active && s.qa.entry == e
		title := "open question — your call"
		if !active {
			title = "open question"
		}
		rows := []string{bar + " " + fg(th.Warn).Bold(true).Render("? "+e.speaker) + fg(th.Muted).Render("  "+title), prefixLines(wrapPlain(e.text, width-2, th), bar)}
		if active {
			if it := s.currentItem(); it != nil {
				for i, o := range it.options {
					mark, c := "○", th.Text
					if it.multi {
						mark = "☐"
					}
					if s.qa.picked[i] {
						mark, c = "◉", th.OK
						if it.multi {
							mark = "☑"
						}
					}
					ptr := "  "
					if s.qa.touched && i == s.qa.cursor {
						ptr, c = fg(th.Accent2).Bold(true).Render("❯ "), th.Accent2
					}
					rows = append(rows, bar+"   "+ptr+fg(c).Render(fmt.Sprintf("%s %d  %s", mark, i+1, o)))
				}
				hint := "type your own answer below · Enter alone skips"
				if len(it.options) > 0 {
					verb := "space picks one"
					if it.multi {
						verb = "space ticks, pick several"
					}
					hint = "↑↓ move · " + verb + " · 1-9 jump · or type your own below · Enter sends"
				}
				rows = append(rows, bar+"   "+fg(th.Subtle).Render(ansi.Truncate(hint, width-6, "…")))
			}
		} else if e.answer != "" {
			rows = append(rows, bar+"   "+fg(th.OK).Render("→ ")+fg(th.Text).Render(ansi.Truncate(e.answer, width-8, "…")))
		} else {
			rows = append(rows, bar+"   "+fg(th.Subtle).Render("skipped"))
		}
		return strings.Join(rows, "\n")

	case kindSystem:
		return fg(th.Muted).Italic(true).Render(wrapPlain("» "+e.text, width, th))

	case kindError:
		return fg(th.Err).Render(ansi.Wrap("✗ "+e.text, width, ""))

	case kindSummary:
		box := lipgloss.NewStyle().Border(lipgloss.ThickBorder()).BorderForegroundBlend(th.Accent, th.Accent2, th.Chair).Padding(0, 1).Width(width)
		title := theme.GradientShift(fmt.Sprintf("◆ CHAIR // round %d briefing", e.round), s.frame, th.Accent2, th.Chair, th.Accent)
		body := wrapPlain(e.text, width-4, th)
		if e.reveal && !s.calm {
			if n := len([]rune(e.text)); s.frame-e.revealAt < solveTicks(n) {
				since := s.frame - e.revealAt
				body = ansi.Wrap(solve(e.text, solveOpts{mode: fxMode(3), resolved: resolvedAt(n, solveTicks(n), since), total: n, frame: s.frame,
					final: fg(th.Text), flicker: fg(th.Accent2), alt: fg(th.Info)}), width-4, "")
			}
		}
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

	if e.artifact == "chair-report" && !e.streaming {
		return "" // the Chair's summary callout replaces the raw report
	}
	if e.streaming {
		return head + "\n" + prefixLines(streamingBody(s, e, th, width-2, col, spin), bar)
	}

	var rows []string
	if len(e.tools) > 0 {
		rows = append(rows, fg(th.Subtle).Render("↳ "+strings.Join(e.tools, ", ")))
	}
	t := e.tldr
	if t != nil {
		// Verdict line: stance on the left, confidence meter on the right.
		left := stanceChip(t.Stance, th)
		right := ""
		if t.Confidence != nil {
			c := fg(th.Stance(t.Stance))
			right = meter(*t.Confidence, 8, c, fg(th.Subtle)) + fg(th.Muted).Render(fmt.Sprintf(" %d%%", *t.Confidence))
		}
		gap := width - 3 - lipgloss.Width(left) - lipgloss.Width(right)
		if gap < 1 {
			right, gap = "", 1
		}
		rows = append(rows, left+strings.Repeat(" ", gap)+right)
		// A fresh reply arrives with an effect (see fxMode), then a one-off shimmer sweeps its headline.
		total := e.revealChars()
		since := s.frame - e.revealAt
		live := e.reveal && !s.calm && since < fxTicks(total)
		resolved := 1 << 30
		if live {
			resolved = resolvedAt(total, solveTicks(total), since)
		}
		opts := func(slot, off int, bold bool) solveOpts {
			f := fg(th.Text)
			if bold {
				f = f.Bold(true)
			}
			return solveOpts{mode: fxMode(slot), offset: off, resolved: resolved, total: total, frame: s.frame, final: f, flicker: fg(th.Accent2), alt: fg(th.Info)}
		}
		off := 0
		if t.Headline != "" {
			line := fg(th.Text).Bold(true).Render(t.Headline)
			switch {
			case live && since < solveTicks(total):
				line = solve(t.Headline, opts(0, off, true))
			case live: // decoding is done: sweep a highlight across
				pos := (since - solveTicks(total)) * (len([]rune(t.Headline)) + 4) / shimmerTicks
				line = shimmer(t.Headline, pos-2, fg(th.Text).Bold(true), fg(th.Accent2).Bold(true))
			}
			rows = append(rows, ansi.Wrap(fg(th.Text).Bold(true).Render("▸ ")+line, width-2, ""))
			off += len([]rune(t.Headline))
		}
		for i, b := range t.Bullets {
			line := fg(th.Text).Render(b)
			if live && since < solveTicks(total) {
				line = solve(b, opts(i+1, off, false))
			}
			rows = append(rows, ansi.Wrap(fg(col).Render("  ◆ ")+line, width-2, ""))
			off += len([]rune(b))
		}
	}
	switch {
	case e.artifact == "plan":
		rows = append(rows, fg(th.OK).Render("✎ plan updated")+fg(th.Muted).Render(fmt.Sprintf("  (%s) · alt+p to read", humanSize(len(e.text)))))
	case s.full || t == nil || e.speaker == "chair":
		rows = append(rows, "", wrapPlain(strings.TrimSpace(e.text), width-2, th))
	default:
		rows = append(rows, fg(th.Subtle).Render(fmt.Sprintf("⋯ %d words hidden · ctrl+o shows full replies", len(strings.Fields(e.text)))))
	}
	return head + "\n" + prefixLines(strings.Join(rows, "\n"), bar)
}

// streamingBody shows a live pulse and the tail of what has arrived, without the TL;DR block.
func streamingBody(s *session, e *entry, th theme.Theme, width int, col color.Color, spin string) string {
	text := e.text
	if i := strings.Index(strings.ToLower(text), "<tldr"); i >= 0 {
		text = text[:i]
	}
	label := "receiving"
	switch {
	case e.artifact == "plan":
		label = "drafting the plan"
	case e.artifact == "chair-report":
		label = "writing the round report"
	case strings.TrimSpace(text) == "":
		label = "thinking"
	}
	line := fg(th.Muted).Italic(true).Render(spin+" "+label+" ") + wave(max(min(width-lipgloss.Width(label)-6, 24), 4), s.frame, th)
	if e.artifact != "" || strings.TrimSpace(text) == "" {
		return line
	}
	tail := strings.Split(strings.TrimSpace(ansi.Wrap(plainInline(text), width-2, "")), "\n")
	return line + "\n" + fg(th.Subtle).Render("… "+ansi.Truncate(tail[len(tail)-1], width-4, "…")) + fg(col).Render("▍")
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
	left := fg(th.Accent2).Render("▓▒░ ") + theme.GradientShift("QUORUM", s.frame/2, th.Accent2, th.Accent, th.Info, th.Speaker(2)) +
		fg(th.Accent2).Render(" ░▒▓ ") + fg(th.Muted).Render("// "+s.preset.Name+" // "+s.preset.Protocol)

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
		chips = append(chips, fg(th.Muted).Render("RND ")+dots)
	}
	if s.pause != "" && s.pause != "round" {
		chips = append(chips, fg(th.Muted).Render("PAUSE:"+strings.ToUpper(s.pause)))
	}
	if s.quota != nil {
		q := *s.quota
		c := th.Muted
		if q >= 0.9 {
			c = th.Err
		} else if q >= 0.7 {
			c = th.Warn
		}
		chips = append(chips, fg(c).Render(fmt.Sprintf("QUOTA %d%%", int(q*100+0.5))))
	}
	if s.converged {
		chip := fg(th.OK).Bold(true).Render("✓ CONVERGED")
		if !s.calm && s.convergedAt > 0 && s.frame-s.convergedAt < convergeTicks {
			sp := []string{"✦", "✧", "·", "✧"}
			chip = fg(th.Warn).Render(sp[(s.frame/2)%4]) + " " + theme.GradientShift("✓ CONVERGED", s.frame, th.OK, th.Warn, th.Info) + " " + fg(th.Warn).Render(sp[(s.frame/2+2)%4])
		}
		chips = append(chips, chip)
	}
	switch s.phase {
	case phaseStarting:
		chips = append(chips, fg(th.Muted).Render(spin+" BOOTING"))
	case phaseRunning:
		chips = append(chips, fg(th.Accent2).Render(spin+" DELIBERATING"))
	case phasePaused:
		if s.busy() {
			chips = append(chips, fg(th.Accent2).Render(spin+" REPLYING"))
		} else {
			chips = append(chips, fg(th.Warn).Bold(true).Render("● YOUR TURN"))
		}
	case phaseDone:
		chips = append(chips, fg(th.OK).Bold(true).Render("✓ COMPLETE"))
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
	return strings.Join(rows, "\n") + renderBoard(s, th, width)
}

// renderBoard is the consensus board: each member's latest stance and confidence at a glance.
func renderBoard(s *session, th theme.Theme, width int) string {
	var rows []string
	agree, voted := 0, 0
	for _, m := range s.members {
		if m.stance == "" {
			continue
		}
		voted++
		if m.stance == "agree" {
			agree++
		}
		c := fg(th.Stance(m.stance))
		bar := meter(max(m.conf, 0), 5, c, fg(th.Subtle))
		if m.conf < 0 {
			bar = fg(th.Subtle).Render("▱▱▱▱▱")
		}
		rows = append(rows, fmt.Sprintf("%s %s %s", fg(s.memberColor(th, m.id)).Render(fmt.Sprintf("%-11s", ansi.Truncate(m.id, 11, "…"))), bar, c.Render(strings.ToLower(m.stance))))
	}
	if voted == 0 {
		return ""
	}
	pct := agree * 100 / voted
	head := sectionTitle("Consensus", width, th, false)
	gauge := meter(pct, 12, fg(th.OK), fg(th.Subtle)) + fg(th.Muted).Render(fmt.Sprintf(" %d%% agree", pct))
	return "\n\n" + head + "\n" + gauge + "\n" + strings.Join(rows, "\n")
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
		parts = []string{k("n", "new session"), k("q", "quit"), k("tab", "focus"), k("alt+p", "plan")}
	case s.canType() && s.qa.active:
		if it := s.currentItem(); it != nil && len(it.options) > 0 {
			parts = []string{k("↑↓", "move"), k("space", "pick"), k("enter", "send"), k("esc", "skip all"), k("ctrl+c", "quit")}
		} else {
			parts = []string{k("enter", "answer"), k("enter ∅", "skip"), k("esc", "skip all"), k("ctrl+c", "quit")}
		}
	case s.canType():
		parts = []string{k("enter", "continue / send"), k("@name", "ask one"), k("/steer", "direct"), k("/stop", "finish"), k("ctrl+o", "full"), k("alt+p", "plan"), k("ctrl+c", "quit")}
	default:
		parts = []string{k("ctrl+x", "stop"), k("ctrl+o", "full"), k("tab", "focus"), k("alt+p", "plan"), k("ctrl+c", "quit")}
	}
	for len(parts) > 1 && lipgloss.Width(strings.Join(parts, sep)) > width {
		parts = parts[:len(parts)-1]
	}
	return ansi.Truncate(strings.Join(parts, sep), width, "")
}
