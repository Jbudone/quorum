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
	"github.com/jbud/quorum/tui/internal/theme"
)

// The add-member modal (alt+a, /add, or y on an assistant's "bring in" suggestion): who, their
// role, the model they run on, and how they're onboarded, then they join the channel.

type joinStep int

const (
	stepWho       joinStep = iota // a workspace member, or someone new
	stepRole                      // a preset, or describe them in a line
	stepDescribe                  // the one-line description the assistant drafts from
	stepEdit                      // id, role and persona, editable
	stepModel                     // which CLI
	stepModelPick                 // which of its models (searchable)
	stepOnboard                   // brief, reading, first question
	stepJoining
)

// joinRow is one row of the onboarding step.
type joinRow struct {
	kind  string // brief | read | extra | question
	label string
	on    bool
}

type joinModal struct {
	step       joinStep
	cur        int
	members    []rpc.WorkspaceMember // workspace members not in this channel
	presets    []rpc.Persona
	clis       []rpc.CLIInfo
	allowed    []string // CLIs this channel runs members on
	existing   string   // set when bringing in a workspace member
	idIn       textarea.Model
	roleIn     textarea.Model
	personaIn  textarea.Model
	describeIn textarea.Model
	extraIn    textarea.Model
	questionIn textarea.Model
	field      int // stepEdit: 0 id, 1 role, 2 persona
	cli, model string
	search     *modelSearch
	searchBack joinStep // where esc from the model search goes
	rows       []joinRow
	suggestion int // the assistant suggestion this answers, or -1
	waiting    string
	err        string
}

func newJoinModal(th theme.Theme, r *roomModel) *joinModal {
	one := func(ph string) textarea.Model {
		in := newInput(th, 1)
		in.Placeholder = ph
		return in
	}
	m := &joinModal{
		idIn: one("short-name"), roleIn: one("role, in a few words"), describeIn: one("e.g. a speedrunner who finds level exploits"),
		extraIn: one("more folders or files, space-separated"), questionIn: one("optional: what should they answer first?"),
		suggestion: -1, allowed: r.clis,
	}
	m.personaIn = newInput(th, 5)
	m.personaIn.Placeholder = "Their expertise, what they look for, how they argue."
	m.rows = []joinRow{{kind: "brief", label: "catch-up brief written for their role", on: true}}
	for _, p := range r.reading {
		m.rows = append(m.rows, joinRow{kind: "read", label: p, on: true})
	}
	m.rows = append(m.rows, joinRow{kind: "extra"}, joinRow{kind: "question"})
	return m
}

// prefill opens the modal from an assistant suggestion, ready to join as proposed.
func (m *joinModal) prefill(s rpc.RoomEvent) {
	m.suggestion = s.ID
	arg := func(i int) string {
		if i < len(s.Args) {
			return s.Args[i]
		}
		return ""
	}
	switch s.Action {
	case "hire":
		m.idIn.SetValue(arg(0))
		m.roleIn.SetValue(arg(3))
		m.personaIn.SetValue(arg(4))
		m.cli, m.model = arg(1), arg(2)
	case "add":
		m.existing, m.cli, m.model = arg(0), arg(1), arg(2)
	}
	m.step = stepOnboard
}

func (m *joinModal) whoOptions() []string {
	opts := []string{"+ someone new"}
	for _, w := range m.members {
		opts = append(opts, fmt.Sprintf("%s  %s · %s", w.ID, w.Role, strings.TrimSpace(w.CLI+" "+w.Model)))
	}
	return opts
}

func (m *joinModal) roleOptions() []string {
	opts := []string{"✎ describe them in a line; the assistant drafts the persona"}
	for _, p := range m.presets {
		opts = append(opts, fmt.Sprintf("%s  %s", p.Key, p.Role))
	}
	return opts
}

