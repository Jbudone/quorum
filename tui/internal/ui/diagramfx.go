package ui

import (
	"fmt"
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

const (
	stepFrames  = 9 // ticks (~0.9s) per step while the diagram plays
	settleTicks = 8 // extra ticks after the last step for the breach flash
	minGap      = 13
)

// iconGlyphs are single-cell, roguelike-flavoured symbols for the fixed icon set.
var iconGlyphs = map[string]string{
	"user": "@", "agent": "&", "server": "▣", "db": "◈", "lock": "⊡", "key": "ƒ",
	"file": "▤", "bug": "Ж", "skull": "☠", "cloud": "≈", "clock": "◔",
}

// diagramTicks is how long a diagram plays before settling on its final frame.
func diagramTicks(d *rpc.Diagram) int {
	if d.Kind == "verdict" {
		return len(d.Options)*verdictFrames + boxFrames + settleTicks
	}
	return len(d.Steps)*stepFrames + settleTicks
}

type cell struct {
	r rune
	c color.Color
	b bool
}

type canvas [][]cell

func newCanvas(w, h int) canvas {
	cv := make(canvas, h)
	for y := range cv {
		cv[y] = make([]cell, w)
		for x := range cv[y] {
			cv[y][x] = cell{r: ' '}
		}
	}
	return cv
}

func (cv canvas) put(y, x int, s string, c color.Color, bold bool) {
	if y < 0 || y >= len(cv) {
		return
	}
	for _, r := range s {
		if x >= 0 && x < len(cv[y]) {
			cv[y][x] = cell{r, c, bold}
		}
		x++
	}
}

// render joins runs of identically styled cells so the output carries few escape codes.
func (cv canvas) render() string {
	lines := make([]string, len(cv))
	for y, row := range cv {
		var b strings.Builder
		for x := 0; x < len(row); {
			e := x
			for e < len(row) && row[e].c == row[x].c && row[e].b == row[x].b {
				e++
			}
			var run strings.Builder
			for _, c := range row[x:e] {
				run.WriteRune(c.r)
			}
			if row[x].c == nil {
				b.WriteString(run.String())
			} else {
				b.WriteString(lipgloss.NewStyle().Foreground(row[x].c).Bold(row[x].b).Render(run.String()))
			}
			x = e
		}
		lines[y] = strings.TrimRight(b.String(), " ")
	}
	return strings.Join(lines, "\n")
}

// diagramFits reports whether the animated layout has room at this width.
func diagramFits(d *rpc.Diagram, width int) bool { return width >= len(d.Actors)*minGap }

// renderDiagram draws the diagram at tick t of its playback; anim=false draws the finished frame.
func renderDiagram(d *rpc.Diagram, width int, th theme.Theme, t int, anim bool) string {
	return renderDiagramItem(d, width, th, t, anim, "▬")
}

// renderDiagramItem is renderDiagram with the glyph a verdict's taster holds (the topic's own item).
func renderDiagramItem(d *rpc.Diagram, width int, th theme.Theme, t int, anim bool, item string) string {
	if d != nil && d.Kind == "verdict" {
		return renderVerdict(d, width, th, t, anim, item)
	}
	if d == nil || len(d.Actors) < 2 || len(d.Steps) == 0 {
		return ""
	}
	attack := d.Kind == "attack"
	chip, chipC := "SEQUENCE", th.Info
	if attack {
		chip, chipC = "ATTACK CHAIN", th.Err
	}
	head := fg(chipC).Bold(true).Render("◆ "+chip) + fg(th.Text).Bold(true).Render("  "+d.Title)
	if !diagramFits(d, width) {
		return ansi.Truncate(head, width, "…") + "\n" + staticSteps(d, width, th)
	}

	n := len(d.Actors)
	idx := map[string]int{}
	cx := make([]int, n)
	for i, a := range d.Actors {
		idx[a.ID] = i
		cx[i] = (2*i + 1) * width / (2 * n)
	}
	cv := newCanvas(width, 2+2*len(d.Steps))

	for i, a := range d.Actors {
		col := th.Speaker(i)
		if a.Icon == "skull" || (attack && a.Icon == "bug") {
			col = th.Err
		}
		icon := iconGlyphs[a.Icon]
		if icon == "" {
			icon = "▣"
		}
		cv.put(0, cx[i], icon, col, true)
		label := a.Label
		if len([]rune(label)) > minGap-1 {
			label = string([]rune(label)[:minGap-2]) + "…"
		}
		cv.put(1, cx[i]-len([]rune(label))/2, label, col, true)
		for y := 2; y < len(cv); y++ {
			cv.put(y, cx[i], "│", th.Subtle, false)
		}
	}

	for k, st := range d.Steps {
		from, to := idx[st.From], idx[st.To]
		ty, ay := 2+2*k, 3+2*k
		e := t - k*stepFrames // ticks since this step began
		if !anim {
			e = stepFrames + settleTicks
		}
		if e < 0 {
			continue
		}
		prog := 1.0 // 0..1 along the arrow
		if e < stepFrames-2 {
			prog = float64(e+1) / float64(stepFrames-2)
		}
		done := prog >= 1
		col := th.Info
		if attack {
			col = th.Warn
		}
		if st.Danger {
			col = th.Err
		}
		text := st.Text
		if attack {
			text = fmt.Sprintf("%d %s", k+1, text)
		}
		textC := th.Muted
		if done {
			textC = th.Text
			if st.Danger {
				textC = th.Err
			}
		}

		if from == to { // a step an actor does to itself
			cv.put(ay, cx[from]+2, "↻ "+text, textC, done)
			continue
		}
		lo, hi := min(cx[from], cx[to]), max(cx[from], cx[to])
		span := hi - lo - 1
		if tw := len([]rune(text)); tw > span-2 {
			text = string([]rune(text)[:max(span-3, 1)]) + "…"
		}
		cv.put(ty, lo+1+(span-len([]rune(text)))/2, text, textC, done)

		dir := 1
		if cx[to] < cx[from] {
			dir = -1
		}
		reach := int(prog * float64(hi-lo-1)) // cells drawn from the source side
		for i := 1; i <= reach; i++ {
			x := cx[from] + dir*i
			if x == cx[to] {
				break
			}
			cv.put(ay, x, "─", col, false)
		}
		if done {
			head := "▶"
			if dir < 0 {
				head = "◀"
			}
			cv.put(ay, cx[to]-dir, head, col, true)
			if st.Danger {
				// The breach flashes for a moment after the threat lands, then stays marked.
				since := e - (stepFrames - 2)
				if !anim || since >= 6 || (since/2)%2 == 0 {
					mx := lo + 1 + (span-len([]rune(text)))/2 + len([]rune(text)) + 1
					cv.put(ty, mx, "✗", th.Err, true)
				}
			}
		} else {
			packet := "●"
			if st.Danger || attack {
				packet = "◆"
			}
			cv.put(ay, cx[from]+dir*max(reach, 1), packet, col, true)
		}
	}
	return head + "\n" + cv.render()
}

// staticSteps is the narrow-terminal fallback: a numbered list.
func staticSteps(d *rpc.Diagram, width int, th theme.Theme) string {
	name := map[string]string{}
	for _, a := range d.Actors {
		name[a.ID] = a.Label
	}
	var rows []string
	for i, s := range d.Steps {
		c := th.Text
		if s.Danger {
			c = th.Err
		}
		rows = append(rows, ansi.Truncate(fg(c).Render(fmt.Sprintf("%d. %s → %s: %s", i+1, name[s.From], name[s.To], s.Text)), width, "…"))
	}
	return strings.Join(rows, "\n")
}
