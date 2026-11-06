package ui

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// setupModel is a planning session with the assistant: for a new channel (there's no channel until
// the human approves the plan) or for the channel that's open (alt+g, /plan). The assistant asks
// choice-card questions to narrow things down, then proposes a plan the human edits in a form.
type setupModel struct {
	channel   bool // planning the open channel's next steps
	msgs      []noteItem
	streaming string
	waiting   bool
	ready     bool
	creating  bool
	proposal  *rpc.SetupProposal
	canLeave  bool
	vp        viewport.Model
	in        textarea.Model
	follow    bool

	// Choice cards the assistant asked, answered one at a time.
	questions []rpc.PlanQuestion
	qi, qcur  int
	picked    map[int]bool
	own       textarea.Model // "type your own" answer
	owning    bool
	answers   []string

	form *planForm
}

const (
	setupIntro   = "Hi. What should this channel work on? Tell me the problem in your own words, and where any earlier notes live. I'll ask a few questions, then suggest who to bring in and where to start."
	channelIntro = "What should we figure out next? I'll ask a few questions, then suggest what to consider, who to bring in and which workstreams to start."
)

func newSetup(th theme.Theme, canLeave, channel bool) *setupModel {
	in := newInput(th, roomInputRows)
	in.Placeholder = "Describe the problem, and where any earlier notes live…"
	intro := setupIntro
	if channel {
		in.Placeholder = "What's on your mind for this channel?"
		intro = channelIntro
	}
	in.Focus()
	own := newInput(th, 1)
	own.Placeholder = "your own answer"
	s := &setupModel{channel: channel, msgs: []noteItem{{kind: "answer", text: intro}}, canLeave: canLeave || channel, vp: viewport.New(), in: in, own: own, follow: true}
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
		if v.Proposal != nil && len(v.Proposal.Members)+len(v.Proposal.Topics) > 0 {
			s.proposal = v.Proposal
		}
		s.questions, s.qi, s.qcur, s.picked, s.answers = v.Questions, 0, 0, map[int]bool{}, nil
		if len(s.questions) > 0 {
			s.in.Blur()
		}
	case rpc.EngineError:
		s.waiting, s.creating, s.streaming = false, false, ""
		s.msgs = append(s.msgs, noteItem{kind: "error", text: v.Message})
	}
}

func (s *setupModel) asking() bool { return len(s.questions) > 0 && s.qi < len(s.questions) }

// answerCard records the current card's answer and moves on; after the last it sends them all.
func (a *App) answerCard(answer string) {
	s := a.rm.setup
	q := s.questions[s.qi]
	s.answers = append(s.answers, fmt.Sprintf("%s: %s", q.Header, answer))
	s.msgs = append(s.msgs, noteItem{kind: "you", text: fmt.Sprintf("**%s** %s", q.Header, answer)})
	s.qi, s.qcur, s.picked, s.owning = s.qi+1, 0, map[int]bool{}, false
	s.own.Reset()
	s.own.Blur()
	if s.qi >= len(s.questions) {
		s.questions = nil
		s.waiting, s.follow = true, true
		s.in.Focus()
		a.call("setup.say", map[string]any{"text": strings.Join(s.answers, "\n")})
	}
}

