package ui

import (
	"strings"

	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// setupModel is the conversation that sets up a channel. There's no channel until the human
// approves a lineup: the assistant learns the problem, finds the docs, and invents the members.
type setupModel struct {
	msgs      []noteItem // you | answer | error
	streaming string
	waiting   bool // the assistant is writing
	ready     bool // the engine has a setup chat open
	creating  bool
	proposal  *rpc.SetupProposal
	canLeave  bool // there are channels to go back to
	vp        viewport.Model
	in        textarea.Model
	follow    bool
}

const setupIntro = "Hi. What should this channel work on? If earlier discussions are written up somewhere, point me at the folder and I'll have everyone read it first."

func newSetup(th theme.Theme, canLeave bool) *setupModel {
	in := newInput(th, roomInputRows)
	in.Placeholder = "Describe the problem, and where any earlier notes live…"
	in.Focus()
	s := &setupModel{msgs: []noteItem{{kind: "answer", text: setupIntro}}, canLeave: canLeave, vp: viewport.New(), in: in, follow: true}
	s.vp.MouseWheelEnabled = true
	return s
}

func (s *setupModel) apply(ev rpc.Event) {
	switch v := ev.Data.(type) {
	case rpc.SetupDelta:
		s.streaming += v.Delta
	case rpc.SetupReply:
		s.waiting, s.streaming = false, ""
		if strings.TrimSpace(v.Text) != "" {
			s.msgs = append(s.msgs, noteItem{kind: "answer", text: v.Text})
		}
		if v.Proposal != nil && len(v.Proposal.Members) > 0 {
			s.proposal = v.Proposal
		}
	case rpc.EngineError:
		s.waiting, s.creating, s.streaming = false, false, ""
		s.msgs = append(s.msgs, noteItem{kind: "error", text: v.Message})
	}
}

func renderSetupChat(s *setupModel, th theme.Theme, width int, spin string) string {
	var b []string
	for _, m := range s.msgs {
		switch m.kind {
		case "you":
			b = append(b, fg(th.Accent2).Bold(true).Render("you")+"\n"+renderMarkdown(m.text, width, th))
		case "answer":
			b = append(b, fg(th.Info).Bold(true).Render("assistant")+"\n"+renderMarkdown(m.text, width, th))
		case "error":
			b = append(b, fg(th.Err).Render(ansi.Wrap("✗ "+m.text, width, "")))
		}
	}
	if s.waiting {
		text := strings.TrimSpace(reAction.ReplaceAllString(s.streaming, ""))
		if text == "" {
			b = append(b, fg(th.Info).Bold(true).Render("assistant")+" "+fg(th.Muted).Italic(true).Render(spin+" typing…"))
		} else {
			b = append(b, fg(th.Info).Bold(true).Render("assistant")+"\n"+renderMarkdown(text, width, th))
		}
	}
	if s.creating {
		b = append(b, fg(th.Muted).Italic(true).Render(spin+" opening the channel…"))
	}
	return strings.Join(b, "\n\n")
}

// renderProposal is the lineup card: what the channel is, what members read first, and who's in it.
func renderProposal(p *rpc.SetupProposal, th theme.Theme, width int) string {
	if p == nil {
		return fg(th.Subtle).Italic(true).Render(ansi.Wrap("The lineup appears here once the assistant knows enough. You can ask it to change anyone or anything.", width, ""))
	}
	name := p.Name
	if name == "" {
		name = "new-channel"
	}
	lines := []string{fg(th.Text).Bold(true).Render("#" + name)}
	if p.Topic != "" {
		lines = append(lines, fg(th.Muted).Render(ansi.Wrap(p.Topic, width, "")))
	}
	lines = append(lines, "", sectionTitle("reads first", width, th, false))
	if len(p.Reading) == 0 {
		lines = append(lines, fg(th.Subtle).Render("nothing; they start fresh"))
	}
	for _, r := range p.Reading {
		lines = append(lines, fg(th.Text).Render("▤ "+r))
	}
	lines = append(lines, "", sectionTitle("who", width, th, false))
	for i, m := range p.Members {
		cli := strings.TrimSpace(m.CLI + " " + m.Model)
		if cli == "" {
			cli = "as before"
		}
		lines = append(lines, fg(th.Speaker(i)).Bold(true).Render(m.ID)+fg(th.Subtle).Render(" · "+cli))
		if m.Role != "" {
			lines = append(lines, fg(th.Muted).Render(ansi.Truncate("  "+m.Role, width, "…")))
		}
	}
	lines = append(lines, "", fg(th.Accent2).Bold(true).Render("ctrl+s")+fg(th.Muted).Render(" open the channel"))
	return strings.Join(lines, "\n")
}

// setupLayout reports whether the lineup card sits beside the chat, and how wide each is.
func (a *App) setupLayout() (side bool, chatW, cardW int) {
	if a.w >= 90 {
		cardW = min(max(34, a.w*34/100), 56)
		return true, a.w - cardW - 3, cardW
	}
	return false, a.w - 2, a.w - 2
}

func (a *App) refreshSetup() {
	s := a.rm.setup
	side, chatW, cardW := a.setupLayout()
	h := max(a.h-1-1-(roomInputRows+2)-1, 6)
	if !side && s.proposal != nil {
		h = max(h-lipgloss.Height(renderProposal(s.proposal, a.th, cardW))-2, 4)
	}
	s.vp.SetWidth(chatW)
	s.vp.SetHeight(h)
	s.vp.SetContent(renderSetupChat(s, a.th, chatW, a.spin.View()))
	if s.follow {
		s.vp.GotoBottom()
	}
	s.in.SetWidth(a.w - 4)
	s.in.SetPromptFunc(5, func(pi textarea.PromptInfo) string {
		if pi.LineNumber != 0 {
			return strings.Repeat(" ", 5)
		}
		return fg(a.th.Info).Bold(true).Render("you") + fg(a.th.Subtle).Render("▸ ")
	})
}

func (a *App) setupView() string {
	s := a.rm.setup
	sep := fg(a.th.Subtle).Render(" › ")
	header := fg(a.th.Accent2).Render("▓▒░ ") + theme.GradientShift("QUORUM", a.frame/2, a.th.Accent2, a.th.Accent, a.th.Info, a.th.Speaker(2)) +
		fg(a.th.Accent2).Render(" ░▒▓ ") + fg(a.th.Muted).Render(workspaceName(a.opts.Repo)) + sep + fg(a.th.Text).Bold(true).Render("new channel")
	side, chatW, cardW := a.setupLayout()
	h := max(a.h-1-1-(roomInputRows+2)-1, 6)
	card := renderProposal(s.proposal, a.th, cardW)
	var body string
	if side {
		chat := lipgloss.NewStyle().Width(chatW).Height(h).Render(s.vp.View())
		bar := fg(a.th.Subtle).Render(strings.TrimRight(strings.Repeat("│\n", h), "\n"))
		body = lipgloss.JoinHorizontal(lipgloss.Top, chat, " ", bar, " ", lipgloss.NewStyle().Width(cardW).Height(h).MaxHeight(h).Render(card))
	} else {
		parts := []string{s.vp.View()}
		if s.proposal != nil {
			parts = append(parts, fg(a.th.Subtle).Render(strings.Repeat("─", a.w)), card)
		}
		body = lipgloss.NewStyle().Height(h).MaxHeight(h).Render(strings.Join(parts, "\n"))
	}
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Width(a.w).
		BorderForegroundBlend(a.th.Accent2, a.th.Accent, a.th.Info, a.th.Speaker(2)).BorderForegroundBlendOffset(a.frame).Render(s.in.View())
	k := func(key, what string) string { return fg(a.th.Text).Render(key) + " " + fg(a.th.Muted).Render(what) }
	keys := []string{k("enter", "send")}
	if s.proposal != nil {
		keys = append(keys, k("ctrl+s", "open the channel"))
	}
	if s.canLeave {
		keys = append(keys, k("esc", "back"))
	}
	keys = append(keys, k("ctrl+c", "quit"))
	footer := ansi.Truncate(strings.Join(keys, fg(a.th.Subtle).Render(" · ")), a.w, "")
	return lipgloss.JoinVertical(lipgloss.Left, header, "", body, box, footer)
}
