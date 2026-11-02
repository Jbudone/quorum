package ui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// Highlights: the few messages that changed the discussion, each a line of plain words ("kimi found
// that shrinking the map deletes content"), at the top of the assistant's column. Picking one (a
// click, or alt+h to step back through them) jumps the feed to the message, marks it, and offers
// shortcuts under it: ask the assistant about it, DM its author, or reply in a thread on it.

const highlightsShown = 4

// spotlight is the message picked from the highlights.
type spotlight struct {
	seq  int
	from string
	gist string
	jump bool // scroll the feed to it on the next refresh
}

// spotAction is one shortcut under the spotlit message, and where it sits on its line.
type spotAction struct {
	key, label string
	from, to   int
}

// highlights returns the tagged messages with a gist, oldest first.
func (r *roomModel) highlights() []rpc.MessageTag {
	var out []rpc.MessageTag
	for _, t := range r.tags {
		if strings.TrimSpace(t.Gist) != "" && t.From != "human" {
			out = append(out, t)
		}
	}
	return out
}

// renderHighlights draws the latest highlights, newest at the bottom; seqs has each row's message.
func renderHighlights(r *roomModel, th theme.Theme, width int) (block string, seqs []int) {
	all := r.highlights()
	if len(all) == 0 {
		return "", nil
	}
	shown := all[max(len(all)-highlightsShown, 0):]
	head := fg(th.Info).Bold(true).Render("HIGHLIGHTS")
	if more := len(all) - len(shown); more > 0 {
		head += fg(th.Subtle).Render(fmt.Sprintf("  +%d earlier", more))
	}
	lines := []string{head + fg(th.Subtle).Render("  · click or alt+h")}
	for _, t := range shown {
		mark := tagGlyph(th, t.Kind) + " "
		if r.spot != nil && r.spot.seq == t.Seq {
			mark = fg(th.Accent2).Bold(true).Render("❯ ")
		}
		// Up to two lines each, so the point survives a narrow column; every row maps to its message.
		name := displayName(t.From)
		rows := strings.Split(ansi.Wrap(name+" "+t.Gist, max(width-2, 10), ""), "\n")
		if len(rows) > 2 {
			rows = []string{rows[0], ansi.Truncate(strings.Join(rows[1:], " "), max(width-2, 10), "…")}
		}
		for i, row := range rows {
			if i == 0 {
				rest := strings.TrimPrefix(row, name)
				lines = append(lines, mark+fg(r.colorOf(th, t.From)).Bold(true).Render(name)+fg(th.Text).Render(rest))
			} else {
				lines = append(lines, "  "+fg(th.Text).Render(row))
			}
			seqs = append(seqs, t.Seq)
		}
	}
	return strings.Join(lines, "\n"), seqs
}

// spotActions are the shortcuts offered under the spotlit message.
func spotActions(s *spotlight) []spotAction {
	acts := []spotAction{{key: "a", label: "ask the assistant about it"}}
	if s.from != "" && !strings.HasPrefix(s.from, "mail:") && s.from != "chair" {
		acts = append(acts, spotAction{key: "d", label: "DM " + displayName(s.from)})
	}
	return append(acts, spotAction{key: "t", label: "reply in a thread"}, spotAction{key: "esc", label: "close"})
}

// renderSpotBar is the line of shortcuts under the spotlit message; it records where each one sits.
func renderSpotBar(r *roomModel, th theme.Theme) string {
	acts := spotActions(r.spot)
	var b strings.Builder
	x := 2
	b.WriteString("  ")
	for i, act := range acts {
		if i > 0 {
			b.WriteString(fg(th.Subtle).Render(" · "))
			x += 3
		}
		text := fg(th.Accent2).Bold(true).Render(act.key) + " " + fg(th.Text).Render(act.label)
		w := len([]rune(act.key)) + 1 + len([]rune(act.label))
		acts[i].from, acts[i].to = x, x+w
		x += w
		b.WriteString(text)
	}
	r.spotActs = acts
	return b.String()
}

