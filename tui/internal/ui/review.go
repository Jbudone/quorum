package ui

import (
	"fmt"
	"regexp"
	"strings"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// The review screen: a channel document open over the feed, with the assistant still beside it.
// You move between its sections, ask the authors a question, ask for changes, approve it, or see
// what changed since the version you last reviewed.

type reviewMode string

const (
	reviewReading reviewMode = ""
	reviewClarify reviewMode = "clarify"
	reviewRevise  reviewMode = "revise"
	reviewExport  reviewMode = "export"
)

type reviewSection struct {
	title string
	line  int // the heading's line in the raw text
}

type docReview struct {
	slug                  string
	version, latest       int
	accepted, ready, base int
	text, baseText        string
	secs                  []reviewSection
	changed               map[string]bool // sections that differ from the base version
	cur                   int             // the section the cursor is on
	diff                  bool            // showing the line diff instead of the document
	mode                  reviewMode
	in                    textarea.Model
	offsets               []int // rendered line where each section starts, from the last render
	jump                  bool  // scroll to the current section on the next render
}

func newReview(d rpc.RoomDocText, th theme.Theme) *docReview {
	rv := &docReview{
		slug: d.Name, version: d.Version, latest: d.Latest, accepted: d.Accepted, ready: d.Ready, base: d.Base,
		text: d.Text, baseText: d.BaseText, secs: docSections(d.Text), changed: map[string]bool{}, in: newInput(th, 3),
	}
	if d.Base > 0 {
		for _, t := range changedSections(d.BaseText, d.Text) {
			rv.changed[t] = true
		}
		// Open on the first thing that changed.
		for i, s := range rv.secs {
			if rv.changed[s.title] {
				rv.cur, rv.jump = i, true
				break
			}
		}
	}
	return rv
}

// section is the title of the section under the cursor, or "" for a document without headings.
func (rv *docReview) section() string {
	if rv.cur < len(rv.secs) {
		return rv.secs[rv.cur].title
	}
	return ""
}

func (rv *docReview) move(d int) {
	if len(rv.secs) == 0 {
		return
	}
	rv.cur = min(max(rv.cur+d, 0), len(rv.secs)-1)
	rv.jump = true
}

// state is a few words on where this version stands.
func (rv *docReview) state() string {
	switch {
	case rv.accepted >= rv.version:
		return fmt.Sprintf("v%d accepted", rv.accepted)
	case rv.ready == rv.version:
		return "ready for your review"
	case rv.latest > rv.version:
		return fmt.Sprintf("v%d is newer", rv.latest)
	}
	return "draft"
}

var headingRe = regexp.MustCompile(`^(#{1,3})\s+(.+?)\s*#*\s*$`)
var fenceRe = regexp.MustCompile("^\\s*(```|~~~)")

// docSections lists the headings (# to ###) outside code fences, as the engine does.
func docSections(text string) []reviewSection {
	var out []reviewSection
	fenced := false
	for i, l := range strings.Split(text, "\n") {
		if fenceRe.MatchString(l) {
			fenced = !fenced
		}
		if m := headingRe.FindStringSubmatch(l); !fenced && m != nil {
			out = append(out, reviewSection{title: m[2], line: i})
		}
	}
	return out
}

// sectionBody is a section's text: its heading down to the next heading of the same or a higher level.
func sectionBody(text, title string) (string, bool) {
	lines := strings.Split(text, "\n")
	secs := docSections(text)
	for i, s := range secs {
		if s.title != title {
			continue
		}
		level := len(headingRe.FindStringSubmatch(lines[s.line])[1])
		end := len(lines)
		for _, n := range secs[i+1:] {
			if len(headingRe.FindStringSubmatch(lines[n.line])[1]) <= level {
				end = n.line
				break
			}
		}
		return strings.Join(lines[s.line:end], "\n"), true
	}
	return "", false
}

// ownText is a section's own lines: its heading down to the next heading of any level, so a
// title section doesn't count as changed whenever something under it does.
func ownText(text, title string) (string, bool) {
	lines := strings.Split(text, "\n")
	secs := docSections(text)
	for i, s := range secs {
		if s.title == title {
			end := len(lines)
			if i+1 < len(secs) {
				end = secs[i+1].line
			}
			return strings.TrimRight(strings.Join(lines[s.line:end], "\n"), "\n"), true
		}
	}
	return "", false
}

// changedSections names the sections of after whose own text is new or differs from before.
func changedSections(before, after string) []string {
	var out []string
	for _, s := range docSections(after) {
		a, _ := ownText(after, s.title)
		b, ok := ownText(before, s.title)
		if !ok || a != b {
			out = append(out, s.title)
		}
	}
	return out
}

type diffLine struct {
	op   byte // ' ', '+', '-'
	text string
}

// lineDiff is a longest-common-subsequence line diff; very long pairs fall back to replace-all.
func lineDiff(before, after string) []diffLine {
	a, b := strings.Split(before, "\n"), strings.Split(after, "\n")
	if len(a)*len(b) > 4_000_000 {
		var out []diffLine
		for _, l := range a {
			out = append(out, diffLine{'-', l})
		}
		for _, l := range b {
			out = append(out, diffLine{'+', l})
		}
		return out
	}
	n, m := len(a), len(b)
	lcs := make([][]int32, n+1)
	for i := range lcs {
		lcs[i] = make([]int32, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	var out []diffLine
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			out = append(out, diffLine{' ', a[i]})
			i, j = i+1, j+1
		case lcs[i+1][j] >= lcs[i][j+1]:
			out = append(out, diffLine{'-', a[i]})
			i++
		default:
			out = append(out, diffLine{'+', b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, diffLine{'-', a[i]})
	}
	for ; j < m; j++ {
		out = append(out, diffLine{'+', b[j]})
	}
	return out
}

// renderReview draws the document (or its diff) with a gutter: ▌ marks the section under the
// cursor, and │ marks a section that changed since the version you last reviewed. It records
// where each section starts so the view can scroll to it.
func renderReview(rv *docReview, th theme.Theme, width int) string {
	head := fg(th.Info).Bold(true).Render("REVIEW ") + fg(th.Text).Bold(true).Render(fmt.Sprintf("%s v%d", rv.slug, rv.version)) +
		fg(th.Muted).Render(" · "+rv.state())
	if rv.base > 0 {
		n := len(rv.changed)
		head += fg(th.Subtle).Render(fmt.Sprintf(" · %d section%s changed since v%d", n, map[bool]string{true: "", false: "s"}[n == 1], rv.base))
	}
	lines := []string{ansi.Truncate(head, width, "…"), ""}
	inner := max(width-2, 10)
	if rv.diff && rv.base > 0 {
		lines = append(lines, fg(th.Muted).Render(fmt.Sprintf("Changes from v%d to v%d (d to go back to the document)", rv.base, rv.version)), "")
		for _, d := range lineDiff(rv.baseText, rv.text) {
			c := th.Muted
			switch d.op {
			case '+':
				c = th.OK
			case '-':
				c = th.Err
			}
			for _, w := range strings.Split(ansi.Wrap(string(d.op)+" "+d.text, inner, ""), "\n") {
				lines = append(lines, fg(c).Render(w))
			}
		}
		rv.offsets = nil
		return strings.Join(lines, "\n")
	}
	// Render each section on its own so its start line is known.
	raw := strings.Split(rv.text, "\n")
	starts := []int{0}
	for _, s := range rv.secs {
		if s.line > 0 {
			starts = append(starts, s.line)
		}
	}
	rv.offsets = make([]int, len(rv.secs))
	si := 0
	for k, from := range starts {
		to := len(raw)
		if k+1 < len(starts) {
			to = starts[k+1]
		}
		chunk := strings.TrimRight(strings.Join(raw[from:to], "\n"), "\n")
		if strings.TrimSpace(chunk) == "" {
			continue
		}
		// Which section this chunk is: the preamble before the first heading is none.
		idx := -1
		if si < len(rv.secs) && rv.secs[si].line == from {
			idx = si
			rv.offsets[si] = len(lines)
			si++
		}
		gutter := fg(th.Subtle).Render("  ")
		switch {
		case idx >= 0 && idx == rv.cur:
			gutter = fg(th.Accent2).Render("▌ ")
		case idx >= 0 && rv.changed[rv.secs[idx].title]:
			gutter = fg(th.Warn).Render("│ ")
		}
		for _, l := range strings.Split(renderMarkdown(chunk, inner, th), "\n") {
			lines = append(lines, gutter+l)
		}
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}

// reviewInput is the box under the document while you write a question, changes, or the export path.
func reviewInput(rv *docReview, th theme.Theme, width int) string {
	label := map[reviewMode]string{
		reviewClarify: "Ask the authors",
		reviewRevise:  "What should change",
		reviewExport:  fmt.Sprintf("Approved v%d. Export it to the project? Path", rv.version),
	}[rv.mode]
	if s := rv.section(); s != "" && rv.mode != reviewExport {
		label += " · about " + s
	}
	hint := "enter send · esc cancel"
	if rv.mode == reviewExport {
		hint = "enter export · esc skip"
	}
	rv.in.SetWidth(max(width-2, 10))
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(th.Accent2).Width(width).Render(rv.in.View())
	return fg(th.Accent2).Bold(true).Render(ansi.Truncate(label, width-len(hint)-3, "…")) + "  " + fg(th.Subtle).Render(hint) + "\n" + box
}

const reviewInputH = 6 // label + box (3 rows + border)

// reviewKeys is the footer while a document is open.
func reviewKeys(rv *docReview) [][2]string {
	if rv.mode != reviewReading {
		return [][2]string{{"enter", "send"}, {"esc", "cancel"}}
	}
	keys := [][2]string{{"[ ]", "section"}, {"a", "approve"}, {"c", "ask authors"}, {"r", "request changes"}}
	if rv.base > 0 {
		keys = append(keys, [2]string{"d", "diff"})
	}
	if rv.latest > rv.version {
		keys = append(keys, [2]string{"v", "newest"})
	}
	return append(keys, [2]string{"tab", "ask assistant"}, [2]string{"esc", "close"})
}

// reviewTarget is the document ctrl+r opens: the one waiting for your review, else the latest one.
func (r *roomModel) reviewTarget() string {
	for _, d := range r.docs {
		if d.Ready > d.Accepted {
			return d.Slug
		}
	}
	if len(r.docs) > 0 {
		return r.docs[len(r.docs)-1].Slug
	}
	return ""
}

// awaitingReview is the document version waiting for your review, if any.
func (r *roomModel) awaitingReview() (rpc.RoomDoc, bool) {
	for _, d := range r.docs {
		if d.Ready > d.Accepted {
			return d, true
		}
	}
	return rpc.RoomDoc{}, false
}

// autoOpenReview opens a version that just came up for review, unless you're in the middle of something.
func (a *App) autoOpenReview() {
	r := a.rm.room
	if r == nil || r.openReview == "" {
		return
	}
	slug := r.openReview
	r.openReview = ""
	if r.rev != nil || r.overlay != nil || r.edit != nil || r.review || a.rm.join != nil {
		return
	}
	a.call("room.doc", map[string]any{"name": slug})
}

// handleReviewKey answers keys while a document is open. done is false for keys the room should
// still handle: typing to the assistant, and the app-wide alt and ctrl shortcuts.
func (a *App) handleReviewKey(k tea.KeyPressMsg) (tea.Cmd, bool) {
	u := a.rm
	r := u.room
	rv := r.rev
	key := k.String()
	if r.pane == paneAssistant {
		switch key {
		case "tab", "shift+tab", "esc":
			r.pane = paneRoom
			u.assistIn.Blur()
			return nil, true
		}
		return nil, false
	}
	if rv.mode != reviewReading {
		switch key {
		case "esc":
			if rv.mode == reviewExport {
				r.rev = nil
				return nil, true
			}
			rv.mode = reviewReading
			rv.in.Reset()
			rv.in.Blur()
			return nil, true
		case "enter":
			text := strings.TrimSpace(rv.in.Value())
			if text == "" {
				return nil, true
			}
			if rv.mode == reviewExport {
				a.call("room.exportDoc", map[string]any{"slug": rv.slug, "path": text})
			} else {
				a.call("room.review", map[string]any{"slug": rv.slug, "action": string(rv.mode), "version": rv.version, "section": rv.section(), "text": text})
			}
			return nil, true
		case "alt+enter", "shift+enter":
			if rv.mode != reviewExport {
				rv.in.InsertString("\n")
			}
			return nil, true
		}
		var c tea.Cmd
		rv.in, c = rv.in.Update(k)
		return c, true
	}
	switch key {
	case "]", "n":
		rv.move(1)
	case "[", "p":
		rv.move(-1)
	case "up", "k":
		u.reviewVP.ScrollUp(1)
	case "down", "j":
		u.reviewVP.ScrollDown(1)
	case "pgup":
		u.reviewVP.HalfPageUp()
	case "pgdown", "space":
		u.reviewVP.HalfPageDown()
	case "home", "g":
		u.reviewVP.GotoTop()
	case "end", "G":
		u.reviewVP.GotoBottom()
	case "a":
		a.call("room.review", map[string]any{"slug": rv.slug, "action": "approve", "version": rv.version})
	case "c", "r":
		rv.mode = map[string]reviewMode{"c": reviewClarify, "r": reviewRevise}[key]
		rv.in.Reset()
		return rv.in.Focus(), true
	case "d":
		if rv.base > 0 {
			rv.diff = !rv.diff
			rv.jump = !rv.diff
			u.reviewVP.GotoTop()
		}
	case "v":
		if rv.latest > rv.version {
			a.call("room.doc", map[string]any{"name": rv.slug, "version": rv.latest})
		}
	case "tab", "shift+tab":
		r.pane = paneAssistant
		u.roomIn.Blur()
		return u.assistIn.Focus(), true
	case "esc", "q":
		r.rev = nil
	default:
		// App shortcuts still work; anything else would type into a box you can't see.
		shortcut := strings.HasPrefix(key, "alt+") || strings.HasPrefix(key, "ctrl+")
		return nil, !shortcut
	}
	return nil, true
}
