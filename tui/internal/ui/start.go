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
	presets  []rpc.Preset
	cursor   int
	topic    textarea.Model
	focus    int // 0 = preset list, 1 = topic
	mock     bool
	advanced bool
	rounds   int // 0 = use the preset's own
	pause    int // index into pauseModes
	err      string
}

func newStart(th theme.Theme, mock bool) startModel {
	ta := newInput(th, 3)
	ta.Placeholder = "Describe the feature or decision you want the council to work out…"
	ta.Prompt = ""
	return startModel{topic: ta, mock: mock, focus: 0}
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
		"pause":  pauseModes[m.pause],
	}
	if m.mock {
		params["mock"] = true
	}
	if m.rounds > 0 {
		params["rounds"] = m.rounds
	}
	return params
}

func (m *startModel) canStart() bool {
	_, ok := m.selected()
	return ok && strings.TrimSpace(m.topic.Value()) != ""
}

// update handles a key press; start is true when the user asked to begin.
func (m *startModel) update(msg tea.KeyPressMsg) (start bool, cmd tea.Cmd) {
	m.err = ""
	switch msg.String() {
	case "tab", "shift+tab":
		m.focus = 1 - m.focus
		if m.focus == 1 {
			return false, m.topic.Focus()
		}
		m.topic.Blur()
		return false, nil
	case "ctrl+a":
		m.advanced = !m.advanced
		return false, nil
	case "ctrl+t":
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
		case "left", "h":
			if m.advanced && m.rounds > 0 {
				m.rounds--
			}
		case "right", "l":
			if m.advanced {
				if m.rounds == 0 {
					if p, ok := m.selected(); ok {
						m.rounds = p.Rounds
					}
				}
				if m.rounds < 12 {
					m.rounds++
				}
			}
		case "p":
			if m.advanced {
				m.pause = (m.pause + 1) % len(pauseModes)
			}
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
	return true, nil
}

func (m *startModel) view(th theme.Theme, w, h int, repo string, loading bool, spin string) string {
	cw := w - 4
	if cw > 84 {
		cw = 84
	}
	if cw < 40 {
		cw = 40
	}
	compact := h < 30
	var b strings.Builder
	logo := fg(th.Accent2).Render("✦ ") + theme.Gradient("Quorum", th.Accent2, th.Accent)
	b.WriteString(logo + "\n")
	if !compact {
		b.WriteString(fg(th.Muted).Render("A council of AI agents that debates your plan, then writes it down.") + "\n\n")
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

	if m.advanced {
		pm := pauseModes[m.pause]
		rounds := "preset default"
		if m.rounds > 0 {
			rounds = fmt.Sprint(m.rounds)
		}
		b.WriteString(fg(th.Muted).Render(fmt.Sprintf("rounds %s (←/→)  ·  pause after each %s (p)  ·  mock agents %s (ctrl+t)", rounds, pm, onOff(m.mock))) + "\n")
	}
	b.WriteString(fg(th.Subtle).Render("repo "+repo) + "\n")
	if m.err != "" {
		b.WriteString(fg(th.Err).Render("✗ "+m.err) + "\n")
	}
	if m.mock {
		b.WriteString(fg(th.Warn).Render("mock agents: no tokens will be spent") + "\n")
	}
	if !compact {
		b.WriteString("\n")
	}
	k := func(key, what string) string { return fg(th.Text).Render(key) + " " + fg(th.Muted).Render(what) }
	hints := []string{k("↑↓", "choose"), k("tab", "switch"), k("enter", "start"), k("ctrl+a", "advanced"), k("ctrl+c", "quit")}
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
