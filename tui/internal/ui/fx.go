package ui

import (
	"os"
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

// fxTicks is the whole reveal: resolving, then a one-off shimmer across the finished text.
func fxTicks(n int) int { return solveTicks(n) + shimmerTicks }

const shimmerTicks = 12

// Reveal styles for text arriving on screen.
const (
	fxDecode = "decode" // scrambled glyphs resolve left to right
	fxWipe   = "wipe"   // a bright block sweeps across, leaving text behind it
	fxType   = "type"   // typewriter with a cursor
	fxGlitch = "glitch" // everything starts as noise and snaps into place at random
)

// fxMode picks a reveal style for the i-th line of a card. QUORUM_FX forces one style everywhere;
// the default mixes them so each kind of text arrives differently.
func fxMode(slot int) string {
	switch m := fxForced; m {
	case fxDecode, fxWipe, fxType, fxGlitch:
		return m
	}
	return [...]string{fxDecode, fxGlitch, fxWipe, fxType}[slot%4]
}

var fxForced = os.Getenv("QUORUM_FX")

type solveOpts struct {
	mode     string
	offset   int // index of this text's first rune within the whole card
	resolved int // runes (across the card) that are final
	total    int // runes in the whole card
	frame    int
	final    lipgloss.Style
	flicker  lipgloss.Style
	alt      lipgloss.Style // second noise colour for glitch
}

// solve renders text part-way through arriving. It keeps one cell per rune, so wrapping and layout
// never shift while it plays.
func solve(text string, o solveOpts) string {
	var b strings.Builder
	var done []rune
	flush := func() {
		if len(done) > 0 {
			b.WriteString(o.final.Render(string(done)))
			done = done[:0]
		}
	}
	noise := func(idx int, st lipgloss.Style) {
		flush()
		b.WriteString(st.Render(string(scrambleGlyphs[hash32(idx, o.frame)%uint32(len(scrambleGlyphs))])))
	}
	total := max(o.total, 1)
	for i, r := range []rune(text) {
		idx := o.offset + i
		if r == ' ' {
			done = append(done, r)
			continue
		}
		switch o.mode {
		case fxWipe:
			switch {
			case idx < o.resolved:
				done = append(done, r)
			case idx < o.resolved+2:
				flush()
				b.WriteString(o.flicker.Render("█"))
			default:
				done = append(done, ' ')
			}
		case fxType:
			switch {
			case idx < o.resolved:
				done = append(done, r)
			case idx == o.resolved:
				flush()
				b.WriteString(o.flicker.Render("▍"))
			default:
				done = append(done, ' ')
			}
		case fxGlitch:
			// Each rune has its own moment to snap into place, spread across the whole reveal.
			at := int(hash32(idx, 99) % uint32(total+solveWindow))
			switch {
			case at < o.resolved:
				done = append(done, r)
			case hash32(idx, o.frame)%5 == 0:
				noise(idx, o.alt)
			default:
				noise(idx, o.flicker)
			}
		default: // decode
			switch {
			case idx < o.resolved:
				done = append(done, r)
			case idx < o.resolved+solveWindow:
				noise(idx, o.flicker)
			default:
				done = append(done, ' ')
			}
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

// shimmer sweeps a bright band across finished text once; pos is the band's centre in runes.
func shimmer(text string, pos int, base, hi lipgloss.Style) string {
	var b strings.Builder
	for i, r := range []rune(text) {
		if d := i - pos; d >= -2 && d <= 2 {
			b.WriteString(hi.Render(string(r)))
		} else {
			b.WriteString(base.Render(string(r)))
		}
	}
	return b.String()
}