func (a *App) handleQuestionKey(k tea.KeyPressMsg) tea.Cmd {
	s := a.rm.setup
	q := s.questions[s.qi]
	rows := len(q.Options) + 1 // the last row is "type your own"
	if s.owning {
		switch k.String() {
		case "esc":
			s.owning = false
			s.own.Placeholder = "your own answer"
			s.own.Blur()
			return nil
		case "enter":
			if v := strings.TrimSpace(s.own.Value()); v != "" {
				s.own.Placeholder = "your own answer"
				a.answerCard(v)
			}
			return nil
		}
		var c tea.Cmd
		s.own, c = s.own.Update(k)
		return c
	}
	switch k.String() {
	case "up", "k":
		s.qcur = max(s.qcur-1, 0)
	case "down", "j":
		s.qcur = min(s.qcur+1, rows-1)
	case "space":
		if q.Multi && s.qcur < len(q.Options) {
			s.picked[s.qcur] = !s.picked[s.qcur]
		}
	case "esc":
		// Skip the cards and just talk.
		s.questions = nil
		return s.in.Focus()
	case "enter":
		if s.qcur == len(q.Options) {
			s.owning = true
			return s.own.Focus()
		}
		// An option that promises to type something ("I'll enter the model") opens the answer box
		// instead of sending its label as the answer.
		if !q.Multi && promisesTyping(q.Options[s.qcur].Label) {
			s.owning = true
			s.own.Placeholder = strings.TrimSuffix(strings.TrimSpace(q.Options[s.qcur].Label), " (recommended)")
			return s.own.Focus()
		}
		var labels []string
		for i, o := range q.Options {
			if q.Multi && s.picked[i] || !q.Multi && i == s.qcur || q.Multi && len(s.picked) == 0 && i == s.qcur {
				labels = append(labels, strings.TrimSuffix(strings.TrimSpace(o.Label), " (recommended)"))
			}
		}
		a.answerCard(strings.Join(labels, ", "))
	default:
		if n := int(k.String()[0] - '1'); len(k.String()) == 1 && n >= 0 && n < len(q.Options) {
			s.qcur = n
		}
	}
	return nil
}

// promisesTyping reports whether an option's label means "I'll write the answer myself" rather
// than being an answer, so picking it should open the text box.
var typingOption = regexp.MustCompile(`(?i)\b(i'?ll|i will|let me|i can|i'd like to)\s+(type|enter|paste|write|give|provide|specify|add|put in|fill in)\b|^\s*(other|custom|something else|type (it|my own|your own)|enter (it|my own|manually))\b`)

func promisesTyping(label string) bool { return typingOption.MatchString(label) }

func renderQuestion(s *setupModel, th theme.Theme, width int) string {
	q := s.questions[s.qi]
	head := fg(th.Accent2).Bold(true).Render(strings.ToUpper(q.Header))
	if len(s.questions) > 1 {
		head += fg(th.Subtle).Render(fmt.Sprintf("  %d of %d", s.qi+1, len(s.questions)))
	}
	lines := []string{head, fg(th.Text).Bold(true).Render(ansi.Wrap(q.Text, width, "")), ""}
	for i, o := range q.Options {
		mark := "  "
		if i == s.qcur && !s.owning {
			mark = fg(th.Accent2).Render("❯ ")
		}
		box := ""
		if q.Multi {
			box = "[ ] "
			if s.picked[i] {
				box = "[x] "
			}
		}
		label := fg(th.Text).Render(box + o.Label)
		if i == s.qcur && !s.owning {
			label = fg(th.Accent2).Bold(true).Render(box + o.Label)
		}
		lines = append(lines, mark+label)
		if o.Description != "" {
			lines = append(lines, "    "+fg(th.Muted).Render(ansi.Truncate(o.Description, width-4, "…")))
		}
	}
	mark := "  "
	if s.qcur == len(q.Options) {
		mark = fg(th.Accent2).Render("❯ ")
	}
	if s.owning {
		lines = append(lines, mark+s.own.View())
	} else {
		lines = append(lines, mark+fg(th.Muted).Render("type your own…"))
	}
	keys := "↑↓ choose · enter answer · esc just chat"
	if q.Multi {
		keys = "↑↓ move · space pick several · enter answer · esc just chat"
	}
	lines = append(lines, "", fg(th.Subtle).Render(keys))
	return strings.Join(lines, "\n")
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
		case "system":
			b = append(b, fg(th.Muted).Render(ansi.Wrap("✓ "+m.text, width, "")))
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
		b = append(b, fg(th.Muted).Italic(true).Render(spin+" setting it up…"))
	}
	return strings.Join(b, "\n\n")
}

