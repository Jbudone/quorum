package ui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// Highlights: the few messages that changed the discussion, each a few plain words ("kimi found
// resize deletes content"), in a strip across the top of the channel. Hovering one shows a card: a
// short paragraph, the noteworthy points, and a tiny diagram when it helps. Picking one (a click,
// or alt+h to step back through them) jumps the feed to the message, marks it, and offers
// shortcuts under it: ask the assistant about it, DM its author, or reply in a thread on it.

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

// The strip's size: rows of highlights inside its border (as many as there are highlights, up to
// three, fewer on a short terminal so the channel keeps its room), and columns side by side when wide.
func (a *App) stripRows() int {
	n := 0
	if a.rm != nil && a.rm.room != nil {
		n = len(a.rm.room.highlights())
	}
	cols := stripCols(a.w)
	limit := 3
	switch {
	case a.h < 28:
		limit = 1
	case a.h < 40:
		limit = 2
	}
	return min(max(1, (n+cols-1)/cols), limit)
}

func stripCols(width int) int {
	if width >= 110 {
		return 2
	}
	return 1
}

// stripShown reports whether the strip is on screen: not while a modal or document has the body (it
// needs every row on a small screen), and not on a very short terminal, where alt+h still works.
func (a *App) stripShown() bool {
	u := a.rm
	if u == nil || u.room == nil || a.h < 18 {
		return false
	}
	r := u.room
	return u.join == nil && r.edit == nil && r.terms == nil && r.overlay == nil && r.rev == nil
}

// stripHeight is the strip's lines on screen: its border and rows, then a blank line before the room.
func (a *App) stripHeight() int {
	if !a.stripShown() {
		return 0
	}
	return a.stripRows() + 3
}

// highlightWindow is the highlights the strip shows, newest first: the latest that fit, shifted to
// keep the one picked with alt+h in view.
func (r *roomModel) highlightWindow(n int) []rpc.MessageTag {
	all := r.highlights()
	newest := make([]rpc.MessageTag, 0, len(all))
	for i := len(all) - 1; i >= 0; i-- {
		newest = append(newest, all[i])
	}
	from := 0
	if r.spot != nil {
		for i, t := range newest {
			if t.Seq == r.spot.seq && i >= n {
				from = i - n + 1
			}
		}
	}
	return newest[from:min(from+n, len(newest))]
}

// renderHighlightStrip is the highlights across the top of the channel, in their own box: one short
// line each, newest first. grid has each cell's message (0 where empty), row by row.
func renderHighlightStrip(r *roomModel, th theme.Theme, width, stripRows int) (string, [][]int) {
	cols := stripCols(width)
	inner := width - 4
	colW := inner / cols
	all := r.highlights()
	shown := r.highlightWindow(stripRows * cols)
	grid := make([][]int, stripRows)
	cells := make([][]string, stripRows)
	for i := range grid {
		grid[i] = make([]int, cols)
		cells[i] = make([]string, cols)
	}
	for i, t := range shown {
		row, col := i%stripRows, i/stripRows
		mark := tagGlyph(th, t.Kind) + " "
		switch {
		case r.spot != nil && r.spot.seq == t.Seq:
			mark = fg(th.Accent2).Bold(true).Render("❯ ")
		case r.hover == t.Seq:
			mark = fg(th.Accent2).Render("› ")
		}
		name := fg(r.colorOf(th, t.From)).Bold(true).Render(displayName(t.From))
		gist := fg(th.Text).Render(" " + t.Gist)
		if r.hover == t.Seq || r.spot != nil && r.spot.seq == t.Seq {
			gist = fg(th.Accent2).Render(" " + t.Gist)
		}
		cells[row][col] = ansi.Truncate(mark+name+gist, colW-1, "…")
		grid[row][col] = t.Seq
	}
	if len(all) == 0 {
		note := "none yet: when a member finds a flaw, new evidence or a new approach, it lands here"
		if r.busy["highlights"] {
			note = "reading back through the channel for its key moments…"
		}
		cells[0][0] = fg(th.Subtle).Italic(true).Render(ansi.Truncate(note, inner, "…"))
	}
	border := fg(th.Border)
	title := fg(th.Info).Bold(true).Render(" HIGHLIGHTS ")
	// The longest hint that fits the border.
	more := ""
	if n := len(all) - len(shown); n > 0 {
		more = fmt.Sprintf(" +%d earlier ·", n)
	}
	hint := ""
	for _, h := range []string{more + " hover for more · click to jump · alt+h ", more + " alt+h ", fmt.Sprintf(" +%d ", len(all)-len(shown)), ""} {
		if h == " +0 " {
			continue
		}
		if width-2-1-lipgloss.Width(title)-lipgloss.Width(h)-1 >= 1 {
			hint = h
			break
		}
	}
	hint = fg(th.Subtle).Render(hint)
	fill := max(width-2-1-lipgloss.Width(title)-lipgloss.Width(hint)-1, 1)
	lines := []string{border.Render("╭─") + title + border.Render(strings.Repeat("─", fill)) + hint + border.Render("─╮")}
	for _, row := range cells {
		var b strings.Builder
		for _, c := range row {
			b.WriteString(c + strings.Repeat(" ", max(colW-lipgloss.Width(c), 0)))
		}
		line := b.String()
		line += strings.Repeat(" ", max(inner-lipgloss.Width(line), 0))
		lines = append(lines, border.Render("│ ")+line+border.Render(" │"))
	}
	lines = append(lines, border.Render("╰"+strings.Repeat("─", max(width-2, 0))+"╯"))
	return strings.Join(lines, "\n"), grid
}

