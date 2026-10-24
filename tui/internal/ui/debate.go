package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

const (
	debateStep  = 7  // ticks between one member joining and the next
	debateIntro = 8  // ticks for the centre box and the bus line to draw
	debateTail  = 14 // ticks for the last member's reaction to play out
	debateMin   = 16 // narrowest column that still fits a speech bubble
)

type debateMember struct {
	id       string
	color    int
	stance   string
	conf     int // -1 when unknown
	headline string
}

// debateData is a round's discussion at a glance, built from the digests the members already gave.
type debateData struct {
	round   int
	members []debateMember
	agree   int // members who agree with the current direction
	pct     int // the same as a percentage
}

func debateTicks(d *debateData) int { return debateIntro + len(d.members)*debateStep + debateTail }

// buildDebate collects each member's digest from a round; nil when fewer than two spoke.
func (s *session) buildDebate(round int) *debateData {
	d := &debateData{round: round}
	agree := 0
	for i, m := range s.members {
		for j := len(s.entries) - 1; j >= 0; j-- {
			e := s.entries[j]
			if e.kind == kindAgent && e.speaker == m.id && e.round == round && e.tldr != nil {
				dm := debateMember{id: m.id, color: i, stance: e.tldr.Stance, conf: -1, headline: e.tldr.Headline}
				if e.tldr.Confidence != nil {
					dm.conf = *e.tldr.Confidence
				}
				if dm.stance == "agree" {
					agree++
				}
				d.members = append(d.members, dm)
				break
			}
		}
	}
	if len(d.members) < 2 {
		return nil
	}
	d.agree, d.pct = agree, agree*100/len(d.members)
	return d
}

func wrapRunes(text string, w, lines int) []string {
	wrapped := strings.Split(ansi.Wrap(text, w, ""), "\n")
	if len(wrapped) > lines {
		wrapped = append(wrapped[:lines-1], ansi.Truncate(strings.Join(wrapped[lines-1:], " "), w, "…"))
	}
	return wrapped
}

// renderDebate draws the round as a small council table: a centre box showing how much agreement
// there is, a line to each member, and their stance and headline. Members join one at a time;
// disagreement crackles along its line.
func renderDebate(d *debateData, width int, th theme.Theme, t int, anim bool, frame int) string {
	n := len(d.members)
	head := fg(th.Info).Bold(true).Render("◆ ROUND "+fmt.Sprint(d.round)+" DEBATE") +
		fg(th.Muted).Render(fmt.Sprintf("  %d of %d agree", d.agree, n))
	if width < n*debateMin {
		rows := []string{ansi.Truncate(head, width, "…")}
		for _, m := range d.members {
			rows = append(rows, ansi.Truncate(stanceChip(m.stance, th)+" "+fg(th.Speaker(m.color)).Bold(true).Render(m.id)+fg(th.Muted).Render(" — "+m.headline), width, "…"))
		}
		return strings.Join(rows, "\n")
	}

	colW := width / n
	const bubbleLines = 3
	h := 5 + 3 + bubbleLines
	cv := newCanvas(width, h)
	if !anim {
		t = 1 << 20
	}
	cx := make([]int, n)
	for i := range cx {
		cx[i] = i*colW + colW/2
	}

	// Centre box with the agreement gauge.
	boxW := min(width-4, 34)
	bx0 := (width - boxW) / 2
	if t >= 0 {
		pct := d.pct
		if anim {
			pct = min(d.pct, t*d.pct/max(debateIntro+n*debateStep, 1))
		}
		label := fmt.Sprintf("agreement %3d%%", pct)
		drawBox(cv, bx0, bx0+boxW-1, 0, 2, 1<<20, th.Accent)
		gauge := strings.Repeat("▰", pct*10/100) + strings.Repeat("▱", 10-pct*10/100)
		cv.put(1, bx0+(boxW-len([]rune(label))-11)/2, label+" "+gauge, th.Text, true)
		cv.put(2, (width)/2, "┬", th.Accent, true)
	}

	// Bus line across the members, drawn outwards from the centre.
	span := cx[n-1] - cx[0]
	busT := t - 2
	reach := span
	if anim && busT < debateIntro-2 {
		reach = max(0, busT) * span / (debateIntro - 2)
	}
	mid := width / 2
	for x := cx[0]; x <= cx[n-1]; x++ {
		if abs(x-mid)*2 <= reach+1 {
			cv.put(3, x, "─", th.Subtle, false)
		}
	}
	if reach > 0 {
		cv.put(3, mid, "┴", th.Subtle, false)
	}

	for i, m := range d.members {
		e := t - debateIntro - i*debateStep
		if e < 0 {
			continue
		}
		col := th.Speaker(m.color)
		sc := th.Stance(m.stance)
		// The drop line from the bus to the member; disagreement crackles, agreement flows.
		line, lc := "│", th.Subtle
		if m.stance == "disagree" {
			lc = th.Err
		} else if m.stance == "agree" {
			lc = th.OK
		} else if m.stance == "mixed" {
			lc = th.Warn
		}
		cv.put(3, cx[i], "┬", lc, true)
		cv.put(4, cx[i], line, lc, e > 2)
		pulse := e < 12 || m.stance == "disagree" && !anim
		if m.stance == "disagree" && anim && e < debateTail+4 && (e/2)%2 == 0 {
			cv.put(4, cx[i], "⚡", th.Err, true)
		} else if m.stance == "agree" && pulse {
			cv.put(4, cx[i], "•", th.OK, true)
		}
		if e < 2 {
			continue
		}
		chip := ansi.Strip(stanceChip(m.stance, th))
		if m.conf >= 0 {
			chip += fmt.Sprintf(" %d%%", m.conf)
		}
		cv.put(5, cx[i]-len([]rune(chip))/2, chip, sc, true)
		cv.put(6, cx[i]-len([]rune(m.id))/2, m.id, col, true)
		// The headline types itself into a bubble under the name.
		lines := wrapRunes(m.headline, colW-2, bubbleLines)
		revealed := 1 << 20
		if anim {
			revealed = (e - 3) * 3
		}
		count := 0
		for li, l := range lines {
			rs := []rune(l)
			shown := make([]rune, len(rs))
			for k, r := range rs {
				switch {
				case r == ' ' || count < revealed:
					shown[k] = r
				case count == revealed:
					shown[k] = '▍'
				default:
					shown[k] = ' '
				}
				count++
			}
			cv.put(7+li, cx[i]-len(rs)/2, string(shown), th.Text, false)
		}
	}
	return head + "\n" + cv.render()
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
