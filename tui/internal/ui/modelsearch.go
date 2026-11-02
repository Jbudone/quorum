package ui

import (
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// modelSearch finds a model across every provider and harness (the engine's catalog), model first:
// pick a model and the harness that runs it is chosen for you; tab switches to another. Typing
// fuzzy-matches names, ids and providers; filter words narrow it (see searchHelp). Results are
// grouped by provider, runnable first; favourites and recent picks lead when the search is empty.
type modelSearch struct {
	cat       func() *rpc.Catalog
	allowed   []string // harnesses this channel runs on; empty means any
	search    textarea.Model
	cur       int
	top       int
	collapsed map[string]bool // provider groups the human folded or opened
	route     map[string]int  // the route picked for each model (tab cycles)
	typedAt   int             // which harness a typed id runs on
	favs      map[string]bool // stars toggled here, until the catalog reloads
	note      string          // why the last enter didn't pick
	rows      []searchRow
	cacheKey  string
	start     struct{ harness, model string }
	placed    bool
}

type searchRow struct {
	header    string // a group header; m is nil
	group     string
	count     int
	dim       bool
	m         *rpc.CatalogModel
	harness   string // a harness default, or what a typed id runs on
	typed     string
	isDefault bool
}

// modelPick is what the search returns: the harness, the id its --model flag takes ("" for its
// default), and the catalog key (for favourites and recents).
type modelPick struct{ harness, model, key string }

const searchHelp = "filters: provider:x  via:harness  free  fav  ready  reasoning  tools  vision  open  ctx>200k  $<3"

func newModelSearch(th theme.Theme, cat func() *rpc.Catalog, allowed []string, harness, model string) *modelSearch {
	in := newInput(th, 1)
	in.Placeholder = "search models, e.g. opus, kimi via:opencode, free ctx>200k"
	in.Focus()
	s := &modelSearch{cat: cat, allowed: allowed, search: in, collapsed: map[string]bool{}, route: map[string]int{}, favs: map[string]bool{}}
	s.start.harness, s.start.model = harness, model
	return s
}

// ---- query ----

type searchQuery struct {
	words                                                  []string
	provider, via                                          string
	free, fav, ready, reasoning, tools, vision, openWeight bool
	minCtx                                                 int
	maxCost                                                float64
}

func (q searchQuery) filtered() bool {
	return q.provider != "" || q.via != "" || q.free || q.fav || q.ready || q.reasoning || q.tools || q.vision || q.openWeight || q.minCtx > 0 || q.maxCost > 0
}

func parseQuery(s string) searchQuery {
	var q searchQuery
	for _, w := range strings.Fields(strings.ToLower(s)) {
		key, val, has := strings.Cut(w, ":")
		switch {
		case has && (key == "provider" || key == "p"):
			q.provider = val
		case has && (key == "via" || key == "harness" || key == "h"):
			q.via = val
		case w == "free":
			q.free = true
		case w == "fav" || w == "★" || w == "favs":
			q.fav = true
		case w == "ready" || w == "runnable":
			q.ready = true
		case w == "reasoning" || w == "thinking":
			q.reasoning = true
		case w == "tools":
			q.tools = true
		case w == "vision" || w == "images":
			q.vision = true
		case w == "open" || w == "open-weights":
			q.openWeight = true
		case strings.HasPrefix(w, "ctx>"):
			q.minCtx = parseTokens(strings.TrimLeft(w[4:], "="))
		case strings.HasPrefix(w, "$<") || strings.HasPrefix(w, "cost<"):
			v := strings.TrimLeft(strings.TrimPrefix(strings.TrimPrefix(w, "$<"), "cost<"), "=")
			q.maxCost, _ = strconv.ParseFloat(v, 64)
		default:
			q.words = append(q.words, w)
		}
	}
	return q
}

// parseTokens reads "200k", "1m", "128000".
func parseTokens(s string) int {
	mult := 1.0
	switch {
	case strings.HasSuffix(s, "k"):
		mult, s = 1e3, s[:len(s)-1]
	case strings.HasSuffix(s, "m"):
		mult, s = 1e6, s[:len(s)-1]
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return int(f * mult)
}

// squash drops everything but letters and digits, so "opus5" finds "claude-opus-5-5".
func squash(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// fuzzyScore ranks how well a term matches a field: a word-start substring best, any substring
// next, letters in order last; 0 when it doesn't match.
func fuzzyScore(term, field string) int {
	f := strings.ToLower(field)
	if i := strings.Index(f, term); i >= 0 {
		sc := 100 - min(i, 40)
		if i == 0 || !unicode.IsLetter(rune(f[i-1])) && !unicode.IsDigit(rune(f[i-1])) {
			sc += 40
		}
		if len(f) == len(term) {
			sc += 40
		}
		return sc
	}
	t, fs := squash(term), squash(field)
	if t == "" {
		return 0
	}
	if i := strings.Index(fs, t); i >= 0 {
		return 70 - min(i, 30)
	}
	ti, gaps, last := 0, 0, -1
	for i := 0; i < len(fs) && ti < len(t); i++ {
		if fs[i] == t[ti] {
			if last >= 0 {
				gaps += i - last - 1
			}
			last, ti = i, ti+1
		}
	}
	// Letters scattered across a long id aren't a match; a typo or two in a short run is.
	if ti < len(t) || gaps > 2*len(t) {
		return 0
	}
	return max(1, 35-gaps)
}

// ---- rows ----

func (s *modelSearch) routes(m *rpc.CatalogModel) []rpc.Route {
	if len(s.allowed) == 0 {
		return m.Routes
	}
	var out []rpc.Route
	for _, r := range m.Routes {
		if slices.Contains(s.allowed, r.Harness) {
			out = append(out, r)
		}
	}
	return out
}

func (s *modelSearch) runnable(m *rpc.CatalogModel) bool {
	for _, r := range s.routes(m) {
		if r.Ready {
			return true
		}
	}
	return false
}

func (s *modelSearch) fav(m *rpc.CatalogModel) bool {
	if v, ok := s.favs[m.Key]; ok {
		return v
	}
	return m.Favourite
}

// matches scores a model against the query. strong means every word matched as a run of letters,
// not just letters in order; when anything matches strongly, the loose matches are left out.
func (s *modelSearch) matches(m *rpc.CatalogModel, q searchQuery) (score int, ok, strong bool) {
	rs := s.routes(m)
	if len(rs) == 0 {
		return 0, false, false
	}
	switch {
	case q.provider != "" && !strings.Contains(strings.ToLower(m.Provider+" "+m.ProviderName), q.provider):
		return 0, false, false
	case q.via != "" && !slices.ContainsFunc(rs, func(r rpc.Route) bool { return strings.HasPrefix(r.Harness, q.via) }):
		return 0, false, false
	case q.free && (m.Cost == nil || m.Cost.Input > 0 || m.Cost.Output > 0) && !strings.Contains(m.Model, "free"):
		return 0, false, false
	case q.fav && !s.fav(m), q.ready && !s.runnable(m), q.reasoning && !m.Reasoning, q.tools && !m.Tools, q.vision && !m.Vision, q.openWeight && !m.OpenWeights:
		return 0, false, false
	case q.minCtx > 0 && m.Context < q.minCtx:
		return 0, false, false
	case q.maxCost > 0 && (m.Cost == nil || m.Cost.Input > q.maxCost):
		return 0, false, false
	}
	strong = true
	for _, w := range q.words {
		best := 0
		for _, f := range []string{m.Name, m.Model, m.Key, m.ProviderName, m.Family} {
			if f != "" {
				best = max(best, fuzzyScore(w, f))
			}
		}
		if best == 0 {
			return 0, false, false
		}
		strong = strong && best > 35
		score += best
	}
	if s.runnable(m) {
		score += 30
	}
	if s.fav(m) {
		score += 20
	}
	if m.LastUsed > 0 {
		score += 10
	}
	return score, true, strong
}

// build lays out the rows for the current query.
func (s *modelSearch) build() []searchRow {
	c := s.cat()
	text := strings.TrimSpace(s.search.Value())
	key := fmt.Sprintf("%p|%s|%v|%v", c, text, s.collapsed, s.favs)
	if key == s.cacheKey && s.rows != nil {
		return s.rows
	}
	s.cacheKey = key
	q := parseQuery(text)
	var rows []searchRow
	harnesses := s.harnessList()
	if c == nil {
		s.rows = nil
		return nil
	}
	type scored struct {
		m     *rpc.CatalogModel
		score int
	}
	byProvider := map[string][]scored{}
	var order []string
	var favs, recent []*rpc.CatalogModel
	anyStrong := false
	for i := range c.Models {
		if _, ok, strong := s.matches(&c.Models[i], q); ok && strong {
			anyStrong = true
			break
		}
	}
	for i := range c.Models {
		m := &c.Models[i]
		sc, ok, strong := s.matches(m, q)
		if !ok || anyStrong && !strong {
			continue
		}
		if _, seen := byProvider[m.Provider]; !seen {
			order = append(order, m.Provider)
		}
		byProvider[m.Provider] = append(byProvider[m.Provider], scored{m, sc})
		if s.fav(m) {
			favs = append(favs, m)
		} else if m.LastUsed > 0 {
			recent = append(recent, m)
		}
	}
	searching := len(q.words) > 0 || q.filtered()
	if !searching {
		if len(favs) > 0 {
			rows = append(rows, searchRow{header: "★ Favourites", group: "★", count: len(favs)})
			if !s.collapsed["★"] {
				for _, m := range favs {
					rows = append(rows, searchRow{m: m, group: "★"})
				}
			}
		}
		sort.SliceStable(recent, func(i, j int) bool { return recent[i].LastUsed > recent[j].LastUsed })
		if len(recent) > 8 {
			recent = recent[:8]
		}
		if len(recent) > 0 {
			rows = append(rows, searchRow{header: "Recent", group: "recent", count: len(recent)})
			if !s.collapsed["recent"] {
				for _, m := range recent {
					rows = append(rows, searchRow{m: m, group: "recent"})
				}
			}
		}
		rows = append(rows, searchRow{header: "Harness defaults", group: "defaults", count: len(harnesses)})
		if !s.collapsed["defaults"] {
			for _, h := range harnesses {
				rows = append(rows, searchRow{harness: h, isDefault: true, group: "defaults"})
			}
		}
	}
	best := func(p string) int {
		b := 0
		for _, x := range byProvider[p] {
			b = max(b, x.score)
		}
		return b
	}
	anyRunnable := func(p string) bool {
		for _, x := range byProvider[p] {
			if s.runnable(x.m) {
				return true
			}
		}
		return false
	}
	runnableCount := map[string]bool{}
	for _, p := range order {
		runnableCount[p] = anyRunnable(p)
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := order[i], order[j]
		if runnableCount[a] != runnableCount[b] {
			return runnableCount[a]
		}
		if searching {
			return best(a) > best(b)
		}
		return false // the engine's order: providers with runnable models, then by name
	})
	for _, p := range order {
		ms := byProvider[p]
		if searching {
			sort.SliceStable(ms, func(i, j int) bool { return ms[i].score > ms[j].score })
		}
		dim := !runnableCount[p]
		// With nothing typed, providers you can't run yet start folded; typing opens them.
		folded, set := s.collapsed[p]
		if !set {
			folded = dim && !searching
		}
		rows = append(rows, searchRow{header: ms[0].m.ProviderName, group: p, count: len(ms), dim: dim})
		if folded {
			continue
		}
		for _, x := range ms {
			rows = append(rows, searchRow{m: x.m, group: p, dim: !s.runnable(x.m)})
		}
	}
	// Any id typed can be used as-is, for models the catalog doesn't list.
	if len(q.words) == 1 && !q.filtered() && len(harnesses) > 0 {
		exact := false
		for _, r := range rows {
			if r.m != nil {
				for _, rt := range s.routes(r.m) {
					exact = exact || strings.EqualFold(rt.ID, text)
				}
			}
		}
		if !exact {
			rows = append(rows, searchRow{header: "Use as typed", group: "typed", count: 1}, searchRow{typed: text, harness: harnesses[s.typedAt%len(harnesses)], group: "typed"})
		}
	}
	s.rows = rows
	return rows
}

// harnessList is the harnesses a typed id or a default can run on: the channel's, in the human's order.
func (s *modelSearch) harnessList() []string {
	var out []string
	if c := s.cat(); c != nil {
		for _, h := range c.Harnesses {
			if h.Usable && (len(s.allowed) == 0 || slices.Contains(s.allowed, h.CLI)) {
				out = append(out, h.CLI)
			}
		}
	}
	for _, h := range s.allowed {
		if !slices.Contains(out, h) {
			out = append(out, h)
		}
	}
	return out
}

// placeStart puts the cursor on the model being changed once the catalog is there, or else on
// the first model.
func (s *modelSearch) placeStart() {
	if s.placed || s.cat() == nil {
		return
	}
	s.placed = true
	if s.start.harness == "" {
		if rows := s.build(); len(rows) > 1 && rows[0].header != "" {
			s.cur = 1
		}
		return
	}
	h, id := s.start.harness, s.start.model
	s.start.harness = ""
	for i, r := range s.build() {
		if r.isDefault && id == "" && r.harness == h {
			s.cur = i
			return
		}
		if r.m == nil {
			continue
		}
		for j, rt := range s.routes(r.m) {
			if rt.Harness == h && rt.ID == id {
				s.cur, s.route[r.m.Key] = i, j
				return
			}
		}
	}
	// Not shown (a folded provider): search for it instead.
	if id != "" {
		s.search.SetValue(id)
		s.cur = 0
	}
}

func (s *modelSearch) chosen(m *rpc.CatalogModel) (rpc.Route, bool) {
	rs := s.routes(m)
	if len(rs) == 0 {
		return rpc.Route{}, false
	}
	return rs[s.routeIx(m, rs)], true
}

// routeIx is the route picked for a model: the human's tab choice, else the harness named with
// via:, else the preferred one.
func (s *modelSearch) routeIx(m *rpc.CatalogModel, rs []rpc.Route) int {
	if i, ok := s.route[m.Key]; ok {
		return i % len(rs)
	}
	if via := parseQuery(s.search.Value()).via; via != "" {
		for i, r := range rs {
			if strings.HasPrefix(r.Harness, via) {
				return i
			}
		}
	}
	return 0
}

// ---- keys ----

// key handles a key press; done reports a pick. fav is set when the human starred or unstarred a model.
func (s *modelSearch) key(k tea.KeyPressMsg) (pick modelPick, done bool, fav *modelPick, cmd tea.Cmd) {
	s.placeStart()
	rows := s.build()
	s.note = ""
	clamp := func() { s.cur = max(0, min(s.cur, len(rows)-1)) }
	switch k.String() {
	case "up":
		s.cur--
		clamp()
		return
	case "down":
		s.cur++
		clamp()
		return
	case "pgup":
		s.cur -= searchRows - 1
		clamp()
		return
	case "pgdown":
		s.cur += searchRows - 1
		clamp()
		return
	case "alt+up", "alt+down":
		step := 1
		if k.String() == "alt+up" {
			step = -1
		}
		for i := s.cur + step; i >= 0 && i < len(rows); i += step {
			if rows[i].header != "" {
				s.cur = i
				break
			}
		}
		return
	case "tab", "shift+tab":
		if s.cur >= len(rows) {
			return
		}
		step := 1
		if k.String() == "shift+tab" {
			step = -1
		}
		r := rows[s.cur]
		switch {
		case r.m != nil:
			if rs := s.routes(r.m); len(rs) > 0 {
				s.route[r.m.Key] = (s.routeIx(r.m, rs) + step + len(rs)) % len(rs)
			}
		case r.typed != "":
			if n := len(s.harnessList()); n > 0 {
				s.typedAt = (s.typedAt + step + n) % n
				s.rows = nil
			}
		}
		return
	case "alt+c":
		if s.cur < len(rows) {
			g := rows[s.cur].group
			s.collapsed[g] = !s.groupFolded(g, rows)
			s.rows = nil
			// Keep the cursor on the group's header.
			for i, r := range s.build() {
				if r.header != "" && r.group == g {
					s.cur = i
				}
			}
		}
		return
	case "alt+f":
		if s.cur < len(rows) && rows[s.cur].m != nil {
			m := rows[s.cur].m
			on := !s.fav(m)
			s.favs[m.Key] = on
			s.rows = nil
			key := m.Key
			if !on {
				key = "-" + key
			}
			fav = &modelPick{key: key}
		}
		return
	case "enter":
		if s.cur >= len(rows) {
			return
		}
		r := rows[s.cur]
		switch {
		case r.header != "":
			s.collapsed[r.group] = !s.groupFolded(r.group, rows)
			s.rows = nil
		case r.isDefault:
			id, m := s.harnessDefault(r.harness)
			p := modelPick{harness: r.harness, model: id}
			if m != nil {
				p.key = m.Key
			}
			return p, true, nil, nil
		case r.typed != "":
			return modelPick{harness: r.harness, model: r.typed}, true, nil, nil
		case r.m != nil:
			rt, ok := s.chosen(r.m)
			if !ok {
				return
			}
			if !rt.Ready {
				s.note = fmt.Sprintf("%s can't run this yet: %s (alt+o sets up providers)", rt.Harness, rt.Needs)
				return
			}
			return modelPick{harness: rt.Harness, model: rt.ID, key: r.m.Key}, true, nil, nil
		}
		return
	}
	before := s.search.Value()
	s.search, cmd = s.search.Update(k)
	if s.search.Value() != before {
		s.cur, s.top, s.rows = 0, 0, nil
		// Skip the first header so enter picks the best match.
		if rs := s.build(); len(rs) > 1 && rs[0].header != "" && strings.TrimSpace(s.search.Value()) != "" {
			s.cur = 1
		}
	}
	return
}

func (s *modelSearch) groupFolded(g string, rows []searchRow) bool {
	for _, r := range rows {
		if r.group == g && r.header == "" {
			return false
		}
	}
	return true
}

// ---- view ----

const searchRows = 14

func fmtCtx(n int) string {
	switch {
	case n <= 0:
		return ""
	case n >= 1_000_000:
		return strings.TrimSuffix(fmt.Sprintf("%.1f", float64(n)/1e6), ".0") + "M"
	default:
		return fmt.Sprintf("%dk", (n+500)/1000)
	}
}

func fmtPrice(c *rpc.Cost) string {
	if c == nil {
		return ""
	}
	if c.Input == 0 && c.Output == 0 {
		return "free"
	}
	f := func(x float64) string { return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.2f", x), "0"), ".") }
	return "$" + f(c.Input) + "/$" + f(c.Output)
}

func badges(m *rpc.CatalogModel) string {
	b := ""
	if m.Reasoning {
		b += "R"
	}
	if m.Tools {
		b += "T"
	}
	if m.Vision {
		b += "V"
	}
	if m.OpenWeights {
		b += "O"
	}
	return b
}

func (s *modelSearch) view(th theme.Theme, width int, spin string) string {
	s.placeStart()
	detailW := 0
	if width >= 100 {
		detailW = 36
	}
	listW := width - detailW
	if detailW > 0 {
		listW -= 2
	}
	s.search.SetWidth(listW - 2)
	c := s.cat()
	head := []string{s.search.View()}
	if c == nil {
		head = append(head, "", fg(th.Muted).Italic(true).Render(spin+" gathering models from your harnesses and providers…"))
		return strings.Join(head, "\n")
	}
	rows := s.build()
	s.cur = max(0, min(s.cur, len(rows)-1))
	if s.cur < s.top {
		s.top = s.cur
	}
	if s.cur >= s.top+searchRows {
		s.top = s.cur - searchRows + 1
	}
	var list []string
	for i := s.top; i < len(rows) && i < s.top+searchRows; i++ {
		list = append(list, s.renderRow(rows[i], i == s.cur, th, listW))
	}
	if len(rows) == 0 {
		list = append(list, fg(th.Muted).Italic(true).Render("  nothing matches; try fewer words or filters"))
	}
	for len(list) < searchRows {
		list = append(list, "")
	}
	models := 0
	for _, r := range rows {
		if r.m != nil {
			models++
		}
	}
	status := fmt.Sprintf("%d models", models)
	if len(rows) > searchRows {
		status += fmt.Sprintf(" · %d–%d of %d rows", s.top+1, min(s.top+searchRows, len(rows)), len(rows))
	}
	foot := fg(th.Subtle).Render(ansi.Truncate(status+" · "+searchHelp, listW, "…"))
	if s.note != "" {
		foot = fg(th.Warn).Render(ansi.Truncate(s.note, listW, "…"))
	}
	left := strings.Join(append(append(head, list...), foot), "\n")
	if detailW == 0 {
		if line := s.routeLine(th, listW); line != "" {
			left += "\n" + line
		}
		return left
	}
	detail := lipgloss.NewStyle().Width(detailW).Render(s.renderDetail(th, detailW))
	return lipgloss.JoinHorizontal(lipgloss.Top, left, "  ", detail)
}

func (s *modelSearch) renderRow(r searchRow, on bool, th theme.Theme, w int) string {
	mark := "  "
	if on {
		mark = fg(th.Accent2).Render("❯ ")
	}
	switch {
	case r.header != "":
		fold := "▾"
		if s.groupFolded(r.group, s.rows) {
			fold = "▸"
		}
		st := fg(th.Accent).Bold(true)
		if r.dim {
			st = fg(th.Muted)
		}
		label := fmt.Sprintf("%s %s", fold, r.header)
		count := fg(th.Subtle).Render(fmt.Sprintf(" %d", r.count))
		if r.dim {
			count += fg(th.Subtle).Render(" · needs a key")
		}
		return ansi.Truncate(mark+st.Render(label)+count, w, "…")
	case r.isDefault:
		id, m := s.harnessDefault(r.harness)
		if id == "" {
			return ansi.Truncate(mark+"  "+fg(th.Text).Render(r.harness)+fg(th.Subtle).Render("  its own default model"), w, "…")
		}
		if m != nil {
			id = m.Name
		}
		return ansi.Truncate(mark+"  "+fg(th.Text).Render(r.harness+"  "+id)+fg(th.Subtle).Render("  its default"), w, "…")
	case r.typed != "":
		return ansi.Truncate(mark+"  "+fg(th.Text).Render("“"+r.typed+"”")+fg(th.Subtle).Render("  on "+r.harness+" · tab another harness"), w, "…")
	}
	m := r.m
	star := "  "
	if s.fav(m) {
		star = fg(th.Warn).Render("★ ")
	}
	price := fmtPrice(m.Cost)
	harness := ""
	if rt, ok := s.chosen(m); ok {
		harness = rt.Harness
		if !rt.Ready {
			harness = rt.Needs
		} else if routeCost(rt) == "quota" {
			price = "quota" // runs on a subscription: it costs quota, not its list price
		} else if routeCost(rt) == "credits" {
			price = "credits " + price
		}
	}
	cols := []string{fmtCtx(m.Context), price, badges(m)}
	widths := []int{6, 12, 5}
	right := ""
	if w >= 70 {
		for i, cv := range cols {
			right += fmt.Sprintf(" %*s", widths[i], cv)
		}
	}
	hw := min(16, max(w/5, 8))
	right += " " + ansi.Truncate(fmt.Sprintf("%-*s", hw, harness), hw, "…")
	nameW := max(w-2-2-lipgloss.Width(right), 8)
	name := ansi.Truncate(m.Name, nameW, "…")
	pad := strings.Repeat(" ", max(nameW-lipgloss.Width(name), 0))
	nameSt, restSt := fg(th.Text), fg(th.Muted)
	switch {
	case on:
		nameSt = fg(th.Accent2).Bold(true)
	case r.dim:
		nameSt, restSt = fg(th.Subtle), fg(th.Subtle)
	}
	return mark + star + nameSt.Render(name) + pad + restSt.Render(right)
}

// routeLine is the narrow-screen stand-in for the detail pane: where the highlighted model would run.
func (s *modelSearch) routeLine(th theme.Theme, w int) string {
	if s.cur >= len(s.rows) || s.rows[s.cur].m == nil {
		return ""
	}
	m := s.rows[s.cur].m
	rt, ok := s.chosen(m)
	if !ok {
		return ""
	}
	n := len(s.routes(m))
	line := fmt.Sprintf("runs on %s %s", rt.Harness, rt.ID)
	if rt.Label != "" {
		line += " (" + rt.Label + ")"
	}
	if n > 1 {
		line += fmt.Sprintf(" · tab: %d other ways", n-1)
	}
	return fg(th.Info).Render(ansi.Truncate(line, w, "…"))
}

func (s *modelSearch) renderDetail(th theme.Theme, w int) string {
	if s.cur >= len(s.rows) {
		return ""
	}
	r := s.rows[s.cur]
	if r.m == nil {
		switch {
		case r.isDefault:
			id, _ := s.harnessDefault(r.harness)
			if id == "" {
				return fg(th.Text).Bold(true).Render(r.harness) + "\n" + fg(th.Muted).Render(wrapText("Runs on whatever model "+r.harness+" is set to use by default; its settings don't say which.", w))
			}
			return fg(th.Text).Bold(true).Render(r.harness+" "+id) + "\n" + fg(th.Muted).Render(wrapText("The model "+r.harness+" is set to use when given none. Picking it pins it, so the member keeps it if that setting changes.", w))
		case r.typed != "":
			return fg(th.Text).Bold(true).Render(r.typed) + "\n" + fg(th.Muted).Render(wrapText("Passed to "+r.harness+" exactly as typed. tab picks another harness.", w))
		}
		return fg(th.Muted).Render(wrapText("enter or alt+c folds or opens this group · alt+↑↓ jumps between groups", w))
	}
	m := r.m
	lines := []string{fg(th.Text).Bold(true).Render(wrapText(m.Name, w)), fg(th.Subtle).Render(ansi.Truncate(m.Key, w, "…")), ""}
	fact := func(k, v string) {
		if v != "" {
			lines = append(lines, fg(th.Muted).Render(fmt.Sprintf("%-9s", k))+fg(th.Text).Render(ansi.Truncate(v, w-9, "…")))
		}
	}
	fact("provider", m.ProviderName)
	ctx := fmtCtx(m.Context)
	if m.Output > 0 {
		ctx += " in · " + fmtCtx(m.Output) + " out"
	}
	fact("context", ctx)
	if m.Cost != nil {
		price := fmtPrice(m.Cost)
		if price != "free" {
			price += " per Mtok"
		}
		// On a subscription harness the list price is only for comparison: it costs quota.
		if rt, ok := s.chosen(m); ok && rt.Ready {
			switch routeCost(rt) {
			case "quota":
				fact("cost", "quota on your "+rt.Harness+" subscription")
				if price != "free" {
					price = "API list " + price
				}
			case "credits":
				fact("cost", "paid usage credits on your "+rt.Harness+" plan, not its quota")
			case "billed":
				fact("cost", "billed per token")
			}
		}
		fact("price", price)
	}
	fact("released", m.Released)
	var caps []string
	for _, c := range []struct {
		on   bool
		name string
	}{{m.Reasoning, "reasoning"}, {m.Tools, "tools"}, {m.Vision, "vision"}, {m.OpenWeights, "open weights"}} {
		if c.on {
			caps = append(caps, c.name)
		}
	}
	fact("can", strings.Join(caps, ", "))
	lines = append(lines, "", fg(th.Muted).Render("runs on"))
	rs := s.routes(m)
	pick := 0
	if len(rs) > 0 {
		pick = s.routeIx(m, rs)
	}
	for i, rt := range rs {
		mark := "  "
		st := fg(th.Text)
		if i == pick {
			mark, st = fg(th.Accent2).Render("❯ "), fg(th.Accent2).Bold(true)
		}
		label := rt.Harness
		if rt.Label != "" {
			label += " · " + rt.Label
		}
		status := fg(th.OK).Render(" ✓")
		if c := routeCost(rt); c == "credits" {
			status += fg(th.Warn).Render(" credits")
		} else {
			status += fg(th.Subtle).Render(" " + c)
		}
		if !rt.Ready {
			status, st = fg(th.Warn).Render(" "+rt.Needs), fg(th.Subtle)
			if i == pick {
				st = fg(th.Warn).Bold(true)
			}
		}
		lines = append(lines, ansi.Truncate(mark+st.Render(label)+status, w, "…"))
	}
	if len(rs) > 1 {
		lines = append(lines, fg(th.Subtle).Render("tab switches harness"))
	}
	fav := "alt+f star"
	if s.fav(m) {
		fav = "alt+f unstar"
	}
	lines = append(lines, "", fg(th.Subtle).Render(fav))
	return strings.Join(lines, "\n")
}

// wrapText breaks prose to a width, on spaces.
func wrapText(s string, w int) string {
	return lipgloss.NewStyle().Width(w).Render(s)
}

// harnessDefault is the model a harness runs when given none, and its catalog entry when there is one.
func (s *modelSearch) harnessDefault(h string) (string, *rpc.CatalogModel) {
	return harnessDefault(s.cat(), h)
}

func harnessDefault(c *rpc.Catalog, h string) (string, *rpc.CatalogModel) {
	if c == nil {
		return "", nil
	}
	id := ""
	for _, x := range c.Harnesses {
		if x.CLI == h {
			id = x.DefaultModel
		}
	}
	if id == "" {
		return "", nil
	}
	for i := range c.Models {
		for _, rt := range c.Models[i].Routes {
			if rt.Harness == h && rt.ID == id {
				return id, &c.Models[i]
			}
		}
	}
	return id, nil
}
