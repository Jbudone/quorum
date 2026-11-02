package ui

import (
	"fmt"
	"image/color"
	"sort"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

// The stats strip: a glanceable checkpoint above the feed, built from the floor's tags on each message
// (what it did to the discussion) and the channel's own events. It costs no model calls of its own.

const statsRows = 4 // content lines under each column title

// tagGlyph marks what a message did, in one cell.
func tagGlyph(th theme.Theme, kind string) string {
	switch kind {
	case "idea":
		return fg(th.Info).Render("+")
	case "critique":
		return fg(th.Err).Render("✗")
	case "agreement":
		return fg(th.OK).Render("✓")
	case "concession":
		return fg(th.Warn).Render("↻")
	case "question":
		return fg(th.Accent2).Render("?")
	case "evidence":
		return fg(th.Muted).Render("≡")
	case "decision":
		return fg(th.OK).Bold(true).Render("◆")
	}
	return fg(th.Subtle).Render("·")
}

// recentLines are the latest happenings, newest last: tagged messages and the events that matter.
func recentLines(r *roomModel, th theme.Theme, n int) []string {
	type item struct {
		seq  int
		line string
	}
	var items []item
	for _, t := range r.tags {
		who := displayName(t.From)
		if t.Kind == "critique" && t.Against != "" {
			who += " vs " + displayName(t.Against)
		}
		items = append(items, item{t.Seq, tagGlyph(th, t.Kind) + " " + fg(r.colorOf(th, t.From)).Render(who) + fg(th.Muted).Render(": "+t.Headline)})
	}
	for _, it := range r.feed {
		e := it.ev
		var line string
		switch e.Type {
		case "doc.revised":
			line = fg(th.Accent).Render("✎ ") + fg(th.Muted).Render(fmt.Sprintf("%s v%d by %s", e.Slug, e.Version, e.By))
		case "doc.accepted":
			line = fg(th.OK).Render("✓ ") + fg(th.Text).Render(fmt.Sprintf("%s v%d accepted", e.Slug, e.Version))
		case "topic.raised":
			if r.opening(e) {
				continue
			}
			line = fg(th.Info).Render("◇ ") + fg(th.Muted).Render("new topic: "+e.Title)
		case "agent.joined":
			line = fg(th.OK).Render("+ ") + fg(th.Muted).Render(e.Agent+" joined")
		case "thread.summary":
			line = fg(th.Info).Render("↳ ") + fg(th.Muted).Render("thread settled: "+e.Text)
		default:
			continue
		}
		items = append(items, item{e.Seq, line})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].seq < items[j].seq })
	if len(items) > n {
		items = items[len(items)-n:]
	}
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.line
	}
	return out
}

// discussion is one conversation in the channel: a topic or a side thread, with where it stands.
type discussion struct {
	mark, title    string
	agreed, open   string
	settled, focus bool
	last           int
}

func discussions(r *roomModel) []discussion {
	byTopic := map[string]*discussion{}
	var ds []*discussion
	for _, t := range r.topics {
		d := &discussion{mark: "◇", title: t.Title, focus: t.Slug == r.focus, settled: t.Closed}
		if d.focus {
			d.mark = "▶"
		}
		byTopic[t.Slug] = d
		ds = append(ds, d)
	}
	byThread := map[int]*discussion{}
	for _, t := range r.threadList() {
		d := &discussion{mark: "↳", title: t.title, settled: t.summary != "", last: t.last}
		if t.summary != "" {
			d.agreed = t.summary
		}
		byThread[t.root] = d
		ds = append(ds, d)
	}
	for _, t := range r.tags {
		d := byThread[t.Thread]
		if t.Thread == 0 {
			d = byTopic[t.Topic]
			if d == nil {
				d = byTopic[r.focus]
			}
		}
		if d == nil {
			continue
		}
		d.last = max(d.last, t.Seq)
		switch t.Kind {
		case "decision", "agreement":
			if !d.settled || d.agreed == "" {
				d.agreed = t.Headline
			}
		case "critique", "question":
			d.open = t.Headline
		case "concession":
			d.open = "" // whoever pushed back got their way
		}
	}
	out := make([]discussion, 0, len(ds))
	for _, d := range ds {
		out = append(out, *d)
	}
	// The focus first, then whatever moved most recently; settled threads sink.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].focus != out[j].focus {
			return out[i].focus
		}
		if out[i].settled != out[j].settled {
			return !out[i].settled
		}
		return out[i].last > out[j].last
	})
	return out
}

func discussionLines(r *roomModel, th theme.Theme, n int) []string {
	var lines []string
	for _, d := range discussions(r) {
		if len(lines) >= n {
			break
		}
		c := th.Text
		if d.settled {
			c = th.Muted
		}
		lines = append(lines, fg(th.Accent2).Render(d.mark+" ")+fg(c).Render(d.title))
		if d.agreed != "" && len(lines) < n {
			lines = append(lines, "  "+fg(th.OK).Render("agreed ")+fg(th.Muted).Render(d.agreed))
		}
		if d.open != "" && len(lines) < n {
			lines = append(lines, "  "+fg(th.Warn).Render("open ")+fg(th.Muted).Render(d.open))
		}
	}
	return lines
}