// renderProposal is the plan card beside the chat: a summary of what the form will set up.
func renderProposal(p *rpc.SetupProposal, th theme.Theme, width int) string {
	if p == nil {
		return fg(th.Subtle).Italic(true).Render(ansi.Wrap("The plan appears here once the assistant knows enough: what to consider, who to bring in, and which workstreams to start.", width, ""))
	}
	var lines []string
	if p.Name != "" {
		lines = append(lines, fg(th.Text).Bold(true).Render("#"+p.Name))
	}
	if p.Vision != "" {
		lines = append(lines, fg(th.Muted).Render(ansi.Wrap(p.Vision, width, "")))
	} else if p.Topic != "" {
		lines = append(lines, fg(th.Muted).Render(ansi.Wrap(p.Topic, width, "")))
	}
	section := func(title string, items []string) {
		if len(items) == 0 {
			return
		}
		lines = append(lines, "", sectionTitle(title, width, th, false))
		for _, it := range items {
			lines = append(lines, ansi.Truncate(it, width, "…"))
		}
	}
	section("consider", mapped(p.Considerations, func(c string) string { return fg(th.Text).Render("· " + c) }))
	section("who", mapped(p.Members, func(m rpc.SetupMember) string {
		return fg(th.Text).Bold(true).Render(m.ID) + fg(th.Subtle).Render(" · "+orDefault(strings.TrimSpace(m.CLI+" "+m.Model), "as before")) + webTag(m.Web, th) + fg(th.Muted).Render("  "+m.Role)
	}))
	section("workstreams", mapped(p.Topics, func(t rpc.PlanTopic) string {
		return fg(th.Text).Render("↳ "+t.Title) + fg(th.Subtle).Render("  "+strings.Join(t.Members, ", "))
	}))
	section("reads first", mapped(p.Reading, func(r string) string { return fg(th.Text).Render("▤ " + r) }))
	if p.Steer != "" {
		section("first steer", []string{fg(th.Muted).Render(p.Steer)})
	}
	lines = append(lines, "", fg(th.Accent2).Bold(true).Render("ctrl+s")+fg(th.Muted).Render(" review and apply"))
	return strings.Join(lines, "\n")
}

func mapped[T any](xs []T, f func(T) string) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = f(x)
	}
	return out
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// setupLayout reports whether the plan card sits beside the chat, and how wide each is.
func (a *App) setupLayout() (side bool, chatW, cardW int) {
	if a.w >= 90 {
		cardW = min(max(36, a.w*36/100), 60)
		return true, a.w - cardW - 3, cardW
	}
	return false, a.w - 2, a.w - 2
}

// setupBottom is the input box, or the question card when the assistant asked something.
func (a *App) setupBottom() string {
	s := a.rm.setup
	if s.asking() {
		return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(a.th.Accent2).Padding(0, 1).Width(a.w).Render(renderQuestion(s, a.th, a.w-6))
	}
	return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Width(a.w).
		BorderForegroundBlend(a.th.Accent2, a.th.Accent, a.th.Info, a.th.Speaker(2)).BorderForegroundBlendOffset(a.frame).Render(s.in.View())
}

func (a *App) setupBodyH() int {
	return max(a.h-1-1-lipgloss.Height(a.setupBottom())-1, 6)
}

func (a *App) refreshSetup() {
	s := a.rm.setup
	side, chatW, cardW := a.setupLayout()
	s.in.SetWidth(a.w - 4)
	growInput(&s.in)
	s.own.SetWidth(a.w - 12)
	h := a.setupBodyH()
	if !side && s.proposal != nil {
		h = max(h-lipgloss.Height(renderProposal(s.proposal, a.th, cardW))-2, 4)
	}
	s.vp.SetWidth(chatW)
	s.vp.SetHeight(h)
	s.vp.SetContent(renderSetupChat(s, a.th, chatW, a.spin.View()))
	if s.follow {
		s.vp.GotoBottom()
	}
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
	where := "new channel"
	if s.channel && a.rm.room != nil {
		where = a.rm.room.channelLabel() + sep + fg(a.th.Text).Bold(true).Render("plan next steps")
	}
	header := fg(a.th.Accent2).Render("▓▒░ ") + theme.GradientShift("QUORUM", a.frame/2, a.th.Accent2, a.th.Accent, a.th.Info, a.th.Speaker(2)) +
		fg(a.th.Accent2).Render(" ░▒▓ ") + fg(a.th.Muted).Render(workspaceName(a.opts.Repo)) + sep + fg(a.th.Text).Bold(true).Render(where)
	header = ansi.Truncate(header, a.w, "…")
	if s.form != nil {
		h := max(a.h-1-1-1, 6)
		return lipgloss.JoinVertical(lipgloss.Left, header, "", a.planFormView(h), a.setupFooter())
	}
	side, chatW, cardW := a.setupLayout()
	h := a.setupBodyH()
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
	return lipgloss.JoinVertical(lipgloss.Left, header, "", body, a.setupBottom(), a.setupFooter())
}

