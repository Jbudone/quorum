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