// memberStat is how one member has taken part so far.
type memberStat struct {
	id                                  string
	said                                int
	ideas, critiques, conceded, decided int
	challenged                          int // critiques aimed at them
}

func memberStats(r *roomModel) []memberStat {
	idx := map[string]*memberStat{}
	var all []*memberStat
	for _, a := range r.agents {
		m := &memberStat{id: a.ID}
		idx[a.ID] = m
		all = append(all, m)
	}
	for seq, from := range r.authors {
		if m := idx[from]; m != nil && seq > 0 {
			m.said++
		}
	}
	for _, t := range r.tags {
		m := idx[t.From]
		if m != nil {
			switch t.Kind {
			case "idea":
				m.ideas++
			case "critique":
				m.critiques++
			case "concession":
				m.conceded++
			case "decision":
				m.decided++
			}
		}
		if t.Kind == "critique" && idx[t.Against] != nil {
			idx[t.Against].challenged++
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].said > all[j].said })
	out := make([]memberStat, len(all))
	for i, m := range all {
		out[i] = *m
	}
	return out
}

func memberLines(r *roomModel, th theme.Theme, width, n int) []string {
	stats := memberStats(r)
	if len(stats) == 0 {
		return nil
	}
	most := max(stats[0].said, 1)
	nameW := 0
	for _, m := range stats {
		nameW = max(nameW, lipgloss.Width(m.id))
	}
	nameW = min(nameW, max(width/3, 8))
	barW := max(min(width-nameW-18, 10), 3)
	count := func(c color.Color, glyph string, v int) string {
		if v == 0 {
			return ""
		}
		return " " + fg(c).Render(fmt.Sprintf("%s%d", glyph, v))
	}
	var lines []string
	shown := stats
	if len(shown) > n-1 {
		shown = shown[:n-1]
	}
	for _, m := range shown {
		bar := strings.Repeat("█", m.said*barW/most)
		if bar == "" && m.said > 0 {
			bar = "▏"
		}
		line := fg(r.colorOf(th, m.id)).Render(padRight(m.id, nameW)) + " " + fg(r.colorOf(th, m.id)).Render(padRight(bar, barW)) +
			fg(th.Muted).Render(fmt.Sprintf(" %2d", m.said)) +
			count(th.Info, "+", m.ideas) + count(th.Err, "✗", m.critiques) + count(th.Warn, "↻", m.conceded)
		if l, ok := r.agentUsage(m.id); ok {
			// Billed members show money; subscription members show their share of the quota window.
			cost := costOf(l.Tally)
			if l.USD == 0 {
				if share, ok := r.quotaShare(m.id, l.CLI); ok {
					cost = share
				} else if t := l.Input + l.Output; t > 0 {
					cost = fmtTok(t) + " tok"
				}
			}
			line += fg(th.Subtle).Render(" " + cost)
		}
		lines = append(lines, line)
	}
	var ideas, critiques, decisions int
	for _, t := range r.tags {
		switch t.Kind {
		case "idea":
			ideas++
		case "critique":
			critiques++
		case "decision":
			decisions++
		}
	}
	lines = append(lines, fg(th.Subtle).Render(plural(ideas, "idea")+" · "+plural(critiques, "critique")+" · "+plural(decisions, "decision")))
	return lines
}

// renderStats lays the strip out in up to three columns, as many as fit.
func renderStats(r *roomModel, th theme.Theme, width int) string {
	type col struct {
		title string
		lines []string
	}
	cols := []col{{"recent", nil}, {"discussions", nil}, {"members", nil}, {"budget", nil}}
	// Narrower screens drop discussions first, then recent, then members; the budget always shows.
	keep := []int{0, 1, 2, 3}
	switch {
	case width < 70:
		keep = []int{3}
	case width < 110:
		keep = []int{2, 3}
	case width < 150:
		keep = []int{0, 2, 3}
	}
	n := len(keep)
	colW := (width - (n - 1)) / n
	cols[0].lines = recentLines(r, th, statsRows)
	cols[1].lines = discussionLines(r, th, statsRows)
	cols[2].lines = memberLines(r, th, colW, statsRows)
	cols[3].lines = budgetLines(r, th, colW, statsRows, time.Now())
	cols[3].title = "budget · " + scopeNames[r.scope]
	var shown []col
	for _, i := range keep {
		shown = append(shown, cols[i])
	}
	cols = shown
	blocks := make([]string, len(cols))
	for i, c := range cols {
		rows := []string{sectionTitle(c.title, colW, th, false)}
		for j := 0; j < statsRows; j++ {
			line := ""
			if j < len(c.lines) {
				line = ansi.Truncate(c.lines[j], colW, "…")
			} else if j == 0 && len(c.lines) == 0 {
				line = fg(th.Subtle).Italic(true).Render("nothing yet")
			}
			rows = append(rows, line)
		}
		blocks[i] = lipgloss.NewStyle().Width(colW).Render(strings.Join(rows, "\n"))
	}
	sep := fg(th.Subtle).Render(strings.TrimRight(strings.Repeat("│\n", statsRows+1), "\n"))
	parts := []string{blocks[0]}
	for _, b := range blocks[1:] {
		parts = append(parts, sep, b)
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, parts...)
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// statsHeight is how many rows the strip takes, including the blank line under it.
func statsHeight() int { return statsRows + 2 }
