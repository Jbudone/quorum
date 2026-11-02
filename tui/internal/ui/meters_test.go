package ui

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

func TestBudgetColumn(t *testing.T) {
	limit := 30.0
	sitting := rpc.UsageScope{Total: rpc.Tally{Turns: 3, Input: 9000, Output: 300, USD: 0.42, ListUSD: 1.9}, ByAgent: []rpc.UsageLine{{ID: "deep", Tally: rpc.Tally{Turns: 3, USD: 0.42, ListUSD: 0.42}}}}
	channel := rpc.UsageScope{Total: rpc.Tally{Turns: 9, USD: 1.5, ListUSD: 7}, ByAgent: []rpc.UsageLine{{ID: "deep", Tally: rpc.Tally{Turns: 9, USD: 1.5}}}}
	usage := &rpc.UsageReport{Sitting: rpc.SittingScope{UsageScope: sitting, N: 2, Quota: map[string][]rpc.QuotaWindow{"claude": {{Label: "5h", Used: 0.35, ResetsAt: "2026-10-31T21:00:00.4Z"}}}}, Channel: channel}
	r := newRoom(rpc.RoomSnapshot{
		CLIs:    []string{"claude", "codex", "opencode"},
		Agents:  []rpc.PresetAgent{{ID: "skeptic", CLI: "claude"}, {ID: "critic", CLI: "codex"}, {ID: "deep", CLI: "opencode", Model: "deepseek/deepseek-v4-pro"}},
		Support: rpc.RoomSupport{Assistant: rpc.ChairSpec{CLI: "claude"}},
		Usage:   usage,
	}, true)
	r.meters = &rpc.Meters{
		Source: "openusage",
		Harnesses: []rpc.HarnessMeter{
			{CLI: "claude", Windows: []rpc.QuotaWindow{{Label: "5h", Used: 0.47, ResetsAt: "2026-10-31T21:00:00Z"}, {Label: "7d", Used: 0.8}}},
			{CLI: "codex", Windows: []rpc.QuotaWindow{{Label: "5h", Used: 0.43}}},
			{CLI: "agy", Windows: []rpc.QuotaWindow{{Label: "5h", Used: 0.1}}}, // nobody here runs on it
		},
		Balances: []rpc.Balance{{Provider: "openrouter", Name: "OpenRouter", RemainingUSD: 14.64, LimitUSD: &limit}},
	}
	now, _ := time.Parse(time.RFC3339, "2026-10-31T17:48:00Z")
	out := ansi.Strip(strings.Join(budgetLines(r, theme.Default(), 60, 6, now), "\n"))
	for _, w := range []string{"claude", "5h 47% +12%", "5h resets in 3h12m", "7d 80%", "codex", "5h 43%", "OpenRouter", "$14.64 left of $30", "$0.42 billed this sitting"} {
		if !strings.Contains(out, w) {
			t.Fatalf("budget lacks %q:\n%s", w, out)
		}
	}
	// Subscriptions show as quota, not as an API-price estimate.
	if strings.Contains(out, "at API") {
		t.Fatalf("budget shows API-price estimates:\n%s", out)
	}
	if strings.Contains(out, "agy") {
		t.Fatalf("shows a harness nobody here uses:\n%s", out)
	}
	if d, reset, _ := r.quotaMoved("claude", rpc.QuotaWindow{Label: "5h", Used: 0.1, ResetsAt: "2026-11-01T02:00:00Z"}); !reset || d != 0.1 {
		t.Fatalf("a window that rolled over: %v %v", d, reset)
	}
	if l, ok := r.agentUsage("deep"); !ok || costOf(l.Tally) != "$0.42" {
		t.Fatalf("member usage %+v", l)
	}
	// alt+v: the whole channel, where quota movement no longer applies.
	r.scope = scopeChannel
	out = ansi.Strip(strings.Join(budgetLines(r, theme.Default(), 60, 6, now), "\n"))
	if !strings.Contains(out, "$1.50 billed") || strings.Contains(out, "+12%") {
		t.Fatalf("channel view:\n%s", out)
	}
	// Usage arrives as members finish turns.
	next := *usage
	next.Channel.Total.USD = 2
	r.apply(rpc.Event{Name: "room.spend", Data: rpc.RoomSpend{Agent: "deep", CLI: "opencode", Usage: next}})
	if r.usage.Channel.Total.USD != 2 {
		t.Fatalf("channel usage %+v", r.usage.Channel.Total)
	}
	r.scope = scopeProject
	if out := ansi.Strip(strings.Join(budgetLines(r, theme.Default(), 60, 6, now), "\n")); !strings.Contains(out, "adding up the project") {
		t.Fatalf("project view before it's known:\n%s", out)
	}
	// Without OpenUsage, say how to get it.
	r.meters = &rpc.Meters{Source: "none", Error: "install OpenUsage (openusage.sh) to see quotas and balances"}
	r.usage = nil
	r.agents = []rpc.PresetAgent{{ID: "skeptic", CLI: "claude"}}
	r.support = rpc.RoomSupport{}
	if out := ansi.Strip(strings.Join(budgetLines(r, theme.Default(), 60, 4, now), "\n")); !strings.Contains(out, "install OpenUsage") {
		t.Fatalf("no hint:\n%s", out)
	}
}

