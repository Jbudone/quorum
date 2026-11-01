package ui

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// The budget column: how much quota each harness in the channel has left (from OpenUsage), money
// left on pay-per-token providers, and what the channel's members have cost so far.

const meterEvery = time.Minute

type meterTick struct{}

// pollMeters asks for fresh meters every minute while a real channel is open.
func pollMeters() tea.Cmd {
	return tea.Tick(meterEvery, func(time.Time) tea.Msg { return meterTick{} })
}

// askMeters requests the meters for the open channel; mock channels have none.
func (a *App) askMeters() {
	if a.rm == nil || a.rm.room == nil || a.opts.Mock {
		return
	}
	r := a.rm.room
	if len(r.clis) == 0 || !slices.ContainsFunc(r.clis, func(c string) bool { return c != "mock" }) {
		return
	}
	a.call("usage.meters", map[string]any{})
}

func (a *App) metersResponse(method string, res rpc.Response) bool {
	if method != "usage.meters" {
		return false
	}
	var m rpc.Meters
	if res.Err == "" && rpc.DecodeResult(res.Result, &m) == nil {
		a.meters = &m
		if a.rm != nil && a.rm.room != nil {
			a.rm.room.meters = &m
		}
	}
	return true
}

// channelHarnesses are the harnesses this channel's members and support roles run on.
func (r *roomModel) channelHarnesses() []string {
	var out []string
	add := func(c string) {
		if c != "" && c != "mock" && !slices.Contains(out, c) {
			out = append(out, c)
		}
	}
	for _, a := range r.agents {
		add(a.CLI)
	}
	for _, s := range []rpc.ChairSpec{r.support.Assistant, r.support.Chair, r.support.Scribe, r.support.Floor} {
		add(s.CLI)
	}
	return out
}

// meterBar is a little gauge of how much is used: green, then amber, then red as it fills.
func meterBar(th theme.Theme, used float64, w int) string {
	used = math.Max(0, math.Min(1, used))
	n := int(math.Round(used * float64(w)))
	c := th.OK
	switch {
	case used >= 0.9:
		c = th.Err
	case used >= 0.75:
		c = th.Warn
	}
	return fg(c).Render(strings.Repeat("▰", n)) + fg(th.Subtle).Render(strings.Repeat("▱", w-n))
}

func fmtUSD(v float64) string {
	switch {
	case v == 0:
		return "$0"
	case v < 0.01:
		return "<$0.01"
	case v < 100:
		return fmt.Sprintf("$%.2f", v)
	}
	return fmt.Sprintf("$%.0f", v)
}

// untilReset says when a window resets, briefly: "in 3h12m", "in 2d".
func untilReset(at string, now time.Time) string {
	t, err := time.Parse(time.RFC3339, at)
	if err != nil {
		return ""
	}
	d := t.Sub(now)
	switch {
	case d <= 0:
		return "resetting"
	case d < time.Hour:
		return fmt.Sprintf("in %dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("in %dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("in %dd", int(d.Hours()/24))
}

// budgetLines are the budget column: one quota line per harness in the channel, then balances and spend.
func budgetLines(r *roomModel, th theme.Theme, width, n int, now time.Time) []string {
	var lines []string
	names := r.channelHarnesses()
	nameW := 0
	for _, h := range names {
		nameW = max(nameW, lipgloss.Width(h))
	}
	byCLI := map[string]rpc.HarnessMeter{}
	if r.meters != nil {
		for _, h := range r.meters.Harnesses {
			byCLI[h.CLI] = h
		}
	}
	barW := max(min(width-nameW-22, 10), 4)
	var metered []string
	for _, h := range names {
		m, ok := byCLI[h]
		if !ok || len(m.Windows) == 0 {
			// No quota reading: the room's own figure from the last turn, if the CLI reported one.
			if q, ok := r.quota[h]; ok {
				lines = append(lines, padRight(h, nameW)+" "+meterBar(th, q, barW)+fg(th.Muted).Render(fmt.Sprintf(" %d%%", int(q*100+0.5))))
			} else {
				metered = append(metered, h)
			}
			continue
		}
		w := m.Windows[0]
		line := padRight(h, nameW) + " " + meterBar(th, w.Used, barW) + fg(th.Muted).Render(fmt.Sprintf(" %d%% %s", int(w.Used*100+0.5), w.Label))
		if when := untilReset(w.ResetsAt, now); when != "" {
			line += fg(th.Subtle).Render(" · resets " + when)
		}
		if d, reset, ok := r.quotaMoved(h, w); ok && r.scope == scopeSitting {
			line += fg(th.Info).Render(" · " + fmtMoved(d, reset))
		}
		// A longer window that's nearly spent matters more than the short one.
		for _, x := range m.Windows[1:] {
			if x.Used >= 0.75 {
				line += fg(th.Warn).Render(fmt.Sprintf(" · %s %d%%", x.Label, int(x.Used*100+0.5)))
			}
		}
		lines = append(lines, line)
	}
	// What this sitting, channel or project used: billed, and at API prices.
	if s := r.scoped(r.scope); s != nil && s.Total.Turns+s.Total.Input > 0 {
		t := s.Total
		line := fg(th.Text).Bold(true).Render(fmtUSD(t.USD)) + fg(th.Muted).Render(" billed · ") + fg(th.Text).Bold(true).Render("≈"+fmtUSD(t.ListUSD)) + fg(th.Muted).Render(" at API · "+fmtTok(t.Input+t.Output)+" tok")
		lines = append(lines, line+fg(th.Subtle).Render("  alt+v · alt+u"))
	} else if r.scope == scopeProject && r.project == nil {
		lines = append(lines, fg(th.Subtle).Italic(true).Render("adding up the project…"))
	} else if r.usage != nil {
		lines = append(lines, fg(th.Subtle).Render("nothing used "+scopeNames[r.scope]+" yet  alt+v · alt+u"))
	}
	if r.meters != nil {
		for _, b := range r.meters.Balances {
			left := fg(th.Text).Render(fmtUSD(b.RemainingUSD)) + fg(th.Muted).Render(" left")
			if b.LimitUSD != nil && *b.LimitUSD > 0 {
				left = meterBar(th, 1 - b.RemainingUSD / *b.LimitUSD, barW) + " " + left + fg(th.Muted).Render(" of "+fmtUSD(*b.LimitUSD))
			}
			lines = append(lines, fg(th.Text).Render(b.Name)+" "+left)
		}
	}
	switch {
	case r.meters != nil && r.meters.Source == "none":
		lines = append(lines, fg(th.Subtle).Italic(true).Render(r.meters.Error))
	case len(lines) == 0 && len(metered) > 0:
		lines = append(lines, fg(th.Subtle).Render(strings.Join(metered, ", ")+": no quota reading"))
	case len(lines) == 0:
		lines = append(lines, fg(th.Subtle).Italic(true).Render("quota appears after the first turns"))
	}
	if len(lines) > n {
		lines = lines[:n]
	}
	return lines
}