// cliOptions are the CLIs members can run on in this channel.
func (m *joinModal) cliOptions() []string {
	var out []string
	for _, c := range m.clis {
		if c.Usable && (len(m.allowed) == 0 || slices.Contains(m.allowed, c.CLI)) {
			out = append(out, c.CLI)
		}
	}
	// CLIs the channel runs on that the health check doesn't list (the mock cast) still count.
	for _, c := range m.allowed {
		if !slices.Contains(out, c) {
			out = append(out, c)
		}
	}
	return out
}

// joinSearch opens the model search for the member being brought in; esc returns to back.
func (a *App) joinSearch(back joinStep) {
	m := a.rm.join
	m.search, m.searchBack, m.step = a.openSearch(m.cliOptions(), m.cli, m.model), back, stepModelPick
}

func (m *joinModal) name() string {
	if m.existing != "" {
		return m.existing
	}
	return strings.TrimSpace(m.idIn.Value())
}

func (m *joinModal) focusEdit() tea.Cmd {
	ins := []*textarea.Model{&m.idIn, &m.roleIn, &m.personaIn}
	for i, in := range ins {
		if i == m.field {
			in.Focus()
		} else {
			in.Blur()
		}
	}
	return ins[m.field].Focus()
}

func (m *joinModal) focusOnboard() {
	m.extraIn.Blur()
	m.questionIn.Blur()
	if m.cur < len(m.rows) {
		switch m.rows[m.cur].kind {
		case "extra":
			m.extraIn.Focus()
		case "question":
			m.questionIn.Focus()
		}
	}
}

// openJoin shows the add-member modal and fetches what it lists.
func (a *App) openJoin(from *rpc.RoomEvent) {
	u := a.rm
	m := newJoinModal(a.th, u.room)
	if from != nil {
		m.prefill(*from)
	}
	u.join = m
	a.call("workspace.open", map[string]any{"repo": a.opts.Repo})
	a.call("personas.list", map[string]any{})
	a.call("clis.list", map[string]any{})
	if m.step == stepOnboard {
		m.cur = 0
	}
}

// joinResponse takes answers meant for the modal. It reports whether it took the method.
func (a *App) joinResponse(method string, r rpc.Response) bool {
	u := a.rm
	if u == nil || u.join == nil {
		return false
	}
	m := u.join
	switch method {
	case "personas.list":
		var ps []rpc.Persona
		if r.Err == "" && rpc.DecodeResult(r.Result, &ps) == nil {
			m.presets = ps
		}
	case "clis.list":
		var cs []rpc.CLIInfo
		if r.Err == "" && rpc.DecodeResult(r.Result, &cs) == nil {
			m.clis = cs
		}
	case "workspace.open":
		var w rpc.Workspace
		if r.Err == "" && rpc.DecodeResult(r.Result, &w) == nil {
			u.channels = w.Channels
			m.members = nil
			for _, x := range w.Members {
				if !u.room.isMember(x.ID) {
					m.members = append(m.members, x)
				}
			}
			// With nobody else in the workspace, "who" has one answer: go straight to the role.
			if m.step == stepWho && len(m.members) == 0 {
				m.step, m.cur = stepRole, 0
			}
		}
	case "persona.get", "persona.draft":
		m.waiting = ""
		if r.Err != "" {
			m.err = r.Err
			return true
		}
		var p struct {
			Key, ID, Role, Body, Persona string
		}
		if rpc.DecodeResult(r.Result, &p) != nil {
			return true
		}
		id := p.ID
		if id == "" {
			id = p.Key
			// A preset someone already uses in this workspace gets a fresh name.
			for n := 2; u.room.isMember(id) || m.memberNamed(id); n++ {
				id = fmt.Sprintf("%s-%d", p.Key, n)
			}
		}
		m.idIn.SetValue(id)
		m.roleIn.SetValue(p.Role)
		body := p.Body
		if body == "" {
			body = p.Persona
		}
		m.personaIn.SetValue(body)
		m.step, m.field = stepEdit, 2
		m.focusEdit()
	case "room.join":
		if r.Err != "" {
			m.step, m.err = stepOnboard, r.Err
			return true
		}
		var res struct {
			ID string `json:"id"`
		}
		_ = rpc.DecodeResult(r.Result, &res)
		u.join = nil
		u.room.asides = append(u.room.asides, noteItem{kind: "system", text: res.ID + " joined. They'll catch up and speak first."})
		u.asstFollow = true
	default:
		return false
	}
	return true
}