// spotActions are the shortcuts offered under the spotlit message.
func spotActions(s *spotlight) []spotAction {
	acts := []spotAction{{key: "a", label: "ask your assistant"}}
	if s.from != "" && !strings.HasPrefix(s.from, "mail:") && s.from != "chair" {
		acts = append(acts, spotAction{key: "d", label: "DM " + displayName(s.from)})
	}
	return append(acts, spotAction{key: "t", label: "reply in a thread"}, spotAction{key: "p", label: "its prompt"}, spotAction{key: "esc", label: "close"})
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
	a.askCard(seq)
	a.askGlossary()
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
	case "p":
		r.spot = nil
		a.call("room.prompt", map[string]any{"seq": s.seq})
		return nil, true
	case "esc":
		r.spot = nil
		return nil, true
	}
	r.spot = nil
	return nil, false
}

// highlightAt is the highlight in the strip under a screen position, or 0.
func (a *App) highlightAt(x, y int) int {
	u := a.rm
	row := y - a.stripTop() - 1
	if row < 0 || row >= len(u.hlGrid) || x < 2 || x >= a.w-2 {
		return 0
	}
	cols := len(u.hlGrid[row])
	col := min((x-2)*cols/max(a.w-4, 1), cols-1)
	return u.hlGrid[row][col]
}

func (a *App) inChannel() bool {
	u := a.rm
	return a.screen == screenRoom && u != nil && u.setup == nil && u.room != nil && u.join == nil && u.room.overlay == nil && u.room.edit == nil && a.prov == nil
}

// roomHover follows the mouse over the strip: the highlight under it shows its card, asked for the
// first time it's needed. It reports whether anything changed.
func (a *App) roomHover(m tea.MouseMotionMsg) bool {
	if !a.inChannel() {
		return false
	}
	r := a.rm.room
	seq := a.highlightAt(m.Mouse().X, m.Mouse().Y)
	// Moving onto the card itself keeps it open (and lit), so its links can be clicked.
	if seq == 0 && r.hover != 0 && a.overCard(m.Mouse().X, m.Mouse().Y) {
		changed := !r.cardHot
		r.cardHot = true
		return changed
	}
	changed := seq != r.hover || r.cardHot
	r.hover, r.cardHot = seq, false
	if seq != 0 {
		a.askCard(seq)
		a.askGlossary()
	}
	return changed
}

// askCard asks the engine for a highlight's card, once.
func (a *App) askCard(seq int) {
	u := a.rm
	r := u.room
	if _, ok := r.cards[seq]; ok {
		return
	}
	if u.cardReqs == nil {
		u.cardReqs = map[int]int{}
	}
	for _, s := range u.cardReqs {
		if s == seq {
			return
		}
	}
	delete(r.cardErr, seq)
	if id := a.call("room.highlight", map[string]any{"seq": seq}); id >= 0 {
		u.cardReqs[id] = seq
	}
}

// cardResponse files a card the engine wrote (it also arrives as a highlight.card event).
func (a *App) cardResponse(id int, method string, res rpc.Response) bool {
	if method != "room.highlight" || a.rm == nil {
		return false
	}
	seq := a.rm.cardReqs[id]
	delete(a.rm.cardReqs, id)
	if r := a.rm.room; r != nil && seq != 0 {
		var out struct {
			Text string `json:"text"`
		}
		switch {
		case res.Err != "":
			r.cardErr[seq] = res.Err
		case rpc.DecodeResult(res.Result, &out) == nil && out.Text != "":
			r.cards[seq] = out.Text
		}
	}
	return true
}

// cardBox is where the card sits: under the strip, at the hovered cell's column, or for a highlight
// picked with alt+h, at the bottom of the feed so it doesn't cover the message.
func (a *App) cardBox(fh int) (seq, x, y, w int) {
	r := a.rm.room
	seq = r.hover
	w = min(64, a.w-4)
	if seq == 0 {
		return 0, 0, 0, 0
	}
	x, y = 2, a.bodyTop()-1
	for _, row := range a.rm.hlGrid {
		for c, s := range row {
			if s == seq && c > 0 {
				x = min(2+c*(a.w-4)/len(row), a.w-w-2)
			}
		}
	}
	return seq, x, y, w
}

