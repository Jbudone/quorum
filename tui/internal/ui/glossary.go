package ui

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// The glossary: the project's ADRs, the terms its notes define, and the code names a channel keeps
// using, each with a brief. Names in highlight cards (and the summary pinned over a picked message)
// are links into it; alt+t or /terms opens it to browse and filter.

type termsModal struct {
	filter textarea.Model
	cur    int
}

// termLink is a clickable name on screen or in rendered text: its line, columns [from, to), and term.
type termLink struct {
	row, from, to int
	term          string
}

var adrRef = regexp.MustCompile(`\bADR[-\s]?\d{1,4}\b`)

// termNames is every name a link can match, longest first, so "activeContext.grid" wins over "activeContext".
func (r *roomModel) termNames() []string {
	var names []string
	for _, e := range r.glossary {
		names = append(names, e.Term)
		names = append(names, e.Aliases...)
	}
	slices.SortFunc(names, func(a, b string) int { return len(b) - len(a) })
	return names
}

// entryFor finds the glossary entry a name refers to.
func (r *roomModel) entryFor(name string) (rpc.GlossaryEntry, bool) {
	norm := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		if m := regexp.MustCompile(`^adr[-\s]?0*(\d+)$`).FindStringSubmatch(s); m != nil {
			return "adr " + m[1]
		}
		return s
	}
	n := norm(name)
	for _, e := range r.glossary {
		if norm(e.Term) == n || slices.ContainsFunc(e.Aliases, func(a string) bool { return norm(a) == n }) {
			return e, true
		}
	}
	return rpc.GlossaryEntry{}, false
}

// linkify marks the names the glossary knows (and any ADR number) as code, so they stand out as
// links when rendered; fenced blocks (diagrams) are left alone.
func (r *roomModel) linkify(text string) string {
	names := r.termNames()
	lines := strings.Split(text, "\n")
	fence := false
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			fence = !fence
			continue
		}
		if fence {
			continue
		}
		// Split around existing code spans; only the prose between them is marked.
		parts := strings.Split(l, "`")
		for j := 0; j < len(parts); j += 2 {
			parts[j] = markNames(parts[j], names)
		}
		lines[i] = strings.Join(parts, "`")
	}
	return strings.Join(lines, "\n")
}

func markNames(s string, names []string) string {
	type span struct{ from, to int }
	var spans []span
	taken := func(a, b int) bool {
		return slices.ContainsFunc(spans, func(x span) bool { return a < x.to && b > x.from })
	}
	word := func(c byte) bool {
		return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
	}
	for _, n := range names {
		if len(n) < 3 {
			continue
		}
		for at := 0; ; {
			i := strings.Index(s[at:], n)
			if i < 0 {
				break
			}
			a, b := at+i, at+i+len(n)
			if (a == 0 || !word(s[a-1])) && (b == len(s) || !word(s[b])) && !taken(a, b) {
				spans = append(spans, span{a, b})
			}
			at = b
		}
	}
	for _, m := range adrRef.FindAllStringIndex(s, -1) {
		if !taken(m[0], m[1]) {
			spans = append(spans, span{m[0], m[1]})
		}
	}
	slices.SortFunc(spans, func(a, b span) int { return b.from - a.from })
	for _, sp := range spans {
		s = s[:sp.from] + "`" + s[sp.from:sp.to] + "`" + s[sp.to:]
	}
	return s
}

// findLinks locates the glossary's names in rendered lines (styled or not), offset by (dx, dy).
func (r *roomModel) findLinks(rendered []string, dx, dy int) []termLink {
	names := r.termNames()
	var out []termLink
	for y, line := range rendered {
		plain := ansi.Strip(line)
		used := make([]bool, len(plain))
		add := func(a, b int, term string) {
			for i := a; i < b; i++ {
				if used[i] {
					return
				}
			}
			for i := a; i < b; i++ {
				used[i] = true
			}
			from := lipgloss.Width(plain[:a])
			out = append(out, termLink{row: dy + y, from: dx + from, to: dx + from + lipgloss.Width(plain[a:b]), term: term})
		}
		for _, n := range names {
			if len(n) < 3 {
				continue
			}
			for at := 0; ; {
				i := strings.Index(plain[at:], n)
				if i < 0 {
					break
				}
				add(at+i, at+i+len(n), n)
				at += i + len(n)
			}
		}
		for _, m := range adrRef.FindAllStringIndex(plain, -1) {
			add(m[0], m[1], plain[m[0]:m[1]])
		}
	}
	return out
}

