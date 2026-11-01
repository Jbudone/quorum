package ui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// What the channel used, three ways: this sitting (since the channel was opened), the whole
// channel, and every channel in the project. The budget column shows one (alt+v cycles); the usage
// screen (alt+u or /usage) shows them in full, with quotas, members, support roles and models.

const (
	scopeSitting = iota
	scopeChannel
	scopeProject
)

var scopeNames = []string{"this sitting", "this channel", "this project"}

type usageScreen struct {
	tab int
	top int // first line shown, for scrolling
}

func fmtTok(n int) string {
	if n < 1000 {
		return fmt.Sprint(n)
	}
	return fmtCtx(n)
}

// costOf is a tally in one short figure: what was billed, else what it would cost at API prices, else tokens.
func costOf(t rpc.Tally) string {
	switch {
	case t.USD > 0:
		return fmtUSD(t.USD)
	case t.ListUSD > 0:
		return "≈" + fmtUSD(t.ListUSD)
	case t.Input+t.Output > 0:
		return fmtTok(t.Input+t.Output) + " tok"
	}
	return ""
}

// scoped is the usage the budget column is showing, if it's known yet.
func (r *roomModel) scoped(scope int) *rpc.UsageScope {
	switch {
	case scope == scopeProject && r.project != nil:
		return r.project
	case scope == scopeProject || r.usage == nil:
		return nil
	case scope == scopeSitting:
		return &r.usage.Sitting.UsageScope
	}
	return &r.usage.Channel
}

// agentUsage is a member's share in what the budget column shows (the channel's, for the project view).
func (r *roomModel) agentUsage(id string) (rpc.UsageLine, bool) {
	s := r.scoped(min(r.scope, scopeChannel))
	if s == nil {
		return rpc.UsageLine{}, false
	}
	for _, l := range s.ByAgent {
		if l.ID == id {
			return l, costOf(l.Tally) != ""
		}
	}
	return rpc.UsageLine{}, false
}

// quotaMoved is how far a quota window moved since the sitting began. reset means it rolled over
// in between, so the figure is a floor.
func (r *roomModel) quotaMoved(cli string, w rpc.QuotaWindow) (delta float64, reset, ok bool) {
	if r.usage == nil {
		return 0, false, false
	}
	for _, s := range r.usage.Sitting.Quota[cli] {
		if s.Label != w.Label {
			continue
		}
		// Reset times wobble a little between readings; a window that rolled over resets a whole window later.
		was, err1 := time.Parse(time.RFC3339Nano, s.ResetsAt)
		is, err2 := time.Parse(time.RFC3339Nano, w.ResetsAt)
		if err1 == nil && err2 == nil && is.Sub(was) > time.Minute {
			return w.Used, true, true
		}
		return w.Used - s.Used, false, true
	}
	return 0, false, false
}

func fmtMoved(d float64, reset bool) string {
	s := fmt.Sprintf("+%d%%", int(max(d, 0)*100+0.5))
	if reset {
		s += " since reset"
	}
	return s
}

// cycleScope moves the budget column to the next view, asking for the project's figures when needed.
func (a *App) cycleScope() {
	if a.rm == nil || a.rm.room == nil {
		return
	}
	r := a.rm.room
	r.scope = (r.scope + 1) % len(scopeNames)
	if r.scope == scopeProject {
		a.askUsage()
	}
}

func (a *App) askUsage() {
	a.call("usage.report", map[string]any{"project": true})
}

func (a *App) openUsage() {
	if a.rm == nil || a.rm.room == nil {
		return
	}
	r := a.rm.room
	a.usage = &usageScreen{tab: r.scope}
	a.askUsage()
	a.askMeters()
}

func (a *App) usageResponse(method string, res rpc.Response) bool {
	if method != "usage.report" {
		return false
	}
	var u rpc.UsageReport
	if res.Err == "" && rpc.DecodeResult(res.Result, &u) == nil && a.rm != nil && a.rm.room != nil {
		r := a.rm.room
		r.project = u.Project
		u.Project = nil
		r.usage = &u
	}
	return true
}

func (a *App) handleUsageKey(k tea.KeyPressMsg) tea.Cmd {
	u := a.usage
	switch key := k.String(); key {
	case "esc", "alt+u", "q":
		a.usage = nil
	case "alt+1", "alt+2", "alt+3":
		u.tab, u.top = int(key[4]-'1'), 0
	case "tab", "alt+right", "right":
		u.tab, u.top = (u.tab+1)%len(scopeNames), 0
	case "shift+tab", "alt+left", "left":
		u.tab, u.top = (u.tab+len(scopeNames)-1)%len(scopeNames), 0
	case "down", "j":
		u.top++
	case "up", "k":
		u.top = max(u.top-1, 0)
	case "pgdown":
		u.top += max(a.h-8, 1)
	case "pgup":
		u.top = max(u.top-max(a.h-8, 1), 0)
	case "alt+r":
		a.askUsage()
		a.call("usage.meters", map[string]any{"refresh": true})
	}
	return nil
}