// spotOn picks a highlighted message: it opens the thread it's in, if any, and jumps the feed to it.
func (a *App) spotOn(seq int) {
	r := a.rm.room
	var tag rpc.MessageTag
	for _, t := range r.tags {
		if t.Seq == seq {
			tag = t
		}
	}
	r.spot = &spotlight{seq: seq, from: tag.From, gist: tag.Gist, jump: true}
	r.view = 0
	for _, it := range r.feed {
		if e := it.ev; e.Seq == seq && e.Type == "message" && e.Thread != 0 && e.Thread != e.Seq {
			r.view = e.Thread
		}
	}
	a.rm.feedFollow = false
}

// stepHighlight moves the spotlight one highlight back (alt+h), wrapping to the newest.
func (a *App) stepHighlight() {
	r := a.rm.room
	all := r.highlights()
	if len(all) == 0 {
		a.notify("No highlights yet: they appear when a member finds something that changes the discussion.")
		return
	}
	i := len(all) - 1
	if r.spot != nil {
		for j, t := range all {
			if t.Seq == r.spot.seq {
				i = j - 1
			}
		}
		if i < 0 {
			i = len(all) - 1
		}
	}
	a.spotOn(all[i].Seq)
}

// spotKey runs a shortcut under the spotlit message. Any other key closes the spotlight and goes on
// to the text box as usual, so typing is never swallowed.
func (a *App) spotKey(key string) (tea.Cmd, bool) {
	u := a.rm
	r := u.room
	s := r.spot
	if s == nil {
		return nil, false
	}
	switch key {
	case "a":
		r.spot = nil
		about := fmt.Sprintf("#%d", s.seq)
		if s.gist != "" {
			about += fmt.Sprintf(" (%s %s)", displayName(s.from), s.gist)
		}
		r.pane = paneAssistant
		u.roomIn.Blur()
		u.assistIn.SetValue(fmt.Sprintf("Explain %s in plain words: what it means, why it matters, and what it changes for us.", about))
		return tea.Batch(u.assistIn.Focus(), a.submitRoom()), true
	case "d":
		if s.from == "" || !r.isMember(s.from) {
			return nil, true
		}
		r.spot = nil
		r.pane = paneRoom
		u.assistIn.Blur()
		u.roomIn.SetValue(fmt.Sprintf("/dm %s About #%d: ", s.from, s.seq))
		u.roomIn.CursorEnd()
		return u.roomIn.Focus(), true
	case "t":
		r.spot = nil
		r.view, u.feedFollow = s.seq, true
		r.pane = paneRoom
		u.assistIn.Blur()
		return u.roomIn.Focus(), true
	case "esc":
		r.spot = nil
		return nil, true
	}
	r.spot = nil
	return nil, false
}

// roomClick handles a click on a highlight or on a shortcut under the spotlit message; it reports
// whether the click was one of those (otherwise it starts a text selection as usual).
func (a *App) roomClick(m tea.MouseClickMsg) (tea.Cmd, bool) {
	u := a.rm
	if a.screen != screenRoom || u == nil || u.setup != nil || u.room == nil || u.join != nil {
		return nil, false
	}
	r := u.room
	if r.overlay != nil || r.edit != nil || r.rev != nil || m.Mouse().Button != tea.MouseLeft {
		return nil, false
	}
	x, y := m.Mouse().X, m.Mouse().Y
	top := 3
	if a.statsShown() {
		top += statsHeight()
	}
	fh, _ := a.paneHeights()
	// The assistant's column: beside the feed, or under it.
	colX, colY := a.feedW()+2, top
	if !a.roomSide() {
		colX, colY = 1, top+fh+1
	}
	if row := y - colY - u.hlStart; x >= colX-1 && y >= colY && row >= 0 && row < len(u.hlSeqs) && (a.roomSide() || y > top+fh) {
		a.spotOn(u.hlSeqs[row])
		return nil, true
	}
	// The shortcuts under the spotlit message, in the feed.
	if r.spot != nil && r.spotBar >= 0 && x < a.feedW() && y >= top && y < top+fh {
		if y-top+u.feedVP.YOffset() == r.spotBar {
			for _, act := range r.spotActs {
				if x >= act.from && x < act.to {
					return a.spotKey(act.key)
				}
			}
			return nil, true
		}
	}
	return nil, false
}