func (a *App) overCard(mx, my int) bool {
	fh, _ := a.paneHeights()
	seq, x, y, w := a.cardBox(fh)
	return seq != 0 && mx >= x && mx < x+w && my >= y && my < y+a.rm.cardH
}

// highlightCard draws the card for the hovered highlight, and where it goes on screen.
func (a *App) highlightCard(fh int) (string, int, int) {
	r := a.rm.room
	if !a.inChannel() || r.rev != nil {
		return "", 0, 0
	}
	seq, x, y, w := a.cardBox(fh)
	if seq == 0 {
		return "", 0, 0
	}
	th := a.th
	var tag rpc.MessageTag
	for _, t := range r.tags {
		if t.Seq == seq && t.Gist != "" {
			tag = t
		}
	}
	inner := w - 4
	head := tagGlyph(th, tag.Kind) + " " + fg(r.colorOf(th, tag.From)).Bold(true).Render(displayName(tag.From)) + fg(th.Text).Bold(true).Render(" "+tag.Gist)
	body := fg(th.Muted).Italic(true).Render(a.spin.View() + " writing a short summary…")
	if text, ok := r.cards[seq]; ok {
		body = strings.TrimRight(renderMarkdown(r.linkify(text), inner, th), "\n")
	} else if err := r.cardErr[seq]; err != "" {
		body = fg(th.Err).Render(ansi.Wrap("✗ couldn't write it: "+err, inner, ""))
	}
	foot := fg(th.Subtle).Render(fmt.Sprintf("#%d · click to open it · names link to the glossary", seq))
	if r.cardHot {
		foot = fg(th.Accent2).Render("click a name to look it up · click elsewhere to open the message · move away to close")
	}
	content := ansi.Truncate(head, inner, "…") + "\n\n" + body + "\n\n" + foot
	// Never taller than the room under the strip.
	if lines := strings.Split(content, "\n"); len(lines) > fh-2 {
		content = strings.Join(append(lines[:max(fh-3, 1)], fg(th.Subtle).Render("…")), "\n")
	}
	// Lit while the mouse is on it, so it's clear moving away will close it.
	edge := lipgloss.NormalBorder()
	color := th.Border
	if r.cardHot {
		edge, color = lipgloss.ThickBorder(), th.Accent2
	}
	box := lipgloss.NewStyle().Border(edge).BorderForeground(color).Padding(0, 1).Width(w).Render(content)
	a.rm.cardH = lipgloss.Height(box)
	// Links: the body starts 2 columns and 3 lines into the box (border, padding, head, blank line).
	r.cardLinks = nil
	if _, ok := r.cards[seq]; ok {
		r.cardLinks = r.findLinks(strings.Split(body, "\n"), x+2, y+3)
	}
	return box, x, y
}

// roomClick handles a click on a highlight or on a shortcut under the spotlit message; it reports
// whether the click was one of those (otherwise it starts a text selection as usual).
func (a *App) roomClick(m tea.MouseClickMsg) (tea.Cmd, bool) {
	if !a.inChannel() || m.Mouse().Button != tea.MouseLeft {
		return nil, false
	}
	r := a.rm.room
	x, y := m.Mouse().X, m.Mouse().Y
	// The card floats over the room, so it's checked first: a name opens the glossary, anywhere
	// else opens the message with the card's summary above it.
	if r.hover != 0 && a.overCard(x, y) {
		if term, ok := linkAt(r.cardLinks, x, y); ok {
			return a.openTerms(term), true
		}
		seq := r.hover
		r.hover, r.cardHot = 0, false
		a.spotOn(seq)
		return nil, true
	}
	if seq := a.highlightAt(x, y); seq != 0 {
		r.hover = 0
		a.spotOn(seq)
		return nil, true
	}
	// The shortcuts under the spotlit message, in the feed.
	top := a.bodyTop()
	fh, _ := a.paneHeights()
	if term, ok := linkAt(r.feedLinks, x, y-top+a.rm.feedVP.YOffset()); ok && x < a.feedW() && y >= top && y < top+fh {
		return a.openTerms(term), true
	}
	if r.spot != nil && r.spotBar >= 0 && x < a.feedW() && y >= top && y < top+fh && y-top+a.rm.feedVP.YOffset() == r.spotBar {
		for _, act := range r.spotActs {
			if x >= act.from && x < act.to {
				return a.spotKey(act.key)
			}
		}
		return nil, true
	}
	return nil, false
}