// usageTable lays out lines as aligned columns: who, where it runs, turns, tokens, billed, at API prices.
func usageTable(th theme.Theme, w int, title string, rows []rpc.UsageLine, where bool) []string {
	if len(rows) == 0 {
		return nil
	}
	nameW, whereW := 4, 0
	for _, l := range rows {
		nameW = max(nameW, min(lipgloss.Width(l.ID), 28))
		if where {
			whereW = max(whereW, min(lipgloss.Width(strings.TrimSpace(l.CLI+" "+l.Model)), 44))
		}
	}
	cols := func(name, at, turns, in, out, cached, billed, api string) string {
		s := padRight(ansi.Truncate(name, nameW, "…"), nameW) + "  "
		if where {
			s += padRight(ansi.Truncate(at, whereW, "…"), whereW) + "  "
		}
		return s + fmt.Sprintf("%6s %8s %8s %8s %9s %10s", turns, in, out, cached, billed, api)
	}
	out := []string{fg(th.Accent2).Bold(true).Render(title), fg(th.Subtle).Render(ansi.Truncate(cols("", "", "turns", "in", "out", "cached", "billed", "≈ at API"), w, ""))}
	for _, l := range rows {
		billed, api := "—", "—"
		if l.USD > 0 {
			billed = fmtUSD(l.USD)
		}
		if l.ListUSD > 0 {
			api = fmtUSD(l.ListUSD)
		}
		out = append(out, ansi.Truncate(cols(l.ID, strings.TrimSpace(l.CLI+" "+l.Model), fmt.Sprint(l.Turns), fmtTok(l.Input), fmtTok(l.Output), fmtTok(l.CacheRead), billed, api), w, "…"))
	}
	return append(out, "")
}

func totalLine(th theme.Theme, t rpc.Tally) string {
	parts := []string{fg(th.Text).Bold(true).Render(fmtUSD(t.USD)) + fg(th.Muted).Render(" billed"), fg(th.Text).Bold(true).Render("≈"+fmtUSD(t.ListUSD)) + fg(th.Muted).Render(" at API prices")}
	parts = append(parts, fg(th.Muted).Render(fmt.Sprintf("%s in · %s out · %s cached · %d turns", fmtTok(t.Input), fmtTok(t.Output), fmtTok(t.CacheRead), t.Turns)))
	return strings.Join(parts, fg(th.Subtle).Render("  ·  "))
}

// quotaLines are every quota window of every harness OpenUsage knows, with resets and, for this
// sitting, how far each moved.
func (r *roomModel) quotaLines(th theme.Theme, w int, now time.Time, sitting bool) []string {
	if r.meters == nil {
		return []string{fg(th.Subtle).Italic(true).Render("asking OpenUsage…")}
	}
	if r.meters.Source == "none" {
		return []string{fg(th.Subtle).Italic(true).Render(r.meters.Error)}
	}
	var out []string
	for _, h := range r.meters.Harnesses {
		for i, win := range h.Windows {
			name := ""
			if i == 0 {
				name = h.CLI
			}
			line := padRight(name, 9) + padRight(win.Label, 6) + " " + meterBar(th, win.Used, 16) + fg(th.Text).Render(fmt.Sprintf(" %3d%%", int(win.Used*100+0.5)))
			if when := untilReset(win.ResetsAt, now); when != "" {
				line += fg(th.Subtle).Render(" · resets " + when)
				if t, err := time.Parse(time.RFC3339, win.ResetsAt); err == nil {
					line += fg(th.Subtle).Render(t.Local().Format(" (Mon 15:04)"))
				}
			}
			if d, reset, ok := r.quotaMoved(h.CLI, win); ok && sitting {
				line += fg(th.Info).Render(" · " + fmtMoved(d, reset) + " this sitting")
			}
			out = append(out, ansi.Truncate(line, w, "…"))
		}
	}
	for _, b := range r.meters.Balances {
		line := padRight(b.Name, 15) + " " + fg(th.Text).Render(fmtUSD(b.RemainingUSD)) + fg(th.Muted).Render(" left")
		if b.LimitUSD != nil && *b.LimitUSD > 0 {
			line = padRight(b.Name, 15) + " " + meterBar(th, 1 - b.RemainingUSD / *b.LimitUSD, 16) + fg(th.Text).Render(" "+fmtUSD(b.RemainingUSD)) + fg(th.Muted).Render(" left of "+fmtUSD(*b.LimitUSD))
		}
		out = append(out, line)
	}
	if len(out) == 0 {
		out = append(out, fg(th.Subtle).Render("OpenUsage has no quota or balance readings yet"))
	}
	return out
}

