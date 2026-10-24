package ui

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/jbud/quorum/tui/internal/theme"
)

// meter draws a confidence bar like ▰▰▰▰▱ using cells wide; pct < 0 draws nothing.
func meter(pct, cells int, on, off lipgloss.Style) string {
	if pct < 0 {
		return ""
	}
	filled := (pct*cells + 50) / 100
	return on.Render(strings.Repeat("▰", filled)) + off.Render(strings.Repeat("▱", cells-filled))
}

var waveGlyphs = []rune("░▒▓█▓▒░ ")

// wave is the "receiving…" animation: a travelling pulse that moves one cell per frame.
func wave(width, frame int, th theme.Theme) string {
	if width < 4 {
		return ""
	}
	cells := make([]string, width)
	for i := range cells {
		g := waveGlyphs[((i-frame)%len(waveGlyphs)+len(waveGlyphs))%len(waveGlyphs)]
		cells[i] = string(g)
	}
	return theme.GradientShift(strings.Join(cells, ""), frame, th.Accent, th.Accent2, th.Speaker(2))
}

// stanceChip is the colored verdict tag, e.g. "✗ DISAGREE".
func stanceChip(stance string, th theme.Theme) string {
	glyph, label := "◇", "NEUTRAL"
	switch stance {
	case "agree":
		glyph, label = "✓", "AGREE"
	case "disagree":
		glyph, label = "✗", "DISAGREE"
	case "mixed":
		glyph, label = "◐", "MIXED"
	}
	return fg(th.Stance(stance)).Bold(true).Render(glyph + " " + label)
}

// glitchRule is a heading rule whose gradient slides with the frame.
func glitchRule(label string, width, frame int, th theme.Theme) string {
	l := " " + label + " "
	side := (width - lipgloss.Width(l) - 2) / 2
	if side < 2 {
		side = 2
	}
	left := theme.GradientShift(strings.Repeat("━", side), frame, th.Subtle, th.Accent, th.Accent2)
	right := theme.GradientShift(strings.Repeat("━", side), -frame, th.Accent2, th.Accent, th.Subtle)
	return left + fg(th.Accent2).Bold(true).Render("◤") + fg(th.Text).Bold(true).Render(l) + fg(th.Accent2).Bold(true).Render("◢") + right
}

// logoArt is the start-screen banner (three rows of half blocks).
var logoArt = []string{
	"╔═╗ ╦ ╦ ╔═╗ ╦═╗ ╦ ╦ ╔╦╗",
	"║ ║ ║ ║ ║ ║ ╠╦╝ ║ ║ ║║║",
	"╚═╩ ╚═╝ ╚═╝ ╩╚═ ╚═╝ ╩ ╩",
}

func renderLogo(th theme.Theme, frame int) string {
	rows := make([]string, len(logoArt))
	for i, r := range logoArt {
		rows[i] = theme.GradientShift(r, frame+i*2, th.Accent2, th.Accent, th.Info, th.Speaker(2))
	}
	return strings.Join(rows, "\n")
}

var scrambleGlyphs = []rune("░▒▓█▚▞#@$%&*+=<>/\\|01")

func hash32(a, b int) uint32 {
	h := uint32(a)*2654435761 ^ uint32(b)*40503 + 0x9e3779b9
	h ^= h >> 15
	h *= 2246822519
	h ^= h >> 13
	return h
}

const solveWindow = 7 // how many cells ahead of the resolved edge show scrambled glyphs

// solveTicks is how long text of n characters takes to resolve.
func solveTicks(n int) int { return min(max(n/5, 8), 22) }

// solve renders text as if it is being decoded: the first `resolved` characters (counted across a
// whole card from `offset`) are final, a short window after them flickers through glyphs, and the
// rest is not there yet. It keeps one cell per rune, so wrapping is unchanged.
func solve(text string, offset, resolved, frame int, final, flicker lipgloss.Style) string {
	var b strings.Builder
	var done []rune
	flush := func() {
		if len(done) > 0 {
			b.WriteString(final.Render(string(done)))
			done = done[:0]
		}
	}
	for i, r := range []rune(text) {
		idx := offset + i
		switch {
		case r == ' ' || idx < resolved:
			done = append(done, r)
		case idx < resolved+solveWindow:
			flush()
			g := scrambleGlyphs[hash32(idx, frame)%uint32(len(scrambleGlyphs))]
			b.WriteString(flicker.Render(string(g)))
		default:
			done = append(done, ' ')
		}
	}
	flush()
	return b.String()
}

// resolvedAt maps playback progress to how many characters of an n-character card are final.
func resolvedAt(n, ticks, since int) int {
	if ticks <= 0 || since >= ticks {
		return n + solveWindow
	}
	return since * (n + solveWindow) / ticks
}