func (a *App) setupFooter() string {
	s := a.rm.setup
	k := func(key, what string) string { return fg(a.th.Text).Render(key) + " " + fg(a.th.Muted).Render(what) }
	var keys []string
	switch {
	case s.form != nil:
		keys = []string{k("↑↓", "move"), k("space", "include / leave out"), k("c", "cycle CLI"), k("m", "pick model"), k("enter", "apply"), k("esc", "back")}
	case s.asking():
		keys = []string{k("enter", "answer"), k("esc", "just chat")}
	default:
		keys = []string{k("enter", "send")}
		if s.proposal != nil {
			keys = append(keys, k("ctrl+s", "review and apply"))
		}
		if s.canLeave {
			keys = append(keys, k("esc", "back"))
		}
	}
	keys = append(keys, k("ctrl+c", "quit"))
	return a.withToast(ansi.Truncate(strings.Join(keys, fg(a.th.Subtle).Render(" · ")), a.w, ""))
}

func (a *App) handleSetupKey(k tea.KeyPressMsg) tea.Cmd {
	s := a.rm.setup
	if s.form != nil {
		return a.handlePlanFormKey(k)
	}
	if s.asking() && !s.waiting {
		return a.handleQuestionKey(k)
	}
	switch k.String() {
	case "esc":
		switch {
		case s.channel:
			a.rm.setup = nil
		case s.canLeave && len(a.rm.channels) > 0:
			a.openRoom(a.rm.channels[0].ID)
		}
		return nil
	case "ctrl+s":
		if s.proposal != nil && !s.creating && !s.waiting {
			a.openPlanForm()
		}
		return nil
	case "pgup":
		s.vp.HalfPageUp()
		s.follow = s.vp.AtBottom()
		return nil
	case "pgdown":
		s.vp.HalfPageDown()
		s.follow = s.vp.AtBottom()
		return nil
	case "enter":
		text := strings.TrimSpace(s.in.Value())
		if text == "" || s.waiting || s.creating {
			return nil
		}
		s.in.Reset()
		if paths, ok := strings.CutPrefix(text, "/read "); ok {
			// Lets the assistant read folders outside the project; it can't ask for access itself.
			a.call("setup.read", map[string]any{"paths": strings.Fields(paths)})
			return nil
		}
		s.msgs = append(s.msgs, noteItem{kind: "you", text: text})
		s.waiting, s.follow = true, true
		params := map[string]any{"text": text}
		if imgs := a.takeImages(text); len(imgs) > 0 {
			params["images"] = imgs
		}
		a.call("setup.say", params)
		return nil
	case "alt+enter", "shift+enter":
		s.in.InsertString("\n")
		return nil
	}
	var c tea.Cmd
	s.in, c = s.in.Update(k)
	return c
}

// ---- the plan form: everything the plan sets up, each part included or left out ----

type formRow struct {
	kind  string // vision | consider | member | topic | read | steer
	index int
	on    bool
}

type planForm struct {
	p      rpc.SetupProposal
	rows   []formRow
	cur    int
	vision textarea.Model
	clis   []string // CLIs members can run on
	search *modelSearch
	pickIx int // the member the search is for
}

