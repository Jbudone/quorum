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
	limit, usd, usd2 := 30.0, 0.42, 0.08
	r := newRoom(rpc.RoomSnapshot{
		CLIs:    []string{"claude", "codex", "opencode"},
		Agents:  []rpc.PresetAgent{{ID: "skeptic", CLI: "claude"}, {ID: "critic", CLI: "codex"}, {ID: "deep", CLI: "opencode", Model: "deepseek/deepseek-v4-pro"}},
		Support: rpc.RoomSupport{Assistant: rpc.ChairSpec{CLI: "claude"}},
		Spend:   map[string]rpc.Spend{"deep": {Input: 9000, Output: 300, USD: &usd}, "assistant": {Input: 10, Output: 1}},
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
	for _, w := range []string{"claude", "47% 5h", "resets in 3h12m", "7d 80%", "codex", "43% 5h", "OpenRouter", "$14.64 left of $30", "this channel $0.42"} {
		if !strings.Contains(out, w) {
			t.Fatalf("budget lacks %q:\n%s", w, out)
		}
	}
	if strings.Contains(out, "agy") {
		t.Fatalf("shows a harness nobody here uses:\n%s", out)
	}
	// Spend arrives as members finish turns.
	r.apply(rpc.Event{Name: "room.spend", Data: rpc.RoomSpend{Agent: "deep", CLI: "opencode", Spend: rpc.Spend{Input: 1, Output: 1, USD: &usd2}}})
	if v, _ := r.channelUSD(); v != usd2 {
		t.Fatalf("channel spend %v", v)
	}
	// Without OpenUsage, say how to get it.
	r.meters = &rpc.Meters{Source: "none", Error: "install OpenUsage (openusage.sh) to see quotas and balances"}
	r.spend = map[string]rpc.Spend{}
	r.agents = []rpc.PresetAgent{{ID: "skeptic", CLI: "claude"}}
	r.support = rpc.RoomSupport{}
	if out := ansi.Strip(strings.Join(budgetLines(r, theme.Default(), 60, 4, now), "\n")); !strings.Contains(out, "install OpenUsage") {
		t.Fatalf("no hint:\n%s", out)
	}
}