func TestUsageScreen(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("alt+u")
	if c := h.expectCall("usage.report"); c.params["project"] != true {
		t.Fatalf("report params %v", c.params)
	}
	h.reply("usage.report", `{
	  "sitting": {"n": 2, "start": "2026-10-31T17:00:00Z", "total": {"turns": 4, "input": 12000, "output": 900, "usd": 0.3, "listUsd": 2.1},
	    "byAgent": [{"id": "skeptic", "role": "member", "cli": "codex", "model": "gpt-6-astra", "turns": 3, "input": 9000, "output": 800, "listUsd": 1.8},
	                {"id": "floor", "role": "support", "cli": "opencode", "model": "deepseek/deepseek-v4-flash", "turns": 1, "input": 3000, "output": 100, "usd": 0.3, "listUsd": 0.3}],
	    "byModel": [{"id": "codex gpt-6-astra", "turns": 3, "listUsd": 1.8}]},
	  "channel": {"total": {"turns": 20, "usd": 1.1, "listUsd": 9}, "legacy": {"turns": 0, "usd": 0.5}, "byAgent": [], "byModel": []},
	  "sittings": [{"n": 1, "start": "2026-10-30T22:00:00Z", "usd": 0.8, "listUsd": 6.9}, {"n": 2, "start": "2026-10-31T17:00:00Z", "usd": 0.3, "listUsd": 2.1}],
	  "project": {"total": {"turns": 50, "usd": 4, "listUsd": 30}, "byAgent": [], "byModel": [], "byChannel": [{"id": "loom", "turns": 30, "usd": 2.9, "listUsd": 21}]}
	}`)
	s := h.screen()
	for _, w := range []string{"USAGE & COST", "Sitting 2", "$0.30 billed", "≈$2.10 at API prices", "Members", "skeptic", "codex gpt-6-astra", "Support roles", "floor", "Models"} {
		contains(t, s, w)
	}
	h.press("alt+2")
	s = h.screen()
	contains(t, s, "from before sittings were tracked")
	contains(t, s, "Sittings")
	h.press("alt+3")
	contains(t, h.screen(), "loom")
	h.press("esc")
	lacks(t, h.screen(), "USAGE & COST")
	// alt+v cycles the budget column.
	h.press("alt+v")
	contains(t, h.screen(), "BUDGET · THIS CHANNEL")
}

func TestSubscriptionMembersShowQuotaNotDollars(t *testing.T) {
	sitting := rpc.UsageScope{ByAgent: []rpc.UsageLine{
		{ID: "ideas", CLI: "claude", Tally: rpc.Tally{Turns: 4, Input: 90000, ListUSD: 15.69}},
		{ID: "assistant", CLI: "claude", Role: "support", Tally: rpc.Tally{Turns: 9, Input: 30000, ListUSD: 5.23}},
		{ID: "deep", CLI: "opencode", Tally: rpc.Tally{Turns: 3, USD: 0.42, ListUSD: 0.42}},
	}}
	usage := &rpc.UsageReport{Sitting: rpc.SittingScope{UsageScope: sitting, Quota: map[string][]rpc.QuotaWindow{"claude": {{Label: "5h", Used: 0.13, ResetsAt: "2026-11-02T22:00:00Z"}, {Label: "7d", Used: 0.10}}}}, Channel: sitting}
	r := newRoom(rpc.RoomSnapshot{CLIs: []string{"claude", "opencode"}, Agents: []rpc.PresetAgent{{ID: "ideas", CLI: "claude"}, {ID: "deep", CLI: "opencode"}}, Usage: usage}, true)
	// The latest turn reported both windows: they win over a polled reading, and the sitting moved 5h by 12 points.
	q := 0.25
	r.apply(rpc.Event{Name: "room.usage", Data: rpc.RoomUsage{Agent: "ideas", CLI: "claude", QuotaUtilization: &q, Windows: []rpc.QuotaWindow{{Label: "5h", Used: 0.25, ResetsAt: "2026-11-02T22:00:00Z"}, {Label: "7d", Used: 0.11}}}})
	now, _ := time.Parse(time.RFC3339, "2026-11-02T19:00:00Z")
	out := ansi.Strip(strings.Join(budgetLines(r, theme.Default(), 70, 6, now), "\n"))
	for _, w := range []string{"5h 25% +12%", "7d 11% +1%", "5h resets in 3h00m"} {
		if !strings.Contains(out, w) {
			t.Fatalf("budget lacks %q:\n%s", w, out)
		}
	}
	// ideas used three quarters of claude's API-price weight this sitting: about 9 of the 12 points.
	if s, ok := r.quotaShare("ideas", "claude"); !ok || s != "≈9% 5h" {
		t.Fatalf("quota share %q %v", s, ok)
	}
	if _, ok := r.quotaShare("deep", "opencode"); ok {
		t.Fatal("a billed member has no quota share")
	}
}
