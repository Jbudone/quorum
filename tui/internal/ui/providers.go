package ui

import (
	"fmt"
	"slices"
	"strings"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// The Providers & models screen (alt+o, or /models): star favourite models, put harnesses in the
// order Quorum prefers them, and set up providers: which env var holds each key (keys themselves
// are never stored), custom OpenAI-compatible endpoints, providers to hide. Saved to providers.toml.

type provTab int

const (
	tabModels provTab = iota
	tabHarnesses
	tabProviders
)

var provTabs = []string{"Models", "Harnesses", "Providers"}

type providersScreen struct {
	tab    provTab
	search *modelSearch // the Models tab
	filter textarea.Model
	cur    int
	top    int
	file   *rpc.ProvidersFile
	form   *providerForm
	err    string
}

// providerForm edits one provider, or adds a custom one.
type providerForm struct {
	isNew  bool
	custom bool
	id     string
	ins    []textarea.Model // id (new only), name, env, base url, models
	labels []string
	cur    int
	hidden bool
}

func (a *App) openProviders() {
	a.ensureCatalog()
	f := newInput(a.th, 1)
	f.Placeholder = "filter providers"
	a.prov = &providersScreen{search: a.openSearch(nil, "", ""), filter: f}
	a.call("providers.get", map[string]any{})
}

func (p *providersScreen) providers(c *rpc.Catalog) []rpc.ProviderInfo {
	if c == nil {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(p.filter.Value()))
	var out []rpc.ProviderInfo
	for _, x := range c.Providers {
		if q == "" || fuzzyScore(q, x.Name) > 0 || fuzzyScore(q, x.ID) > 0 {
			out = append(out, x)
		}
	}
	return out
}

func (a *App) harnessOrder() []rpc.HarnessInfo {
	c := a.catalog
	if c == nil {
		return nil
	}
	hs := slices.Clone(c.Harnesses)
	order := c.HarnessOrder
	if a.prov != nil && a.prov.file != nil {
		order = a.prov.file.Harnesses
	}
	slices.SortStableFunc(hs, func(x, y rpc.HarnessInfo) int { return idx(order, x.CLI) - idx(order, y.CLI) })
	return hs
}

func idx(xs []string, s string) int {
	if i := slices.Index(xs, s); i >= 0 {
		return i
	}
	return len(xs)
}

func (a *App) handleProvKey(k tea.KeyPressMsg) tea.Cmd {
	p := a.prov
	key := k.String()
	if p.form != nil {
		return a.handleProvForm(k)
	}
	switch key {
	case "esc", "alt+o":
		a.prov = nil
		return nil
	case "alt+1", "alt+2", "alt+3":
		p.tab, p.cur, p.top, p.err = provTab(key[4]-'1'), 0, 0, ""
		return p.focus()
	case "alt+right", "alt+l":
		p.tab, p.cur, p.top, p.err = (p.tab+1)%3, 0, 0, ""
		return p.focus()
	case "alt+left", "alt+h":
		p.tab, p.cur, p.top, p.err = (p.tab+2)%3, 0, 0, ""
		return p.focus()
	case "alt+r":
		a.reloadCatalog(true)
		a.notify("asking every harness for its models again…")
		return nil
	}
	switch p.tab {
	case tabModels:
		// enter stars here: this tab is for choosing favourites.
		if key == "enter" {
			if rows := p.search.build(); p.search.cur < len(rows) && rows[p.search.cur].m != nil {
				k = tea.KeyPressMsg{Code: 'f', Mod: tea.ModAlt}
			}
		}
		_, _, fav, cmd := p.search.key(k)
		a.starred(fav)
		return cmd
	case tabHarnesses:
		hs := a.harnessOrder()
		switch key {
		case "up":
			p.cur = max(p.cur-1, 0)
		case "down":
			p.cur = min(p.cur+1, max(len(hs)-1, 0))
		case "alt+up", "alt+down", "K", "J":
			if p.cur >= len(hs) {
				return nil
			}
			to := p.cur + 1
			if key == "alt+up" || key == "K" {
				to = p.cur - 1
			}
			if to < 0 || to >= len(hs) {
				return nil
			}
			order := make([]string, len(hs))
			for i, h := range hs {
				order[i] = h.CLI
			}
			order[p.cur], order[to] = order[to], order[p.cur]
			if p.file != nil {
				p.file.Harnesses = append(order, slices.DeleteFunc(slices.Clone(p.file.Harnesses), func(s string) bool { return slices.Contains(order, s) })...)
			}
			p.cur = to
			a.call("harnesses.order", map[string]any{"order": order})
		}
		return nil
	case tabProviders:
		ps := p.providers(a.catalog)
		switch key {
		case "up":
			p.cur = max(p.cur-1, 0)
			return nil
		case "down":
			p.cur = min(p.cur+1, max(len(ps)-1, 0))
			return nil
		case "enter":
			if p.cur < len(ps) {
				p.form = a.newProviderForm(&ps[p.cur])
				return p.form.focus()
			}
			return nil
		case "alt+n":
			p.form = a.newProviderForm(nil)
			return p.form.focus()
		}
		before := p.filter.Value()
		var cmd tea.Cmd
		p.filter, cmd = p.filter.Update(k)
		if p.filter.Value() != before {
			p.cur, p.top = 0, 0
		}
		return cmd
	}
	return nil
}

func (p *providersScreen) focus() tea.Cmd {
	p.filter.Blur()
	p.search.search.Blur()
	switch p.tab {
	case tabModels:
		return p.search.search.Focus()
	case tabProviders:
		return p.filter.Focus()
	}
	return nil
}

func (a *App) newProviderForm(x *rpc.ProviderInfo) *providerForm {
	f := &providerForm{isNew: x == nil, custom: x == nil || x.Custom}
	one := func(ph, v string) textarea.Model {
		in := newInput(a.th, 1)
		in.Placeholder = ph
		in.SetValue(v)
		return in
	}
	var cfg rpc.ProviderConfig
	if x != nil {
		f.id, f.hidden = x.ID, x.Hidden
		if a.prov.file != nil {
			cfg = a.prov.file.Providers[x.ID]
		}
	}
	envHint := "the env var holding the key"
	if x != nil && len(x.Env) > 0 {
		envHint = "default " + strings.Join(x.Env, " or ") + "; set one to use your own"
	}
	if f.isNew {
		f.labels = append(f.labels, "id")
		f.ins = append(f.ins, one("short id, e.g. lmstudio", ""))
	}
	f.labels = append(f.labels, "key env var")
	f.ins = append(f.ins, one(envHint, cfg.Env))
	if f.custom {
		name, url := cfg.Name, cfg.BaseURL
		if x != nil && url == "" {
			url = x.BaseURL
		}
		f.labels = append(f.labels, "name", "base url", "models")
		f.ins = append(f.ins, one("display name", name), one("an OpenAI-compatible endpoint, e.g. http://localhost:1234/v1", url), one("model ids it serves, space-separated", strings.Join(cfg.Models, " ")))
	}
	return f
}

func (f *providerForm) focus() tea.Cmd {
	for i := range f.ins {
		f.ins[i].Blur()
	}
	if f.cur < len(f.ins) {
		return f.ins[f.cur].Focus()
	}
	return nil
}

func (f *providerForm) value(label string) string {
	for i, l := range f.labels {
		if l == label {
			return strings.TrimSpace(f.ins[i].Value())
		}
	}
	return ""
}

func (a *App) handleProvForm(k tea.KeyPressMsg) tea.Cmd {
	p := a.prov
	f := p.form
	rows := len(f.ins) + 1 // the last row toggles hidden
	switch k.String() {
	case "esc":
		p.form, p.err = nil, ""
		return p.focus()
	case "tab", "down":
		f.cur = min(f.cur+1, rows-1)
		return f.focus()
	case "shift+tab", "up":
		f.cur = max(f.cur-1, 0)
		return f.focus()
	case "space", " ":
		if f.cur == rows-1 {
			f.hidden = !f.hidden
			return nil
		}
	case "alt+d":
		if !f.isNew {
			a.call("providers.set", map[string]any{"id": f.id, "remove": true})
			p.form = nil
		}
		return p.focus()
	case "enter":
		if f.cur < rows-1 {
			f.cur++
			return f.focus()
		}
		id := f.id
		if f.isNew {
			id = f.value("id")
			if id == "" || f.value("base url") == "" {
				p.err = "a custom provider needs an id and a base url"
				return nil
			}
		}
		params := map[string]any{"id": id, "env": f.value("key env var"), "hidden": f.hidden}
		if f.custom {
			params["name"], params["baseUrl"], params["models"] = f.value("name"), f.value("base url"), f.value("models")
		}
		p.err = ""
		a.call("providers.set", params)
		p.form = nil
		return p.focus()
	}
	if f.cur < len(f.ins) {
		var cmd tea.Cmd
		f.ins[f.cur], cmd = f.ins[f.cur].Update(k)
		return cmd
	}
	return nil
}

// ---- view ----

func (a *App) providersView() string {
	p := a.prov
	th := a.th
	w := min(a.w-4, 150)
	var tabs []string
	for i, t := range provTabs {
		label := fmt.Sprintf(" %d %s ", i+1, t)
		if provTab(i) == p.tab {
			tabs = append(tabs, lipgloss.NewStyle().Foreground(th.Text).Background(th.Accent).Bold(true).Render(label))
		} else {
			tabs = append(tabs, fg(th.Muted).Render(label))
		}
	}
	lines := []string{sectionTitle("providers & models", w, th, true), strings.Join(tabs, " "), ""}
	keys := "alt+1/2/3 or alt+←→ tabs · alt+r re-ask harnesses · esc close"
	c := a.catalog
	switch {
	case p.form != nil:
		lines = append(lines, a.providerFormView(w)...)
		keys = "tab next · enter save on the last row · space toggles hidden · alt+d remove your settings · esc back"
	case p.tab == tabModels:
		lines = append(lines, fg(th.Muted).Render("Star the models you reach for; they lead every model search, and the assistant sees them first."), "", p.search.view(th, w, a.spin.View()))
		keys = "type to search · enter or alt+f star · tab harness · alt+c fold · " + keys
	case p.tab == tabHarnesses:
		lines = append(lines, fg(th.Muted).Render("When a model runs on several harnesses, the first one here is picked. Vendor CLIs use their subscriptions; opencode runs any provider with a key."), "")
		if c == nil {
			lines = append(lines, fg(th.Muted).Italic(true).Render(a.spin.View()+" asking your harnesses…"))
		}
		for i, h := range a.harnessOrder() {
			mark := "  "
			name := fg(th.Text).Render(fmt.Sprintf("%-10s", h.CLI))
			if i == p.cur {
				mark, name = fg(th.Accent2).Render("❯ "), fg(th.Accent2).Bold(true).Render(fmt.Sprintf("%-10s", h.CLI))
			}
			status := fg(th.OK).Render("✓ working")
			if !h.Usable {
				status = fg(th.Err).Render("✗ " + ansi.Truncate(firstLine(h.Error), 50, "…"))
			}
			extra := fmt.Sprintf("  %d models", h.Models)
			if h.QuotaUtilization != nil {
				extra += fmt.Sprintf(" · quota %d%% used", int(*h.QuotaUtilization*100))
			}
			if h.AnyProvider {
				extra += " · any provider with a key"
			}
			lines = append(lines, ansi.Truncate(mark+fmt.Sprintf("%d ", i+1)+name+status+fg(th.Muted).Render(extra), w, "…"))
		}
		keys = "↑↓ choose · alt+↑↓ move it up or down · " + keys
	case p.tab == tabProviders:
		p.filter.SetWidth(w - 2)
		lines = append(lines, fg(th.Muted).Render("Keys stay in your environment: Quorum stores only which env var holds each one."), "", p.filter.View())
		ps := p.providers(c)
		if c == nil {
			lines = append(lines, fg(th.Muted).Italic(true).Render(a.spin.View()+" loading providers…"))
		}
		rows := max(a.h-14, 5)
		p.cur = max(0, min(p.cur, len(ps)-1))
		if p.cur < p.top {
			p.top = p.cur
		}
		if p.cur >= p.top+rows {
			p.top = p.cur - rows + 1
		}
		for i := p.top; i < len(ps) && i < p.top+rows; i++ {
			x := ps[i]
			mark := "  "
			nameSt := fg(th.Text)
			if i == p.cur {
				mark, nameSt = fg(th.Accent2).Render("❯ "), fg(th.Accent2).Bold(true)
			}
			key := fg(th.Subtle).Render("needs " + strings.Join(x.Env, " or "))
			switch {
			case x.KeySet && x.KeyVar != "":
				key = fg(th.OK).Render("✓ key in " + x.KeyVar)
			case x.KeySet:
				key = fg(th.OK).Render("✓ key set")
			case x.Runnable > 0:
				key = fg(th.OK).Render("✓ through a harness login")
			case len(x.Env) == 0:
				key = fg(th.Subtle).Render("")
			}
			tags := ""
			if x.Custom {
				tags += " custom"
			}
			if x.Hidden {
				tags += " hidden"
			}
			counts := fmt.Sprintf("%d/%d runnable", x.Runnable, x.Models)
			lines = append(lines, ansi.Truncate(mark+nameSt.Render(fmt.Sprintf("%-28s", ansi.Truncate(x.Name, 28, "…")))+fg(th.Muted).Render(fmt.Sprintf("%-16s", counts))+key+fg(th.Info).Render(tags), w, "…"))
		}
		if len(ps) > rows {
			lines = append(lines, fg(th.Subtle).Render(fmt.Sprintf("  %d–%d of %d", p.top+1, min(p.top+rows, len(ps)), len(ps))))
		}
		keys = "type to filter · ↑↓ choose · enter edit · alt+n add a custom provider · " + keys
	}
	if p.err != "" {
		lines = append(lines, "", fg(th.Err).Render("✗ "+p.err))
	}
	if c != nil && c.Source.From != "" {
		lines = append(lines, "", fg(th.Subtle).Render(ansi.Truncate("model data from "+c.Source.From, w, "…")))
	}
	body := strings.Join(lines, "\n")
	foot := a.withToast(fg(th.Subtle).Render(ansi.Truncate(keys, a.w, "")))
	bodyH := max(a.h-1, 1)
	return lipgloss.JoinVertical(lipgloss.Left, lipgloss.NewStyle().Padding(0, 2).Height(bodyH).MaxHeight(bodyH).Render(body), foot)
}

func (a *App) providerFormView(w int) []string {
	f := a.prov.form
	th := a.th
	title := "new custom provider"
	if !f.isNew {
		title = f.id
	}
	lines := []string{fg(th.Text).Bold(true).Render(title)}
	if f.custom {
		lines = append(lines, fg(th.Muted).Render("Custom providers run through opencode, which Quorum configures for each turn."))
	}
	lines = append(lines, "")
	for i, l := range f.labels {
		st := fg(th.Muted)
		if i == f.cur {
			st = fg(th.Accent2).Bold(true)
		}
		f.ins[i].SetWidth(min(w-4, 90))
		lines = append(lines, st.Render(l), f.ins[i].View(), "")
	}
	box := "[ ]"
	if f.hidden {
		box = "[x]"
	}
	st := fg(th.Text)
	if f.cur == len(f.ins) {
		st = fg(th.Accent2).Bold(true)
	}
	lines = append(lines, st.Render(box+" hide this provider from model searches"))
	return lines
}
