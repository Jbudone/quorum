package ui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

var pauseModes = []string{"round", "message", "auto"}

type startModel struct {
	presets []rpc.Preset
	cursor  int
	topic   textarea.Model
	focus   int // 0 = preset list, 1 = topic
	mock    bool
	err     string

	personas   []rpc.Persona
	clis       []rpc.CLIInfo
	drafts     map[string]*settings // per-council edits made in the drawer, kept while choosing
	drawer     *settings            // non-nil while the settings drawer is open
	th         theme.Theme
	notice     string
	savingFrom string // the council the in-flight save was started from
	designing  bool   // waiting for a model to design the council
	designReq  bool   // set when a design should be requested; the app sends it and clears it
	saveReq    string // set when the drawer asks to save; the app sends it and clears it
}

func newStart(th theme.Theme, mock bool) startModel {
	ta := newInput(th, 3)
	ta.Placeholder = "Describe the feature or decision you want the council to work out…"
	ta.Prompt = ""
	return startModel{topic: ta, mock: mock, focus: 0, drafts: map[string]*settings{}, th: th}
}

func (m *startModel) selected() (rpc.Preset, bool) {
	if m.cursor < 0 || m.cursor >= len(m.presets) {
		return rpc.Preset{}, false
	}
	return m.presets[m.cursor], true
}

// startParams builds the session.start request for the current choices.
func (m *startModel) startParams(repo string) map[string]any {
	p, _ := m.selected()
	params := map[string]any{
		"preset": p.Name,
		"topic":  strings.TrimSpace(m.topic.Value()),
		"repo":   repo,
	}
	// An edited council travels as a full config; an untouched one is just its name.
	if d := m.drafts[p.Name]; d != nil && d.dirty() {
		delete(params, "preset")
		params["config"] = d.wire(p.Name)
	}
	if m.mock {
		params["mock"] = true
	}
	return params
}

// effective is the council as it will run: the drawer's edits if there are any.
func (m *startModel) effective() rpc.Preset {
	p, _ := m.selected()
	if d := m.drafts[p.Name]; d != nil && d.dirty() {
		return d.draft
	}
	return p
}

// openDrawer shows the settings for the selected council.
func (m *startModel) openDrawer() {
	p, ok := m.selected()
	if !ok {
		m.err = "Still loading the councils — one moment."
		return
	}
	d := m.drafts[p.Name]
	if d == nil {
		d = newSettings(p, m.personas, m.clis, m.th)
		m.drafts[p.Name] = d
	}
	d.personas, d.clis = m.personas, m.clis
	m.drawer = d
	m.topic.Blur()
}

func (m *startModel) canStart() bool {
	_, ok := m.selected()
	return ok && strings.TrimSpace(m.topic.Value()) != ""
}

// update handles a key press; start is true when the user asked to begin.
func (m *startModel) update(msg tea.KeyPressMsg) (start bool, cmd tea.Cmd) {
	m.err = ""
	if m.designing {
		if msg.String() == "esc" {
			m.designing = false // the answer, if it still arrives, is ignored
		}
		return false, nil
	}
	if m.drawer != nil {
		d := m.drawer
		closeIt, save, c := d.update(msg)
		if save != "" {
			m.saveReq = save
		}
		if closeIt {
			m.drawer = nil
		}
		if d.launch {
			d.launch = false
			return true, c
		}
		return false, c
	}
	switch msg.String() {
	case "tab", "shift+tab":
		m.focus = 1 - m.focus
		if m.focus == 1 {
			return false, m.topic.Focus()
		}
		m.topic.Blur()
		return false, nil
	case "alt+a":
		m.openDrawer()
		return false, nil
	case "alt+m":
		m.mock = !m.mock
		return false, nil
	case "ctrl+s":
		return m.tryStart()
	}
	if m.focus == 0 {
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.presets)-1 {
				m.cursor++
			}
		case "enter":
			m.focus = 1
			return false, m.topic.Focus()
		case "e":
			m.openDrawer()
		}
		return false, nil
	}
	if msg.String() == "enter" {
		return m.tryStart()
	}
	var c tea.Cmd
	m.topic, c = m.topic.Update(msg)
	return false, c
}

func (m *startModel) tryStart() (bool, tea.Cmd) {
	if !m.canStart() {
		if strings.TrimSpace(m.topic.Value()) == "" {
			m.err = "Tell the council what to work on first."
			m.focus = 1
			return false, m.topic.Focus()
		}
		if len(m.presets) == 0 {
			m.err = "Still loading the councils — one moment."
		} else {
			m.err = "Pick a council first."
		}
		return false, nil
	}
	if p, _ := m.selected(); p.Auto {
		if d := m.drafts[p.Name]; d == nil || !d.dirty() {
			m.designing, m.designReq = true, true
			return false, nil
		}
	}
	return true, nil
}

// applyDesign opens the drawer on the council a model proposed so the human can review and tweak it.
func (m *startModel) applyDesign(r rpc.DesignResult) {
	p, _ := m.selected()
	cfg := r.Config
	cfg.Name = p.Name
	s := newSettings(p, m.personas, m.clis, m.th)
	s.draft = clonePreset(cfg)
	for i := range s.draft.Agents {
		s.draft.Agents[i].Role = s.personaRole(s.draft.Agents[i].Persona)
	}
	s.forced, s.proposal = true, &r
	m.drafts[p.Name] = s
	m.drawer, m.designing = s, false
}

