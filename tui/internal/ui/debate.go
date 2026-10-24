package ui

import (
	"fmt"
	"image/color"
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

const (
	branchNodes  = 12 // nodes that fly out of the centre box; their split is the council's split
	branchFlight = 9  // ticks one node spends in the air
	branchStart  = 2  // tick the first node launches
)

// splitNodes divides branchNodes among agree / mixed / disagree in proportion to the members
// (largest remainder, so the total is always exact).
func splitNodes(d *debateData) (agree, mixed, disagree int) {
	var cnt [3]int
	for _, m := range d.members {
		switch m.stance {
		case "agree":
			cnt[0]++
		case "disagree":
			cnt[2]++
		default:
			cnt[1]++
		}
	}
	n := len(d.members)
	var got, rem [3]int
	used := 0
	for i := range cnt {
		got[i] = cnt[i] * branchNodes / n
		rem[i] = cnt[i]*branchNodes - got[i]*n
		used += got[i]
	}
	for ; used < branchNodes; used++ {
		best := 0
		for i := range rem {
			if rem[i] > rem[best] {
				best = i
			}
		}
		got[best]++
		rem[best] = -1
	}
	return got[0], got[1], got[2]
}

// renderDebate draws the round as a small council table. In the centre box a dozen nodes fly out
// to two branches, agree on the left and everything else on the right, so the split is visible at
// a glance; then a line drops to each member, who joins one at a time with their stance and a
// headline typing itself into a bubble. Disagreement crackles along its line.
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
	const busRow = 6
	h := busRow + 4 + bubbleLines
	cv := newCanvas(width, h)
	if !anim {
		t = 1 << 20
	}
	cx := make([]int, n)
	for i := range cx {
		cx[i] = i*colW + colW/2
	}

	// The split box: nodes launch from the middle and land in two buckets.
	boxW := max(min(width-4, 46), 30)
	bx0 := (width - boxW) / 2
	mid := width / 2
	drawBox(cv, bx0, bx0+boxW-1, 0, busRow-1, 1<<20, th.Accent)
	cv.put(busRow-1, mid, "┬", th.Accent, true)
	nAgree, nMixed, nDis := splitNodes(d)
	type node struct {
		left bool
		slot int
		c    color.Color
	}
	var lefts, rights []node
	for i := 0; i < nAgree; i++ {
		lefts = append(lefts, node{true, i, th.OK})
	}
	for i := 0; i < nDis+nMixed; i++ {
		c := th.Err
		if i >= nDis {
			c = th.Warn
		}
		rights = append(rights, node{false, i, c})
	}
	var order []node // alternate sides so both branches fill together
	for i := 0; i < len(lefts) || i < len(rights); i++ {
		if i < len(lefts) {
			order = append(order, lefts[i])
		}
		if i < len(rights) {
			order = append(order, rights[i])
		}
	}
	landedL, landedR := 0, 0
	for i, nd := range order {
		tx := bx0 + 2 + nd.slot
		if !nd.left {
			tx = bx0 + boxW - 3 - nd.slot
		}
		e := t - branchStart - i
		if e < 0 {
			continue
		}
		if e >= branchFlight {
			cv.put(3, tx, "●", nd.c, true)
			if nd.left {
				landedL++
			} else {
				landedR++
			}
			continue
		}
		p := float64(e+1) / float64(branchFlight)
		ease := 1 - (1-p)*(1-p) // fast out, slow in
		x := mid + int(float64(tx-mid)*ease)
		y := 1 + int(2*ease+0.5)
		cv.put(y, x, "●", nd.c, true)
		if e > 0 { // a short trail behind the node
			px := mid + int(float64(tx-mid)*(1-(1-float64(e)/branchFlight)*(1-float64(e)/branchFlight)))
			cv.put(1+int(2*(1-(1-float64(e)/branchFlight)*(1-float64(e)/branchFlight))+0.5), px, "·", th.Subtle, false)
		}
	}
	cv.put(1, mid, "◉", th.Accent2, true)
	cv.put(1, bx0+2, "the split", th.Muted, false)
	lp, rp := 0, 0
	if anim {
		lp, rp = (landedL*100+branchNodes/2)/branchNodes, (landedR*100+branchNodes/2)/branchNodes
	} else {
		lp, rp = (nAgree*100+branchNodes/2)/branchNodes, ((nMixed+nDis)*100+branchNodes/2)/branchNodes
	}
	left := fmt.Sprintf("✓ agree %d%%", lp)
	right := fmt.Sprintf("differ %d%% ✗", rp)
	cv.put(4, bx0+2, left, th.OK, true)
	cv.put(4, bx0+boxW-2-len([]rune(right)), right, th.Err, true)

	// Bus line across the members, drawn outwards from the centre.
	span := cx[n-1] - cx[0]
	busT := t - 4
	reach := span
	if anim && busT < debateIntro-2 {
		reach = max(0, busT) * span / (debateIntro - 2)
	}
	for x := cx[0]; x <= cx[n-1]; x++ {
		if abs(x-mid)*2 <= reach+1 {
			cv.put(busRow, x, "─", th.Subtle, false)
		}
	}
	if reach > 0 {
		cv.put(busRow, mid, "┴", th.Subtle, false)
	}

	for i, m := range d.members {
		e := t - debateIntro - i*debateStep
		if e < 0 {
			continue
		}
		col := th.Speaker(m.color)
		sc := th.Stance(m.stance)
		// The drop line from the bus to the member; disagreement crackles, agreement flows.
		lc := th.Subtle
		switch m.stance {
		case "disagree":
			lc = th.Err
		case "agree":
			lc = th.OK
		case "mixed":
			lc = th.Warn
		}
		cv.put(busRow, cx[i], "┬", lc, true)
		cv.put(busRow+1, cx[i], "│", lc, e > 2)
		if m.stance == "disagree" && anim && e < debateTail+4 && (e/2)%2 == 0 {
			cv.put(busRow+1, cx[i], "⚡", th.Err, true)
		} else if m.stance == "agree" && e < 12 {
			cv.put(busRow+1, cx[i], "•", th.OK, true)
		}
		if e < 2 {
			continue
		}
		chip := ansi.Strip(stanceChip(m.stance, th))
		if m.conf >= 0 {
			chip += fmt.Sprintf(" %d%%", m.conf)
		}
		cv.put(busRow+2, cx[i]-len([]rune(chip))/2, chip, sc, true)
		cv.put(busRow+3, cx[i]-len([]rune(m.id))/2, m.id, col, true)
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
			cv.put(busRow+4+li, cx[i]-len(rs)/2, string(shown), th.Text, false)
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
