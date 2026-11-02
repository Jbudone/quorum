package ui

import (
	"fmt"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// From the model catalog (alt+o) with a channel open, enter on a model asks who should run on it:
// a member (it keeps its memory, as with /swap) or a support role. This is how a member is moved to
// another model, e.g. off one that ran out of credits; adding someone new is alt+a.

// billedHarness: harnesses that bill per token through an API key. Every other vendor CLI runs on
// its subscription, so a model there costs quota, not its list price (the engine's METERED_CLIS).
func billedHarness(h string) bool { return h == "opencode" || h == "kimi" }

type swapPick struct {
	name, cli, model string // the model picked, and the harness it will run on
	who              []swapWho
	cur              int
}

type swapWho struct {
	id, now string // who, and what they run on now
	held    bool   // sitting out a limit: the likeliest one to move
	support bool
}

// openSwapPick starts choosing who runs on the highlighted model; false when there's nothing to swap.
func (a *App) openSwapPick(m *rpc.CatalogModel, rt rpc.Route) bool {
	if a.rm == nil || a.rm.room == nil || a.rm.setup != nil || !rt.Ready {
		return false
	}
	r := a.rm.room
	p := &swapPick{name: m.Name, cli: rt.Harness, model: rt.ID}
	for _, ag := range r.agents {
		_, held := r.held[ag.ID]
		p.who = append(p.who, swapWho{id: ag.ID, now: strings.TrimSpace(ag.CLI + " " + ag.Model), held: held})
	}
	// Who's sitting out comes first: that's usually why you're here.
	slices.SortStableFunc(p.who, func(x, y swapWho) int {
		switch {
		case x.held && !y.held:
			return -1
		case y.held && !x.held:
			return 1
		}
		return 0
	})
	for _, s := range []struct {
		id   string
		spec rpc.ChairSpec
	}{{"assistant", r.support.Assistant}, {"chair", r.support.Chair}, {"scribe", r.support.Scribe}, {"floor", r.support.Floor}} {
		p.who = append(p.who, swapWho{id: s.id, now: strings.TrimSpace(s.spec.CLI + " " + s.spec.Model), support: true})
	}
	a.prov.use = p
	return true
}

func (a *App) handleSwapPickKey(key string) tea.Cmd {
	p := a.prov.use
	switch key {
	case "esc":
		a.prov.use = nil
	case "up", "k":
		p.cur = max(p.cur-1, 0)
	case "down", "j":
		p.cur = min(p.cur+1, len(p.who)-1)
	case "enter":
		w := p.who[p.cur]
		a.call("room.swap", map[string]any{"id": w.id, "cli": p.cli, "model": p.model})
		a.prov = nil
		a.notify(fmt.Sprintf("Moving %s to %s %s; it keeps its memory.", w.id, p.cli, p.model))
	}
	return nil
}

func renderSwapPick(p *swapPick, th theme.Theme, w int) []string {
	cost := "billed per token"
	if !billedHarness(p.cli) {
		cost = "from your " + p.cli + " subscription's quota"
	}
	lines := []string{
		fg(th.Text).Bold(true).Render("Who should run on "+p.name+"?") + fg(th.Muted).Render("  "+p.cli+" "+p.model+" · "+cost),
		fg(th.Muted).Render("A member keeps its memory and picks up where it left off. To bring in someone new, use alt+a in the channel."),
		"",
	}
	for i, x := range p.who {
		mark := "  "
		st := fg(th.Text)
		if i == p.cur {
			mark, st = fg(th.Accent2).Render("❯ "), fg(th.Accent2).Bold(true)
		}
		tag := ""
		switch {
		case x.held:
			tag = fg(th.Warn).Render("  ⏸ sitting out a limit")
		case x.support:
			tag = fg(th.Subtle).Render("  support role")
		}
		lines = append(lines, ansi.Truncate(mark+st.Render(fmt.Sprintf("%-20s", x.id))+fg(th.Muted).Render("now "+orDefault(x.now, "its default"))+tag, w, "…"))
	}
	return lines
}