func (m *joinModal) memberNamed(id string) bool {
	for _, w := range m.members {
		if w.ID == id {
			return true
		}
	}
	return false
}

func (a *App) handleJoinKey(k tea.KeyPressMsg) tea.Cmd {
	m := a.rm.join
	key := k.String()
	m.err = ""
	if m.step == stepJoining || m.waiting != "" {
		if key == "esc" {
			m.waiting = ""
		}
		return nil
	}
	list := func(n int) bool {
		switch key {
		case "up":
			m.cur = max(m.cur-1, 0)
		case "down":
			m.cur = min(m.cur+1, n-1)
		default:
			return false
		}
		return true
	}
	switch m.step {
	case stepWho:
		opts := m.whoOptions()
		if list(len(opts)) {
			return nil
		}
		switch key {
		case "esc":
			a.rm.join = nil
		case "enter":
			if m.cur == 0 {
				m.step, m.cur = stepRole, 0
				return nil
			}
			w := m.members[m.cur-1]
			m.existing, m.cli, m.model = w.ID, w.CLI, w.Model
			a.joinSearch(stepWho)
		}
		return nil
	case stepRole:
		if list(len(m.roleOptions())) {
			return nil
		}
		switch key {
		case "esc":
			m.step, m.cur = stepWho, 0
		case "enter":
			if m.cur == 0 {
				m.step = stepDescribe
				return m.describeIn.Focus()
			}
			m.waiting = "loading the persona…"
			a.call("persona.get", map[string]any{"key": m.presets[m.cur-1].Key, "repo": a.opts.Repo})
		}
		return nil
	case stepDescribe:
		switch key {
		case "esc":
			m.step = stepRole
			return nil
		case "enter":
			if line := strings.TrimSpace(m.describeIn.Value()); line != "" {
				m.waiting = "the assistant is drafting a persona…"
				a.call("persona.draft", map[string]any{"line": line})
			}
			return nil
		}
		var c tea.Cmd
		m.describeIn, c = m.describeIn.Update(k)
		return c
	case stepEdit:
		ins := []*textarea.Model{&m.idIn, &m.roleIn, &m.personaIn}
		switch key {
		case "esc":
			m.step, m.cur = stepRole, 0
			return nil
		case "tab", "shift+tab":
			if key == "tab" {
				m.field = (m.field + 1) % 3
			} else {
				m.field = (m.field + 2) % 3
			}
			return m.focusEdit()
		case "alt+enter", "shift+enter":
			if m.field == 2 {
				m.personaIn.InsertString("\n")
			}
			return nil
		case "enter":
			if m.field < 2 {
				m.field++
				return m.focusEdit()
			}
			switch {
			case m.name() == "":
				m.err, m.field = "they need a short name", 0
				return m.focusEdit()
			case strings.TrimSpace(m.personaIn.Value()) == "":
				m.err = "describe how they think, so they know who they are"
				return nil
			}
			for _, in := range ins {
				in.Blur()
			}
			a.joinSearch(stepEdit)
			return nil
		}
		var c tea.Cmd
		*ins[m.field], c = ins[m.field].Update(k)
		return c
	case stepModelPick:
		if key == "esc" {
			m.search = nil
			switch m.searchBack {
			case stepWho:
				m.existing, m.step, m.cur = "", stepWho, 0
			case stepEdit:
				m.step, m.field = stepEdit, 2
				return m.focusEdit()
			default:
				m.step, m.cur = stepOnboard, 0
			}
			return nil
		}
		pick, done, fav, cmd := m.search.key(k)
		a.starred(fav)
		if done {
			a.picked(pick)
			m.cli, m.model, m.search = pick.harness, pick.model, nil
			m.step, m.cur = stepOnboard, 0
		}
		return cmd
	case stepOnboard:
		switch key {
		case "esc":
			m.extraIn.Blur()
			m.questionIn.Blur()
			a.joinSearch(stepOnboard)
			return nil
		case "up", "shift+tab":
			m.cur = max(m.cur-1, 0)
			m.focusOnboard()
			return nil
		case "down", "tab":
			m.cur = min(m.cur+1, len(m.rows)-1)
			m.focusOnboard()
			return nil
		case "enter":
			a.submitJoin()
			return nil
		}
		row := &m.rows[m.cur]
		switch row.kind {
		case "extra":
			var c tea.Cmd
			m.extraIn, c = m.extraIn.Update(k)
			return c
		case "question":
			var c tea.Cmd
			m.questionIn, c = m.questionIn.Update(k)
			return c
		}
		if key == "space" {
			row.on = !row.on
		}
		return nil
	}
	return nil
}