func (a *App) openPlanForm() {
	s := a.rm.setup
	p := *s.proposal
	p.Members = slices.Clone(p.Members)
	f := &planForm{p: p}
	f.vision = newInput(a.th, 3)
	f.vision.SetValue(p.Vision)
	add := func(kind string, n int) {
		for i := 0; i < n; i++ {
			f.rows = append(f.rows, formRow{kind: kind, index: i, on: true})
		}
	}
	if p.Vision != "" || !s.channel {
		f.rows = append(f.rows, formRow{kind: "vision", on: true})
	}
	add("consider", len(p.Considerations))
	add("member", len(p.Members))
	add("topic", len(p.Topics))
	add("read", len(p.Reading))
	if p.Steer != "" {
		f.rows = append(f.rows, formRow{kind: "steer", on: true})
	}
	if a.opts.Mock {
		f.clis = []string{"mock"}
	} else if s.channel && a.rm.room != nil && len(a.rm.room.clis) > 0 {
		f.clis = a.rm.room.clis
	} else {
		a.call("clis.list", map[string]any{})
	}
	s.form = f
	f.focusVision()
}

func (f *planForm) focusVision() {
	if f.cur < len(f.rows) && f.rows[f.cur].kind == "vision" {
		f.vision.Focus()
	} else {
		f.vision.Blur()
	}
}

// planResponse takes answers meant for the plan form. It reports whether it took the method.
func (a *App) planResponse(method string, r rpc.Response) bool {
	if a.rm == nil || a.rm.setup == nil || a.rm.setup.form == nil {
		return false
	}
	f := a.rm.setup.form
	switch method {
	case "clis.list":
		var cs []rpc.CLIInfo
		if r.Err == "" && rpc.DecodeResult(r.Result, &cs) == nil {
			for _, c := range cs {
				if c.Usable {
					f.clis = append(f.clis, c.CLI)
				}
			}
		}
	default:
		return false
	}
	return true
}

func (a *App) handlePlanFormKey(k tea.KeyPressMsg) tea.Cmd {
	s := a.rm.setup
	f := s.form
	key := k.String()
	if f.search != nil {
		if key == "esc" {
			f.search = nil
			return nil
		}
		pick, done, fav, cmd := f.search.key(k)
		a.starred(fav)
		if done {
			a.picked(pick)
			f.p.Members[f.pickIx].CLI, f.p.Members[f.pickIx].Model = pick.harness, pick.model
			f.search = nil
		}
		return cmd
	}
	row := &f.rows[f.cur]
	switch key {
	case "esc":
		s.form = nil
		return s.in.Focus()
	case "up":
		f.cur = max(f.cur-1, 0)
		f.focusVision()
		return nil
	case "down", "tab":
		f.cur = min(f.cur+1, len(f.rows)-1)
		f.focusVision()
		return nil
	case "enter":
		a.applyPlan()
		return nil
	}
	if row.kind == "vision" {
		if key == "alt+enter" || key == "shift+enter" {
			f.vision.InsertString("\n")
			return nil
		}
		var c tea.Cmd
		f.vision, c = f.vision.Update(k)
		return c
	}
	switch key {
	case "space":
		row.on = !row.on
	case "c":
		if row.kind == "member" && len(f.clis) > 0 {
			m := &f.p.Members[row.index]
			m.CLI, m.Model = f.clis[(slices.Index(f.clis, m.CLI)+1)%len(f.clis)], ""
		}
	case "m":
		if row.kind == "member" {
			m := f.p.Members[row.index]
			f.search, f.pickIx = a.openSearch(f.clis, m.CLI, m.Model), row.index
		}
	}
	return nil
}