func linkAt(links []termLink, x, y int) (string, bool) {
	for _, l := range links {
		if l.row == y && x >= l.from && x < l.to {
			return l.term, true
		}
	}
	return "", false
}

// askGlossary loads the glossary once per channel (and again when new briefs arrive).
func (a *App) askGlossary() {
	r := a.rm.room
	if r.glossaryAsked {
		return
	}
	r.glossaryAsked = true
	a.call("room.glossary", map[string]any{})
}

func (a *App) glossaryResponse(method string, res rpc.Response) bool {
	if method != "room.glossary" || a.rm == nil || a.rm.room == nil {
		return false
	}
	var out rpc.GlossaryResult
	if res.Err == "" && rpc.DecodeResult(res.Result, &out) == nil {
		a.rm.room.glossary, a.rm.room.glossaryWriting = out.Entries, out.Writing
	}
	return true
}

// openTerms opens the glossary, filtered to a term when one was clicked.
func (a *App) openTerms(term string) tea.Cmd {
	r := a.rm.room
	a.askGlossary()
	f := newInput(a.th, 1)
	f.Placeholder = "filter: a name, a word from its brief, adr, code…"
	if term != "" {
		if e, ok := r.entryFor(term); ok {
			term = e.Term
		}
		f.SetValue(term)
	}
	r.hover = 0
	r.terms = &termsModal{filter: f}
	return r.terms.filter.Focus()
}

func (r *roomModel) termMatches() []rpc.GlossaryEntry {
	q := strings.ToLower(strings.TrimSpace(r.terms.filter.Value()))
	var out []rpc.GlossaryEntry
	for _, e := range r.glossary {
		hay := strings.ToLower(e.Term + " " + strings.Join(e.Aliases, " ") + " " + e.Brief + " " + e.Kind + " " + e.Source)
		if q == "" || strings.Contains(hay, q) {
			out = append(out, e)
		}
	}
	// An exact name first, then ADRs, defined terms, and the channel's names.
	rank := map[string]int{"adr": 0, "term": 1, "code": 2}
	slices.SortStableFunc(out, func(x, y rpc.GlossaryEntry) int {
		xe, ye := strings.EqualFold(x.Term, q), strings.EqualFold(y.Term, q)
		switch {
		case xe && !ye:
			return -1
		case ye && !xe:
			return 1
		}
		if d := rank[x.Kind] - rank[y.Kind]; d != 0 {
			return d
		}
		if x.Kind == "adr" {
			return strings.Compare(x.Term, y.Term) // ADRs by number
		}
		return 0
	})
	return out
}

func (a *App) handleTermsKey(k tea.KeyPressMsg) tea.Cmd {
	r := a.rm.room
	t := r.terms
	n := len(r.termMatches())
	switch k.String() {
	case "esc", "alt+t":
		r.terms = nil
		return nil
	case "up":
		t.cur = max(t.cur-1, 0)
		return nil
	case "down":
		t.cur = min(t.cur+1, max(n-1, 0))
		return nil
	}
	before := t.filter.Value()
	var c tea.Cmd
	t.filter, c = t.filter.Update(k)
	if t.filter.Value() != before {
		t.cur = 0
	}
	return c
}

