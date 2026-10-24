package ui

import (
	"fmt"
	"regexp"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

var protocols = []string{"draft-critique-revise", "delphi", "round-robin"}

const maxMembers = 8

// Row kinds in the settings drawer, in display order.
const (
	rowProtocol = iota
	rowRounds
	rowPause
	rowReadOnly
	rowEvidence
	rowChairCLI
	rowChairModel
	rowPersona // member rows follow: persona, cli, model for each member
	rowMemberCLI
	rowMemberModel
)

type row struct {
	kind   int
	member int // index into the draft's agents for member rows
}

// settings is the drawer that edits a private copy of the selected council.
type settings struct {
	draft  rpc.Preset
	base   rpc.Preset // the council as the engine listed it, for reset and the edited marker
	cursor int
	naming bool
	name   textinput.Model
	err    string
	notice string
	// proposal is set when a model designed this council; the human reviews it before starting.
	proposal *rpc.DesignResult
	forced   bool // always send as a full config, even if unchanged from base
	launch   bool // the human asked to start with these settings
	personas []rpc.Persona
	clis     []rpc.CLIInfo
}

func newSettings(p rpc.Preset, personas []rpc.Persona, clis []rpc.CLIInfo, th theme.Theme) *settings {
	ti := textinput.New()
	ti.Prompt = ""
	ti.Placeholder = "name for this council"
	ti.CharLimit = 40
	ti.SetWidth(32)
	return &settings{draft: clonePreset(p), base: clonePreset(p), personas: personas, clis: clis, name: ti}
}

func clonePreset(p rpc.Preset) rpc.Preset {
	p.Agents = append([]rpc.PresetAgent(nil), p.Agents...)
	return p
}

func (s *settings) dirty() bool { return s.forced || presetDiffers(s.base, s.draft) }

func presetDiffers(a, b rpc.Preset) bool {
	if a.Protocol != b.Protocol || a.Rounds != b.Rounds || a.Pause != b.Pause || a.ReadOnly != b.ReadOnly ||
		a.RequireEvidence != b.RequireEvidence || a.Chair != b.Chair || len(a.Agents) != len(b.Agents) {
		return true
	}
	for i := range a.Agents {
		x, y := a.Agents[i], b.Agents[i]
		if x.ID != y.ID || x.CLI != y.CLI || x.Model != y.Model || x.Persona != y.Persona {
			return true
		}
	}
	return false
}

func (s *settings) rows() []row {
	rs := []row{{kind: rowProtocol}, {kind: rowRounds}, {kind: rowPause}, {kind: rowReadOnly}, {kind: rowEvidence}, {kind: rowChairCLI}, {kind: rowChairModel}}
	for i := range s.draft.Agents {
		rs = append(rs, row{rowPersona, i}, row{rowMemberCLI, i}, row{rowMemberModel, i})
	}
	return rs
}

// usableCLIs lists the CLIs a member can run on; the current one is kept even if it is unusable so it can be seen.
func (s *settings) usableCLIs(current string) []string {
	var out []string
	seen := map[string]bool{}
	for _, c := range s.clis {
		if c.Usable || c.CLI == current {
			out = append(out, c.CLI)
			seen[c.CLI] = true
		}
	}
	if !seen[current] && current != "" {
		out = append(out, current)
	}
	return out
}

func (s *settings) models(cli string) []string {
	for _, c := range s.clis {
		if c.CLI == cli {
			return append([]string{""}, c.Models...)
		}
	}
	return []string{""}
}

// cycle returns the item after (or before) cur in opts, wrapping; cur missing from opts yields the first.
func cycle(opts []string, cur string, dir int) string {
	if len(opts) == 0 {
		return cur
	}
	for i, o := range opts {
		if o == cur {
			return opts[(i+dir+len(opts))%len(opts)]
		}
	}
	return opts[0]
}

var idChars = regexp.MustCompile(`[^a-z0-9-]+`)

// uniqueID derives a member id from a persona key, adding -2, -3 … when taken by another member.
func uniqueID(persona string, agents []rpc.PresetAgent, self int) string {
	base := strings.Trim(idChars.ReplaceAllString(strings.ToLower(persona), "-"), "-")
	if base == "" || base == "chair" {
		base = "member"
	}
	taken := func(id string) bool {
		for i, a := range agents {
			if i != self && a.ID == id {
				return true
			}
		}
		return false
	}
	id := base
	for n := 2; taken(id); n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	return id
}

func (s *settings) personaRole(key string) string {
	for _, p := range s.personas {
		if p.Key == key {
			return p.Role
		}
	}
	return ""
}

// change applies a left (-1) or right (+1) press to the current row.
func (s *settings) change(dir int) {
	r := s.rows()[s.cursor]
	d := &s.draft
	switch r.kind {
	case rowProtocol:
		d.Protocol = cycle(protocols, d.Protocol, dir)
	case rowRounds:
		d.Rounds = min(12, max(1, d.Rounds+dir))
	case rowPause:
		d.Pause = cycle(pauseModes, d.Pause, dir)
	case rowReadOnly:
		d.ReadOnly = !d.ReadOnly
	case rowEvidence:
		d.RequireEvidence = !d.RequireEvidence
	case rowChairCLI:
		d.Chair.CLI = cycle(s.usableCLIs(d.Chair.CLI), d.Chair.CLI, dir)
		d.Chair.Model = ""
	case rowChairModel:
		d.Chair.Model = cycle(s.models(d.Chair.CLI), d.Chair.Model, dir)
	case rowPersona:
		var keys []string
		for _, p := range s.personas {
			keys = append(keys, p.Key)
		}
		a := &d.Agents[r.member]
		a.Persona = cycle(keys, a.Persona, dir)
		a.Role = s.personaRole(a.Persona)
		a.ID = uniqueID(a.Persona, d.Agents, r.member)
	case rowMemberCLI:
		a := &d.Agents[r.member]
		a.CLI = cycle(s.usableCLIs(a.CLI), a.CLI, dir)
		a.Model = ""
	case rowMemberModel:
		a := &d.Agents[r.member]
		a.Model = cycle(s.models(a.CLI), a.Model, dir)
	}
}

func (s *settings) addMember() {
	if len(s.draft.Agents) >= maxMembers {
		s.err = fmt.Sprintf("A council holds at most %d members.", maxMembers)
		return
	}
	persona := "skeptic"
	if len(s.personas) > 0 {
		persona = s.personas[len(s.draft.Agents)%len(s.personas)].Key
	}
	cli := s.draft.Chair.CLI
	if u := s.usableCLIs(""); len(u) > 0 {
		cli = u[len(s.draft.Agents)%len(u)]
	}
	a := rpc.PresetAgent{CLI: cli, Persona: persona, Role: s.personaRole(persona)}
	s.draft.Agents = append(s.draft.Agents, a)
	i := len(s.draft.Agents) - 1
	s.draft.Agents[i].ID = uniqueID(persona, s.draft.Agents, i)
	s.cursor = len(s.rows()) - 3
}

func (s *settings) removeMember() {
	r := s.rows()[s.cursor]
	if r.kind < rowPersona {
		s.err = "Move onto a member to remove it."
		return
	}
	if len(s.draft.Agents) <= 1 {
		s.err = "A council needs at least one member."
		return
	}
	s.draft.Agents = append(s.draft.Agents[:r.member], s.draft.Agents[r.member+1:]...)
	s.cursor = min(s.cursor, len(s.rows())-1)
}

// wire is the config object session.start and presets.save take.
func (s *settings) wire(name string) map[string]any {
	agents := make([]map[string]any, 0, len(s.draft.Agents))
	for _, a := range s.draft.Agents {
		agents = append(agents, map[string]any{"id": a.ID, "cli": a.CLI, "model": a.Model, "persona": a.Persona})
	}
	return map[string]any{
		"name": name, "description": s.draft.Description, "protocol": s.draft.Protocol,
		"rounds": s.draft.Rounds, "pause": s.draft.Pause,
		"readOnly": s.draft.ReadOnly, "requireEvidence": s.draft.RequireEvidence,
		"chair":  map[string]any{"cli": s.draft.Chair.CLI, "model": s.draft.Chair.Model},
		"agents": agents,
	}
}

// update handles a key; close is true when the drawer should shut, save carries a name to persist under.
func (s *settings) update(k tea.KeyPressMsg) (closeIt bool, save string, cmd tea.Cmd) {
	key := k.String()
	s.err, s.notice = "", ""
	if s.naming {
		switch key {
		case "esc":
			s.naming = false
			s.name.Blur()
		case "enter":
			n := strings.TrimSpace(s.name.Value())
			if n == "" {
				s.err = "Give the council a name first."
				return false, "", nil
			}
			s.naming = false
			s.name.Blur()
			return false, n, nil
		default:
			s.name, cmd = s.name.Update(k)
		}
		return false, "", cmd
	}
	switch key {
	case "esc", "ctrl+a", "tab":
		return true, "", nil
	case "up", "k":
		s.cursor = max(0, s.cursor-1)
	case "down", "j":
		s.cursor = min(len(s.rows())-1, s.cursor+1)
	case "left", "h":
		s.change(-1)
	case "right", "l", "space", " ", "enter":
		s.change(1)
	case "a":
		s.addMember()
	case "d":
		s.removeMember()
	case "r":
		s.draft = clonePreset(s.base)
		s.cursor = min(s.cursor, len(s.rows())-1)
		s.notice = "Back to the original settings."
	case "g", "ctrl+s":
		if s.proposal != nil {
			s.launch = true
			return true, "", nil
		}
	case "s":
		s.naming = true
		s.name.SetValue("")
		return false, "", s.name.Focus()
	}
	return false, "", nil
}

func (s *settings) label(r row) (name, value, hint string) {
	d := s.draft
	orDefault := func(m string) string {
		if m == "" {
			return "default"
		}
		return m
	}
	switch r.kind {
	case rowProtocol:
		return "protocol", protocolLabel(d.Protocol), ""
	case rowRounds:
		return "rounds", fmt.Sprint(d.Rounds), ""
	case rowPause:
		return "pause", "after each " + d.Pause, ""
	case rowReadOnly:
		return "repo access", map[bool]string{true: "read-only", false: "can write"}[d.ReadOnly], ""
	case rowEvidence:
		return "evidence", map[bool]string{true: "required for claims", false: "not required"}[d.RequireEvidence], ""
	case rowChairCLI:
		return "chair", d.Chair.CLI, ""
	case rowChairModel:
		return "  model", orDefault(d.Chair.Model), ""
	case rowPersona:
		a := d.Agents[r.member]
		return a.ID, a.Persona, a.Role
	case rowMemberCLI:
		return "  runs on", d.Agents[r.member].CLI, ""
	}
	return "  model", orDefault(d.Agents[r.member].Model), ""
}

func (s *settings) view(th theme.Theme, w, h int) string {
	title := "Settings · " + s.base.Name
	if s.proposal != nil {
		title = "Proposed council"
	} else if s.dirty() {
		title += " · edited"
	}
	lines := []string{sectionTitle(title, w, th, true)}
	reserve := 6
	if p := s.proposal; p != nil {
		why := ansi.Wrap(fg(th.Text).Render(p.Rationale), w-2, "")
		if p.Source == "fallback" {
			why += "\n" + fg(th.Warn).Render("⚠ the designer's answer was unusable; this is the standard council")
		} else {
			why += "\n" + fg(th.Subtle).Render("designed by "+p.Designer)
		}
		lines = append(lines, why, "")
		reserve += strings.Count(why, "\n") + 2
	}
	rs := s.rows()
	var body []string
	for i, r := range rs {
		name, val, hint := s.label(r)
		sel := i == s.cursor
		bar, nameC, valC := fg(th.Subtle).Render("│"), fg(th.Muted), fg(th.Text)
		if sel {
			bar, nameC, valC = fg(th.Accent2).Render("▌"), fg(th.Text).Bold(true), fg(th.Accent2).Bold(true)
		}
		if r.kind == rowPersona {
			nameC = fg(th.Speaker(r.member)).Bold(true)
		}
		line := bar + " " + nameC.Render(fmt.Sprintf("%-12s", name)) + valC.Render(val)
		if sel {
			line += fg(th.Subtle).Render("  ◂ ▸")
		}
		if hint != "" {
			line += fg(th.Muted).Render("  " + hint)
		}
		body = append(body, ansi.Truncate(line, w, "…"))
	}
	// Window the rows around the cursor when the screen is short.
	room := max(h-reserve-3, 4)
	start := 0
	if len(body) > room {
		start = min(max(s.cursor-room/2, 0), len(body)-room)
		body = body[start : start+room]
	}
	lines = append(lines, body...)
	switch {
	case s.naming && s.err != "":
		lines = append(lines, fg(th.Err).Render("✗ "+s.err), fg(th.Accent2).Render("save as ")+s.name.View())
	case s.naming:
		lines = append(lines, "", fg(th.Accent2).Render("save as ")+s.name.View())
	case s.err != "":
		lines = append(lines, "", fg(th.Err).Render("✗ "+s.err))
	case s.notice != "":
		lines = append(lines, "", fg(th.Muted).Render(s.notice))
	default:
		lines = append(lines, "")
	}
	k := func(key, what string) string { return fg(th.Text).Render(key) + " " + fg(th.Muted).Render(what) }
	sep := fg(th.Subtle).Render(" · ")
	hints := []string{k("↑↓", "move"), k("←→", "change"), k("a", "add member"), k("d", "remove"), k("s", "save"), k("r", "reset"), k("esc", "done")}
	if s.proposal != nil {
		hints = append([]string{k("g", "start council")}, hints...)
	}
	if s.naming {
		hints = []string{k("enter", "save"), k("esc", "cancel")}
	}
	for len(hints) > 1 && ansi.StringWidth(strings.Join(hints, sep)) > w {
		hints = hints[:len(hints)-1]
	}
	return strings.Join(lines, "\n") + "\n" + strings.Join(hints, sep)
}