// applyPlan sends the plan as edited: only what's still included.
func (a *App) applyPlan() {
	s := a.rm.setup
	f := s.form
	p := rpc.SetupProposal{Name: f.p.Name, Topic: f.p.Topic, Considerations: []string{}, Reading: []string{}, Members: []rpc.SetupMember{}, Topics: []rpc.PlanTopic{}}
	dropped := map[string]bool{}
	for _, r := range f.rows {
		switch r.kind {
		case "vision":
			if r.on {
				p.Vision = strings.TrimSpace(f.vision.Value())
			}
		case "consider":
			if r.on {
				p.Considerations = append(p.Considerations, f.p.Considerations[r.index])
			}
		case "member":
			if r.on {
				p.Members = append(p.Members, f.p.Members[r.index])
			} else {
				dropped[f.p.Members[r.index].ID] = true
			}
		case "topic":
			if r.on {
				p.Topics = append(p.Topics, f.p.Topics[r.index])
			}
		case "read":
			if r.on {
				p.Reading = append(p.Reading, f.p.Reading[r.index])
			}
		case "steer":
			if r.on {
				p.Steer = f.p.Steer
			}
		}
	}
	// A workstream can't be owned by someone who was left out.
	for i := range p.Topics {
		p.Topics[i].Members = slices.DeleteFunc(slices.Clone(p.Topics[i].Members), func(m string) bool { return dropped[m] })
	}
	if !s.channel && len(p.Members) == 0 {
		s.msgs = append(s.msgs, noteItem{kind: "error", text: "a new channel needs at least one member"})
		s.form = nil
		return
	}
	s.form, s.creating = nil, true
	a.call("setup.create", map[string]any{"proposal": &p})
}

func (a *App) planFormView(height int) string {
	s := a.rm.setup
	f := s.form
	w := min(a.w-4, 110)
	th := a.th
	if f.search != nil {
		m := f.p.Members[f.pickIx]
		w = min(a.w-4, 140)
		body := sectionTitle("model for "+m.ID, w, th, true) + "\n\n" + f.search.view(th, w, a.spin.View()) + "\n\n" + fg(th.Subtle).Render("type to search · ↑↓ choose · tab harness · enter use it · alt+f star · esc back")
		return lipgloss.NewStyle().Padding(0, 2).Height(height).MaxHeight(height).Render(body)
	}
	f.vision.SetWidth(w - 8)
	lines := []string{sectionTitle("the plan", w, th, true), fg(th.Muted).Render("Leave out anything you don't want; ask the assistant for bigger changes."), ""}
	last := ""
	titles := map[string]string{"vision": "vision", "consider": "to consider", "member": "who joins", "topic": "workstreams", "read": "reads first", "steer": "first steer"}
	for i, r := range f.rows {
		if r.kind != last {
			if last != "" {
				lines = append(lines, "")
			}
			lines = append(lines, fg(th.Info).Bold(true).Render(strings.ToUpper(titles[r.kind])))
			last = r.kind
		}
		mark := "  "
		if i == f.cur {
			mark = fg(th.Accent2).Render("❯ ")
		}
		box := fg(th.Subtle).Render("[ ] ")
		if r.on {
			box = fg(th.OK).Render("[x] ")
		}
		var text string
		switch r.kind {
		case "vision":
			// The vision is edited in place, indented under its checkbox.
			lines = append(lines, mark+box+fg(th.Muted).Render("pinned for every member; type to edit"))
			for _, l := range strings.Split(f.vision.View(), "\n") {
				lines = append(lines, "      "+l)
			}
			continue
		case "consider":
			text = f.p.Considerations[r.index]
		case "member":
			m := f.p.Members[r.index]
			model := orDefault(strings.TrimSpace(m.CLI+" "+m.Model), "as before")
			text = fg(th.Text).Bold(true).Render(m.ID) + fg(th.Muted).Render("  "+m.Role) + fg(th.Accent).Render("  "+model) + webTag(m.Web, th)
		case "topic":
			t := f.p.Topics[r.index]
			text = t.Title + fg(th.Subtle).Render("  "+strings.Join(t.Members, ", "))
			if t.Done != "" {
				text += fg(th.Muted).Render("  · done when " + t.Done)
			}
		case "read":
			text = "▤ " + f.p.Reading[r.index]
		case "steer":
			text = f.p.Steer
		}
		lines = append(lines, ansi.Truncate(mark+box+text, w, "…"))
	}
	// Keep the cursor's row on screen.
	start := 0
	for i, l := range lines {
		if strings.Contains(l, "❯") && i >= height-2 {
			start = i - height + 3
		}
	}
	if start > 0 {
		lines = lines[start:]
	}
	return lipgloss.NewStyle().Padding(0, 2).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}

// webTag marks a member who may search the web.
func webTag(on bool, th theme.Theme) string {
	if !on {
		return ""
	}
	return fg(th.Info).Render(" +web")
}
