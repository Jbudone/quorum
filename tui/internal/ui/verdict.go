package ui

import (
	"fmt"
	"image/color"
	"strings"

	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

const (
	verdictFrames = 22 // ticks each option spends being tried
	boxFrames     = 16 // ticks for the winner's box to draw itself
	verdictRows   = 9
	verdictMinCol = 18
)

func ratingColor(r string, th theme.Theme) color.Color {
	switch r {
	case "good":
		return th.OK
	case "bad":
		return th.Err
	}
	return th.Warn
}

func verdictFits(d *rpc.Diagram, width int) bool {
	return len(d.Options) >= 2 && width >= len(d.Options)*verdictMinCol
}

// renderVerdict plays each option being tried in turn: a little figure bites, reacts (red and
// spitting, or green and sparkling), and at the end a box draws itself around the agreed winner.
func renderVerdict(d *rpc.Diagram, width int, th theme.Theme, t int, anim bool, item string) string {
	head := fg(th.OK).Bold(true).Render("◆ VERDICT") + fg(th.Text).Bold(true).Render("  "+d.Title)
	n := len(d.Options)
	if !verdictFits(d, width) {
		var rows []string
		for i, o := range d.Options {
			mark, c := "✗", ratingColor(o.Rating, th)
			if o.Rating == "good" {
				mark = "✓"
			} else if o.Rating == "mixed" {
				mark = "◐"
			}
			if d.Winner != nil && *d.Winner == i {
				mark = "★" // the agreed best
			}
			rows = append(rows, ansi.Truncate(fg(c).Render(fmt.Sprintf("%s %s — %s", mark, o.Name, o.Note)), width, "…"))
		}
		return ansi.Truncate(head, width, "…") + "\n" + strings.Join(rows, "\n")
	}

	colW := width / n
	cv := newCanvas(width, verdictRows)
	for k, o := range d.Options {
		e := t - k*verdictFrames
		if !anim {
			e = verdictFrames + 100
		}
		if e < 0 {
			continue
		}
		x0 := k * colW
		cx := x0 + colW/2
		col := ratingColor(o.Rating, th)
		reacted := e >= 12

		// Walk in from the left, then settle at the column's centre.
		fx := cx
		if e < 6 {
			fx = cx - 6 + e
		}
		face, faceC := "(·_·)", th.Text
		itemX, itemY, itemC := fx+3, 2, color.Color(th.Warn)
		switch {
		case e >= 6 && !reacted: // chewing
			itemX, itemY = fx+3, 1
			if (e/2)%2 == 0 {
				face = "(·o·)"
			}
		case reacted:
			j := e - 12
			switch o.Rating {
			case "bad":
				face, faceC = "(>_<)", th.Err
				if j < 8 && (j/2)%2 == 1 {
					face = "(>~<)"
				}
				itemX, itemY, itemC = fx+4, 3, th.Err // dropped on the floor
				if j < 8 {                            // spat out
					for p := 0; p < 3; p++ {
						px := fx + 3 + j + p*2
						if px < x0+colW-1 {
							cv.put(max(1-j/4, 0), px, []string{"∙", "°", "·"}[p], th.Err, false)
						}
					}
				}
			case "good":
				face, faceC = "(^‿^)", th.OK
				if (j/3)%2 == 1 {
					face = "(^▽^)"
				}
				itemY = 1
				spark := []string{"✦", "✧"}
				cv.put(0, fx-3, spark[(j/2)%2], th.OK, true)
				cv.put(0, fx+4, spark[(j/2+1)%2], th.OK, true)
				cv.put(max(0, 1-j/3), fx, "♥", th.Err, true)
			default:
				face, faceC = "(-_-)", th.Warn
			}
		}
		cv.put(1, fx-2, face, faceC, reacted)
		cv.put(2, fx-1, "/|\\", th.Muted, false)
		cv.put(3, fx-1, "/ \\", th.Muted, false)
		if itemX+len([]rune(item)) < x0+colW {
			cv.put(itemY, itemX, item, itemC, true)
		}

		nameC := th.Text
		if reacted {
			nameC = col
		}
		name := string([]rune(o.Name))
		cv.put(5, cx-len([]rune(name))/2, name, nameC, reacted)
		if reacted {
			note := o.Note
			if nr := []rune(note); len(nr) > colW-3 {
				note = string(nr[:colW-4]) + "…"
			}
			cv.put(6, cx-len([]rune(note))/2, note, th.Muted, false)
			tag := map[string]string{"bad": "✗ BAD", "mixed": "◐ MIXED", "good": "✓ GOOD"}[o.Rating]
			cv.put(7, cx-len([]rune(tag))/2, tag, col, true)
		}
	}

	if d.Winner != nil && *d.Winner >= 0 && *d.Winner < n {
		w := *d.Winner
		x0, x1 := w*colW, (w+1)*colW-1
		per := 2*((x1-x0+1)+verdictRows) - 4
		drawn := per
		if anim {
			p := float64(t-n*verdictFrames) / float64(boxFrames)
			drawn = int(max(0, min(p, 1)) * float64(per))
		}
		drawBox(cv, x0, x1, 0, verdictRows-1, drawn, th.OK)
		if drawn >= per {
			label := " ★ BEST "
			cv.put(0, (x0+x1)/2-len([]rune(label))/2, label, th.OK, true)
		}
	}
	return head + "\n" + cv.render()
}

// drawBox draws the first `cells` cells of a rectangle's border, clockwise from the top-left, so
// a green line appears to spiral around its subject.
func drawBox(cv canvas, x0, x1, y0, y1, cells int, c color.Color) {
	var path [][2]int // y, x
	for x := x0; x <= x1; x++ {
		path = append(path, [2]int{y0, x})
	}
	for y := y0 + 1; y <= y1; y++ {
		path = append(path, [2]int{y, x1})
	}
	for x := x1 - 1; x >= x0; x-- {
		path = append(path, [2]int{y1, x})
	}
	for y := y1 - 1; y > y0; y-- {
		path = append(path, [2]int{y, x0})
	}
	for i := 0; i < cells && i < len(path); i++ {
		y, x := path[i][0], path[i][1]
		r := "─"
		switch {
		case y == y0 && x == x0:
			r = "╭"
		case y == y0 && x == x1:
			r = "╮"
		case y == y1 && x == x1:
			r = "╯"
		case y == y1 && x == x0:
			r = "╰"
		case x == x0 || x == x1:
			r = "│"
		}
		cv.put(y, x, r, c, true)
	}
}