func (a *App) usageView() string {
	u, th := a.usage, a.th
	r := a.rm.room
	w := min(a.w-4, 150)
	now := time.Now()
	var tabs []string
	for i, t := range scopeNames {
		label := fmt.Sprintf(" %d %s ", i+1, t)
		if i == u.tab {
			tabs = append(tabs, lipgloss.NewStyle().Foreground(th.Text).Background(th.Accent).Bold(true).Render(label))
		} else {
			tabs = append(tabs, fg(th.Muted).Render(label))
		}
	}
	head := []string{sectionTitle("usage & cost", w, th, true), strings.Join(tabs, " "), ""}
	body := []string{fg(th.Accent2).Bold(true).Render("Quota & balances")}
	body = append(body, r.quotaLines(th, w, now, u.tab == scopeSitting)...)
	body = append(body, "")
	s := r.scoped(u.tab)
	switch {
	case s == nil:
		body = append(body, fg(th.Muted).Italic(true).Render(a.spin.View()+" adding it up…"))
	default:
		switch u.tab {
		case scopeSitting:
			body = append(body, fg(th.Muted).Render(fmt.Sprintf("Sitting %d, since %s.", r.usage.Sitting.N, sinceLabel(r.usage.Sitting.Start, now))))
		case scopeChannel:
			body = append(body, fg(th.Muted).Render(fmt.Sprintf("%s, over %d %s.", r.channelLabel(), len(r.usage.Sittings), map[bool]string{true: "sitting", false: "sittings"}[len(r.usage.Sittings) == 1])))
		case scopeProject:
			body = append(body, fg(th.Muted).Render(fmt.Sprintf("Every channel in this project (%d).", len(s.ByChannel))))
		}
		body = append(body, totalLine(th, s.Total))
		if s.Legacy != nil {
			body = append(body, fg(th.Subtle).Render(fmt.Sprintf("includes %s from before sittings were tracked", costOf(*s.Legacy))))
		}
		body = append(body, fg(th.Subtle).Render("billed: pay-per-token harnesses (opencode, kimi). ≈ at API prices: every turn at list price, subscriptions included."), "")
		if u.tab == scopeProject {
			body = append(body, usageTable(th, w, "Channels", s.ByChannel, false)...)
		}
		var members, support []rpc.UsageLine
		for _, l := range s.ByAgent {
			if l.Role == "support" {
				support = append(support, l)
			} else {
				members = append(members, l)
			}
		}
		body = append(body, usageTable(th, w, "Members", members, true)...)
		body = append(body, usageTable(th, w, "Support roles", support, true)...)
		body = append(body, usageTable(th, w, "Models", s.ByModel, false)...)
		if u.tab == scopeChannel && len(r.usage.Sittings) > 1 {
			body = append(body, fg(th.Accent2).Bold(true).Render("Sittings"))
			for i := len(r.usage.Sittings) - 1; i >= 0; i-- {
				x := r.usage.Sittings[i]
				body = append(body, fmt.Sprintf("%3d  %-16s %9s billed %10s at API", x.N, startLabel(x.Start), fmtUSD(x.USD), "≈"+fmtUSD(x.ListUSD)))
			}
		}
	}
	rows := max(a.h-len(head)-3, 3)
	u.top = max(min(u.top, len(body)-rows), 0)
	shown := body[u.top:min(u.top+rows, len(body))]
	keys := "alt+1/2/3 or ←→ views · ↑↓ scroll · alt+r refresh · esc close"
	lines := append(append(head, shown...), "", fg(th.Subtle).Render(ansi.Truncate(keys, w, "…")))
	return lipgloss.NewStyle().Padding(1, 2).Render(strings.Join(lines, "\n"))
}

func startLabel(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ts
	}
	return t.Local().Format("Mon Jan 2 15:04")
}

// sinceLabel is when a sitting began: a clock time today, a date otherwise.
func sinceLabel(ts string, now time.Time) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ts
	}
	if t.Local().YearDay() == now.Local().YearDay() && t.Year() == now.Year() {
		return t.Local().Format("15:04")
	}
	return t.Local().Format("Mon Jan 2 15:04")
}
