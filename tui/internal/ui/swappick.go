package ui

import (
	"fmt"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// With a channel open, alt+o starts with who: a member (or support role) to move to another model,
// someone new to bring in, or just the catalog. Picking a member opens the catalog for them, and
// enter on a model moves them onto it, keeping their memory (as /swap does).

// billedHarness: harnesses that bill per token through an API key. Every other vendor CLI runs on
// its subscription, so a model there costs quota, not its list price (the engine's METERED_CLIS).
func billedHarness(h string) bool { return h == "opencode" || h == "kimi" }

// routeCost says what running a model this way costs: "billed", "credits" (a subscription model
// that draws on paid usage credits, learned when it ran out) or "quota".
func routeCost(rt rpc.Route) string {
	switch {
	case billedHarness(rt.Harness):
		return "billed"
	case rt.Billing == "credits":
		return "credits"
	}
	return "quota"
}

type swapWho struct {
	id, now string // who, and what they run on now
	held    bool   // sitting out a limit: the likeliest one to move
	support bool
	action  string // "new" (bring someone in) or "browse" (just the catalog); "" for a person
}

// whoPick is the first step of alt+o in a channel.
type whoPick struct {
	who []swapWho
	cur int
}

// openWhoPick lists who could move, held members first, then support roles, then the other choices.
func (a *App) openWhoPick() {
	r := a.rm.room
	var who []swapWho
	for _, ag := range r.agents {
		_, held := r.held[ag.ID]
		who = append(who, swapWho{id: ag.ID, now: strings.TrimSpace(ag.CLI + " " + ag.Model), held: held})
	}
	slices.SortStableFunc(who, func(x, y swapWho) int {
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
		who = append(who, swapWho{id: s.id, now: strings.TrimSpace(s.spec.CLI + " " + s.spec.Model), support: true})
	}
	who = append(who, swapWho{id: "Bring in someone new", action: "new"}, swapWho{id: "Just browse models", action: "browse"})
	a.prov.pick = &whoPick{who: who}
}

func (a *App) handleWhoPickKey(key string) tea.Cmd {
	p := a.prov
	w := p.pick
	switch key {
	case "esc", "alt+o":
		a.prov = nil
	case "up", "k":
		w.cur = (w.cur - 1 + len(w.who)) % len(w.who) // wraps, so the last choices are one key away
	case "down", "j":
		w.cur = (w.cur + 1) % len(w.who)
	case "enter":
		x := w.who[w.cur]
		p.pick = nil
		switch x.action {
		case "new":
			a.prov = nil
			a.openJoin(nil)
			return nil
		case "browse":
		default:
			p.target = &x
		}
		p.tab = tabModels
		return p.focus()
	}
	return nil
}

// swapTo moves the target onto the highlighted model; false when there's no target or no route.
func (a *App) swapTo(m *rpc.CatalogModel, rt rpc.Route) bool {
	t := a.prov.target
	if t == nil || !rt.Ready {
		return false
	}
	a.call("room.swap", map[string]any{"id": t.id, "cli": rt.Harness, "model": rt.ID})
	a.prov = nil
	a.notify(fmt.Sprintf("Moving %s to %s (%s %s); it keeps its memory.", t.id, m.Name, rt.Harness, rt.ID))
	return true
}

func renderWhoPick(w *whoPick, th theme.Theme, width int) []string {
	lines := []string{
		fg(th.Text).Bold(true).Render("Who are you changing?"),
	}
	lines = append(lines, strings.Split(fg(th.Muted).Render(ansi.Wrap("Pick a member to move to another model (it keeps its memory), or bring in someone new.", width, "")), "\n")...)
	lines = append(lines, "")
	// The names' column fits the longest name, within reason.
	nameW := 12
	for _, x := range w.who {
		if x.action == "" {
			nameW = max(nameW, lipgloss.Width(x.id)+2)
		}
	}
	nameW = min(nameW, max(width/2, 12))
	for i, x := range w.who {
		if x.action == "new" {
			lines = append(lines, "")
		}
		mark := "  "
		st := fg(th.Text)
		if i == w.cur {
			mark, st = fg(th.Accent2).Render("❯ "), fg(th.Accent2).Bold(true)
		}
		var line string
		if x.action != "" {
			line = mark + st.Render(x.id)
			if x.action == "new" {
				line += fg(th.Subtle).Render("  alt+a in the channel")
			}
		} else {
			line = mark + st.Render(fmt.Sprintf("%-*s", nameW, ansi.Truncate(x.id, nameW-1, "…"))) + fg(th.Muted).Render("now "+orDefault(x.now, "its default"))
			switch {
			case x.held:
				line += fg(th.Warn).Render("  ⏸ sitting out a limit")
			case x.support:
				line += fg(th.Subtle).Render("  support role")
			}
		}
		lines = append(lines, ansi.Truncate(line, width, "…"))
	}
	return lines
}