func renderTerms(r *roomModel, th theme.Theme, w, h int) string {
	t := r.terms
	items := r.termMatches()
	t.cur = min(t.cur, max(len(items)-1, 0))
	listW := min(max(w*2/5, 28), 48)
	detailW := max(w-listW-3, 20)
	t.filter.SetWidth(w - 2)
	head := []string{sectionTitle("glossary", w, th, true), fg(th.Muted).Render("ADRs, the terms the project's notes define, and the names this channel keeps using."), "", t.filter.View(), ""}
	rows := max(h-len(head)-2, 3)
	top := max(0, t.cur-rows+1)
	badge := map[string]string{"adr": "    ", "term": "term", "code": "code"}
	var list []string
	for i := top; i < len(items) && i < top+rows; i++ {
		e := items[i]
		mark, st := "  ", fg(th.Text)
		if i == t.cur {
			mark, st = fg(th.Accent2).Render("❯ "), fg(th.Accent2).Bold(true)
		}
		list = append(list, ansi.Truncate(mark+fg(th.Subtle).Render(badge[e.Kind]+" ")+st.Render(e.Term), listW, "…"))
	}
	if len(items) == 0 {
		list = append(list, fg(th.Subtle).Italic(true).Render("nothing matches"))
		if len(r.glossary) == 0 {
			list = []string{fg(th.Subtle).Italic(true).Render("reading the project's ADRs and notes…")}
		}
	}
	var detail []string
	if t.cur < len(items) {
		e := items[t.cur]
		detail = append(detail, fg(th.Text).Bold(true).Render(e.Term))
		if len(e.Aliases) > 0 {
			detail = append(detail, fg(th.Subtle).Render("also "+strings.Join(e.Aliases, ", ")))
		}
		detail = append(detail, "")
		brief := e.Brief
		if brief == "" {
			brief = "being explained…"
		}
		detail = append(detail, strings.Split(ansi.Wrap(brief, detailW, ""), "\n")...)
		detail = append(detail, "")
		switch {
		case e.Source == "channel":
			where := "used in this channel"
			if len(e.Mentions) > 0 {
				ms := make([]string, 0, len(e.Mentions))
				for _, m := range e.Mentions[:min(len(e.Mentions), 8)] {
					ms = append(ms, fmt.Sprintf("#%d", m))
				}
				where += ": " + strings.Join(ms, " ")
			}
			detail = append(detail, fg(th.Subtle).Render(ansi.Wrap(where+" · not defined in the repo; the brief is the assistant's reading", detailW, "")))
		case e.Source != "":
			detail = append(detail, fg(th.Subtle).Render("from "+e.Source))
		}
	}
	for i := range detail {
		detail[i] = ansi.Truncate(detail[i], detailW, "…")
	}
	body := lipgloss.JoinHorizontal(lipgloss.Top, lipgloss.NewStyle().Width(listW).Render(strings.Join(list, "\n")), "   ", strings.Join(detail, "\n"))
	foot := fmt.Sprintf("%d of %d", len(items), len(r.glossary))
	if r.glossaryWriting {
		foot += " · explaining the channel's names…"
	}
	return strings.Join(append(head, body, "", fg(th.Subtle).Render(foot+" · type to filter · ↑↓ choose · esc close")), "\n")
}

// summaryBlock is a highlight's card pinned above its message in the feed, clearly apart from it;
// it returns the block and its links, relative to the block's first line.
func summaryBlock(r *roomModel, th theme.Theme, seq, width int) (string, []termLink) {
	text, ok := r.cards[seq]
	if !ok {
		return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(th.Border).Padding(0, 1).Width(width).Render(fg(th.Muted).Italic(true).Render("writing a short summary…")), nil
	}
	inner := width - 4
	head := fg(th.Info).Bold(true).Render("SUMMARY") + fg(th.Subtle).Render("  by your assistant · names link to the glossary")
	body := strings.TrimRight(renderMarkdown(r.linkify(text), inner, th), "\n")
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(th.Info).Padding(0, 1).Width(width).Render(head + "\n\n" + body)
	// Links inside: the border and padding put the text 2 columns in and 1 line down, after the head.
	links := r.findLinks(strings.Split(body, "\n"), 2, 3)
	return box, links
}