func (a *App) submitJoin() {
	m := a.rm.join
	if m.cli == "" {
		m.err = "pick a model first"
		return
	}
	params := map[string]any{"id": m.name(), "cli": m.cli}
	if m.model != "" {
		params["model"] = m.model
	}
	if m.existing == "" {
		params["role"] = strings.TrimSpace(m.roleIn.Value())
		params["persona"] = strings.TrimSpace(m.personaIn.Value())
	}
	brief, all := false, true
	reading := []string{}
	for _, r := range m.rows {
		switch {
		case r.kind == "brief":
			brief = r.on
		case r.kind == "read" && r.on:
			reading = append(reading, r.label)
		case r.kind == "read":
			all = false
		}
	}
	extra := strings.Fields(m.extraIn.Value())
	// The channel's own reading list (unchanged) is tracked for changes; anything else is theirs alone.
	if !all || len(extra) > 0 {
		params["reading"] = append(reading, extra...)
	}
	params["brief"] = brief
	if q := strings.TrimSpace(m.questionIn.Value()); q != "" {
		params["question"] = q
	}
	if m.suggestion >= 0 {
		params["suggestion"] = m.suggestion
	}
	m.step = stepJoining
	a.call("room.join", params)
}

// renderJoin draws the modal for its current step.
func renderJoin(m *joinModal, th theme.Theme, width int, spin string) string {
	steps := []string{"who", "role", "model", "onboarding"}
	at := map[joinStep]int{stepWho: 0, stepRole: 1, stepDescribe: 1, stepEdit: 1, stepModel: 2, stepModelPick: 2, stepOnboard: 3, stepJoining: 3}[m.step]
	var crumbs []string
	for i, s := range steps {
		switch {
		case i == at:
			crumbs = append(crumbs, fg(th.Accent2).Bold(true).Render(s))
		case i == 1 && m.existing != "":
			crumbs = append(crumbs, fg(th.Subtle).Strikethrough(true).Render(s))
		default:
			crumbs = append(crumbs, fg(th.Muted).Render(s))
		}
	}
	lines := []string{sectionTitle("bring someone in", width, th, true), strings.Join(crumbs, fg(th.Subtle).Render(" › ")), ""}
	pick := func(opts []string) {
		for i, o := range opts {
			if i == m.cur {
				lines = append(lines, fg(th.Accent2).Bold(true).Render(ansi.Truncate("❯ "+o, width, "…")))
			} else {
				lines = append(lines, fg(th.Text).Render(ansi.Truncate("  "+o, width, "…")))
			}
		}
	}
	keys := ""
	switch m.step {
	case stepWho:
		lines = append(lines, fg(th.Muted).Render("Workspace members bring what they learned in other channels."), "")
		pick(m.whoOptions())
		keys = "↑↓ choose · enter next · esc cancel"
	case stepRole:
		pick(m.roleOptions())
		keys = "↑↓ choose · enter next · esc back"
	case stepDescribe:
		lines = append(lines, fg(th.Muted).Render("Who should join? One line is enough."), "", m.describeIn.View())
		keys = "enter draft · esc back"
	case stepEdit:
		label := func(i int, s string) string {
			if i == m.field {
				return fg(th.Accent2).Bold(true).Render(s)
			}
			return fg(th.Muted).Render(s)
		}
		lines = append(lines, label(0, "name"), m.idIn.View(), label(1, "role"), m.roleIn.View(), label(2, "persona"), m.personaIn.View())
		keys = "tab next field · enter next · alt+enter new line · esc back"
	case stepModelPick:
		lines = append(lines, fg(th.Muted).Render("Which model? Mixing vendors helps: different models catch different things."), "", m.search.view(th, width, spin))
		keys = "type to search · ↑↓ choose · tab harness · enter use it · alt+f star · alt+c fold · esc back"
	case stepOnboard, stepJoining:
		who := m.name()
		model := strings.TrimSpace(m.cli + " " + m.model)
		lines = append(lines, fg(th.Text).Bold(true).Render(who)+fg(th.Muted).Render(" on "+model))
		if m.existing == "" && m.roleIn.Value() != "" {
			lines = append(lines, fg(th.Muted).Render(ansi.Truncate(m.roleIn.Value(), width, "…")))
		}
		lines = append(lines, "", fg(th.Muted).Render("Before their first message they get:"))
		for i, r := range m.rows {
			mark := "  "
			if i == m.cur && m.step == stepOnboard {
				mark = fg(th.Accent2).Render("❯ ")
			}
			switch r.kind {
			case "brief", "read":
				box := "[ ]"
				if r.on {
					box = "[x]"
				}
				label := r.label
				if r.kind == "read" {
					label = "read " + label
				}
				lines = append(lines, mark+fg(th.Text).Render(box+" "+label))
			case "extra":
				lines = append(lines, mark+fg(th.Muted).Render("also read  ")+m.extraIn.View())
			case "question":
				lines = append(lines, mark+fg(th.Muted).Render("first ask  ")+m.questionIn.View())
			}
		}
		keys = "↑↓ move · space toggle · enter join · esc back"
		if m.step == stepJoining {
			lines = append(lines, "", fg(th.Muted).Italic(true).Render(spin+" onboarding "+who+"…"))
			keys = ""
		}
	}
	if m.waiting != "" {
		lines = append(lines, "", fg(th.Muted).Italic(true).Render(spin+" "+m.waiting))
	}
	if m.err != "" {
		lines = append(lines, "", fg(th.Err).Render(ansi.Wrap("✗ "+m.err, width, "")))
	}
	if keys != "" {
		lines = append(lines, "", fg(th.Subtle).Render(keys))
	}
	return strings.Join(lines, "\n")
}

// joinBox frames the modal over the channel.
func (a *App) joinBox(height int) string {
	m := a.rm.join
	w := min(a.w-4, 84)
	if m.step == stepModelPick {
		w = min(a.w-4, 140)
	}
	inner := w - 4
	for _, in := range []*textarea.Model{&m.idIn, &m.roleIn, &m.personaIn, &m.describeIn} {
		in.SetWidth(inner)
	}
	m.extraIn.SetWidth(inner - 13)
	m.questionIn.SetWidth(inner - 13)
	body := renderJoin(m, a.th, inner, a.spin.View())
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(a.th.Accent).Padding(0, 1).Width(w).MaxHeight(height).Render(body)
	return lipgloss.Place(a.w, height, lipgloss.Center, lipgloss.Center, box)
}