func (m *startModel) view(th theme.Theme, w, h int, repo string, loading bool, spin string, frame int) string {
	cw := w - 4
	if cw > 84 {
		cw = 84
	}
	if cw < 40 {
		cw = min(40, max(w-2, 20)) // a phone gets the whole width
	}
	compact := h < 38 || w < 60
	if m.drawer != nil {
		logo := fg(th.Accent2).Render("▓▒░ ") + theme.GradientShift("QUORUM", frame, th.Accent2, th.Accent, th.Info, th.Speaker(2)) + fg(th.Accent2).Render(" ░▒▓")
		return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, lipgloss.NewStyle().Width(cw).Render(logo+"\n\n"+m.drawer.view(th, cw, h)))
	}
	if m.designing {
		var d strings.Builder
		d.WriteString(renderLogo(th, frame) + "\n\n")
		d.WriteString(sectionTitle("Designing the council", cw, th, true) + "\n")
		d.WriteString(fg(th.Muted).Italic(true).Render(spin+" reading your topic, picking models and roles…") + "\n")
		d.WriteString(wave(max(cw-4, 8), frame, th) + "\n\n")
		d.WriteString(fg(th.Subtle).Render("esc to cancel"))
		return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, lipgloss.NewStyle().Width(cw).Render(d.String()))
	}
	var b strings.Builder
	if compact {
		b.WriteString(fg(th.Accent2).Render("▓▒░ ") + theme.GradientShift("QUORUM", frame, th.Accent2, th.Accent, th.Info, th.Speaker(2)) + fg(th.Accent2).Render(" ░▒▓") + "\n")
	} else {
		b.WriteString(renderLogo(th, frame) + "\n")
		b.WriteString(fg(th.Muted).Render("> a council of AI agents debates your plan, then writes it down_") + "\n\n")
	}

	b.WriteString(sectionTitle("Choose a council", cw, th, m.focus == 0) + "\n")
	if loading {
		b.WriteString(fg(th.Muted).Render(spin+" starting the engine…") + "\n")
	}
	for i, p := range m.presets {
		if i > 0 && !compact {
			b.WriteString("\n")
		}
		sel := i == m.cursor
		bar := fg(th.Subtle).Render("│")
		name := fg(th.Text).Bold(true).Render(p.Name)
		if sel {
			bar = fg(th.Accent2).Render("▌")
			name = fg(th.Accent2).Bold(true).Render(p.Name)
		}
		edited := m.drafts[p.Name] != nil && m.drafts[p.Name].dirty()
		if edited {
			name += fg(th.Warn).Render(" ✎")
			p = m.drafts[p.Name].draft
		} else if p.Custom {
			name += fg(th.Muted).Render(" ★")
		}
		var chips []string
		for j, a := range p.Agents {
			chips = append(chips, fg(th.Speaker(j)).Render(a.ID))
		}
		meta := fg(th.Muted).Render(fmt.Sprintf("%s · %d rounds", protocolLabel(p.Protocol), p.Rounds))
		b.WriteString(bar + " " + name + "  " + fg(th.Muted).Render(ansi.Truncate(p.Description, cw-4-lipgloss.Width(p.Name), "…")) + "\n")
		if !compact {
			b.WriteString(bar + " " + ansi.Truncate(strings.Join(chips, fg(th.Subtle).Render(" · ")), cw-lipgloss.Width(meta)-6, "…") + "  " + meta + "\n")
		}
	}

	b.WriteString("\n" + sectionTitle("What should they work out?", cw, th, m.focus == 1) + "\n")
	m.topic.SetWidth(cw - 4)
	if compact {
		m.topic.SetHeight(1)
	} else {
		m.topic.SetHeight(3)
	}
	border := th.Border
	if m.focus == 1 {
		border = th.Accent
	}
	b.WriteString(lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(border).Padding(0, 1).Render(m.topic.View()) + "\n")

	b.WriteString(fg(th.Subtle).Render("repo "+repo) + "\n")
	if m.err != "" {
		b.WriteString(fg(th.Err).Render("✗ "+m.err) + "\n")
	}
	if m.notice != "" {
		b.WriteString(fg(th.OK).Render("✓ "+m.notice) + "\n")
	}
	if m.mock {
		b.WriteString(fg(th.Warn).Render("mock agents: no tokens will be spent") + "\n")
	}
	if !compact {
		b.WriteString("\n")
	}
	k := func(key, what string) string { return fg(th.Text).Render(key) + " " + fg(th.Muted).Render(what) }
	hints := []string{k("↑↓", "choose"), k("tab", "switch"), k("enter", "start"), k("alt+a", "customize"), k("alt+o", "models"), k("ctrl+c", "quit")}
	sep := fg(th.Subtle).Render(" · ")
	for len(hints) > 1 && lipgloss.Width(strings.Join(hints, sep)) > cw {
		hints = hints[:len(hints)-1]
	}
	b.WriteString(strings.Join(hints, sep))

	return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, lipgloss.NewStyle().Width(cw).Render(b.String()))
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func protocolLabel(p string) string {
	switch p {
	case "draft-critique-revise":
		return "draft → critique → revise"
	case "delphi":
		return "delphi"
	}
	return p
}
