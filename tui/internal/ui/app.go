// Package ui is Quorum's terminal interface (Bubble Tea v2).
package ui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// Caller sends requests to the engine; *rpc.Client satisfies it and tests fake it.
type Caller interface {
	Call(method string, params any) (int, error)
	Close()
}

// Options configures the app.
type Options struct {
	Client Caller
	// Messages is the engine's ordered output stream (nil in tests that inject messages directly).
	Messages <-chan rpc.Message
	Repo     string
	Mock     bool
}

type screen int

const (
	screenStart screen = iota
	screenSession
)

type focusPane int

const (
	focusTranscript focusPane = iota
	focusPlan
)

const (
	sidebarMin   = 104 // below this width the sidebar collapses and the plan swaps with the transcript
	sidebarWidth = 42
	inputRows    = 3
)

// engineMsg wraps an rpc message so it can travel through Bubble Tea.
type engineMsg struct{ m rpc.Message }

// App is the root Bubble Tea model.
type App struct {
	th     theme.Theme
	opts   Options
	w, h   int
	screen screen

	start     startModel
	loaded    bool // presets received
	engineErr string

	sess       *session
	reqs       map[int]string
	input      textarea.Model
	transcript viewport.Model
	planVP     viewport.Model
	follow     bool // keep the transcript pinned to the newest message
	focus      focusPane
	showPlan   bool // narrow layout: show the plan instead of the transcript
	spin       spinner.Model
	ticking    bool
	quitting   bool
	help       bool
	sideTop    string // roster, notes and plan title, rebuilt in refresh
}

// New builds the app.
func New(o Options) *App {
	sp := spinner.New(spinner.WithSpinner(spinner.Dot))
	th := theme.Default()
	in := newInput(th, inputRows)
	a := &App{
		th: th, opts: o, w: 100, h: 30,
		start: newStart(th, o.Mock), reqs: map[int]string{}, spin: sp,
		input: in, follow: true,
		transcript: viewport.New(), planVP: viewport.New(),
	}
	a.transcript.MouseWheelEnabled = true
	a.planVP.MouseWheelEnabled = true
	return a
}

func (a *App) Init() tea.Cmd {
	a.call("presets.list", map[string]any{})
	return tea.Batch(a.listen(), a.tick())
}

// listen waits for the next engine message.
func (a *App) listen() tea.Cmd {
	if a.opts.Messages == nil {
		return nil
	}
	ch := a.opts.Messages
	return func() tea.Msg {
		m, ok := <-ch
		if !ok {
			return engineMsg{rpc.ExitMsg{}}
		}
		return engineMsg{m}
	}
}

func (a *App) call(method string, params any) {
	id, err := a.opts.Client.Call(method, params)
	if err != nil {
		a.fail(err.Error())
		if a.sess != nil && isJob(method) {
			a.sess.endJob()
		}
		return
	}
	a.reqs[id] = method
}

// isJob reports whether the engine will answer a request with an idle event when it finishes.
func isJob(method string) bool { return method == "session.continue" || method == "session.interject" }

func (a *App) fail(msg string) {
	if a.sess != nil {
		a.sess.add(&entry{kind: kindError, text: msg})
		return
	}
	a.engineErr = msg
	a.start.err = msg
}

// needsTick reports whether something on screen is animating.
func (a *App) needsTick() bool {
	if a.screen == screenStart {
		return !a.loaded && a.engineErr == ""
	}
	s := a.sess
	return s != nil && (s.phase == phaseStarting || s.phase == phaseRunning || s.busy() || s.anyThinking())
}

func (a *App) tick() tea.Cmd {
	if a.ticking || !a.needsTick() {
		return nil
	}
	a.ticking = true
	return a.spin.Tick
}

// ---- update ----

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case tea.WindowSizeMsg:
		a.w, a.h = m.Width, m.Height
		a.refresh()
		return a, nil

	case spinner.TickMsg:
		a.ticking = false
		var c tea.Cmd
		a.spin, c = a.spin.Update(m)
		a.refresh()
		if !a.needsTick() {
			return a, nil
		}
		a.ticking = true
		return a, c

	case engineMsg:
		c := a.handleEngine(m.m)
		a.refresh()
		return a, tea.Batch(a.listen(), c, a.tick())

	case tea.MouseWheelMsg:
		a.scroll(m)
		return a, nil

	case tea.KeyPressMsg:
		c := a.handleKey(m)
		a.refresh()
		if a.quitting {
			a.opts.Client.Close()
			return a, tea.Quit
		}
		return a, tea.Batch(c, a.tick())
	}
	if a.screen == screenStart && a.start.focus == 1 {
		var c tea.Cmd
		a.start.topic, c = a.start.topic.Update(msg)
		return a, c
	}
	if a.screen == screenSession && a.sess.canType() {
		var c tea.Cmd
		a.input, c = a.input.Update(msg)
		return a, c
	}
	return a, nil
}

func (a *App) handleEngine(m rpc.Message) tea.Cmd {
	switch v := m.(type) {
	case rpc.ExitMsg:
		a.fail("The engine stopped unexpectedly.")
		if a.sess != nil {
			a.sess.phase = phaseDone
		}
	case rpc.Response:
		a.handleResponse(v)
	case rpc.Event:
		if a.sess != nil {
			a.sess.apply(v)
			if v.Name == "awaiting_human" || v.Name == "idle" {
				if a.sess.canType() {
					return a.input.Focus()
				}
			}
		} else if e, ok := v.Data.(rpc.EngineError); ok {
			a.fail(e.Message)
		}
	}
	return nil
}

func (a *App) handleResponse(r rpc.Response) {
	method := a.reqs[r.ID]
	delete(a.reqs, r.ID)
	if r.Err != "" {
		switch {
		case method == "session.start":
			// Nothing started, so go back and let the user adjust.
			a.sess, a.screen = nil, screenStart
			a.start.err = r.Err
		case isJob(method):
			a.fail(r.Err)
			if a.sess != nil {
				a.sess.endJob()
			}
		default:
			a.fail(r.Err)
		}
		return
	}
	switch method {
	case "presets.list":
		var ps []rpc.Preset
		if err := rpc.DecodeResult(r.Result, &ps); err != nil {
			a.fail("bad presets from engine: " + err.Error())
			return
		}
		a.start.presets, a.loaded = ps, true
	case "session.start":
		var sr rpc.StartResult
		if err := rpc.DecodeResult(r.Result, &sr); err != nil {
			a.fail("bad start result from engine: " + err.Error())
			return
		}
		a.sess.applyStart(sr)
		a.sess.startJob()
		a.call("session.continue", map[string]any{})
	}
}

func (a *App) handleKey(k tea.KeyPressMsg) tea.Cmd {
	key := k.String()
	if key == "ctrl+c" {
		a.quitting = true
		return nil
	}
	if a.screen == screenStart {
		return a.handleStartKey(k)
	}
	s := a.sess
	switch key {
	case "ctrl+p":
		if a.wide() {
			a.focus = focusPlan - a.focus
		} else {
			a.showPlan = !a.showPlan
		}
		return nil
	case "tab":
		if a.wide() {
			a.focus = focusPlan - a.focus
		} else {
			a.showPlan = !a.showPlan
		}
		return nil
	case "pgup", "ctrl+u":
		a.scrollKey(-1, true)
		return nil
	case "pgdown", "ctrl+d":
		a.scrollKey(1, true)
		return nil
	case "ctrl+x":
		if s.phase == phaseRunning || s.busy() {
			a.call("session.abort", map[string]any{})
			s.system("Stopping the current turn…")
		}
		return nil
	case "esc":
		a.help = false
		return nil
	}
	if s.phase == phaseDone {
		switch key {
		case "q":
			a.quitting = true
		case "n":
			a.newSession()
		case "up", "k":
			a.scrollKey(-1, false)
		case "down", "j":
			a.scrollKey(1, false)
		}
		return nil
	}
	if !s.canType() {
		switch key {
		case "up":
			a.scrollKey(-1, false)
		case "down":
			a.scrollKey(1, false)
		}
		return nil
	}
	if key == "enter" {
		return a.submit()
	}
	if key == "alt+enter" || key == "shift+enter" {
		a.input.InsertString("\n")
		return nil
	}
	var c tea.Cmd
	a.input, c = a.input.Update(k)
	return c
}

func (a *App) handleStartKey(k tea.KeyPressMsg) tea.Cmd {
	start, c := a.start.update(k)
	if !start {
		return c
	}
	p, _ := a.start.selected()
	params := a.start.startParams(a.opts.Repo)
	a.sess = newSession(p, a.opts.Repo, params["topic"].(string), a.start.rounds)
	a.sess.add(&entry{kind: kindHuman, to: "the council", text: a.sess.topic})
	a.screen = screenSession
	a.follow = true
	a.input.Reset()
	a.call("session.start", params)
	return nil
}

// submit acts on the input line at a pause.
func (a *App) submit() tea.Cmd {
	s := a.sess
	cmd := s.parseInput(a.input.Value())
	switch cmd.kind {
	case "error":
		s.add(&entry{kind: kindError, text: cmd.error})
		return nil
	case "plan":
		a.showPlan = !a.showPlan
		a.input.Reset()
		return nil
	case "help":
		s.system("Enter continues the next round. Type to ask the Chair, @name to ask one member, /steer <directive> to guide the next round, /stop to finish now, /plan to show the plan.")
		a.input.Reset()
		return nil
	case "continue":
		s.startJob()
		a.call("session.continue", map[string]any{})
	case "stop":
		s.startJob()
		a.call("session.continue", map[string]any{"stop": true})
	case "steer":
		s.add(&entry{kind: kindHuman, to: "next round", text: cmd.text})
		a.call("session.steer", map[string]any{"text": cmd.text})
	case "ask":
		s.startJob()
		s.add(&entry{kind: kindHuman, to: cmd.to, text: cmd.text})
		a.call("session.interject", map[string]any{"to": cmd.to, "text": cmd.text})
	}
	a.input.Reset()
	a.follow = true
	return nil
}

func (a *App) newSession() {
	a.sess = nil
	a.screen = screenStart
	a.start.topic.Reset()
	a.start.focus = 1
	a.follow = true
}

// ---- layout & scrolling ----

func (a *App) wide() bool { return a.w >= sidebarMin }

func (a *App) sidebarW() int {
	if a.wide() {
		return sidebarWidth
	}
	return 0
}

func (a *App) mainW() int {
	if a.sidebarW() == 0 {
		return a.w
	}
	return a.w - a.sidebarW() - 1
}

func (a *App) bodyH() int {
	h := a.h - 1 - 1 - (inputRows + 2) - 1 // header, footer, input box, spacer
	if h < 3 {
		h = 3
	}
	return h
}

func (a *App) scroll(m tea.MouseWheelMsg) {
	vp := &a.transcript
	if a.wide() && m.Mouse().X >= a.mainW() {
		vp = &a.planVP
	} else if !a.wide() && a.showPlan {
		vp = &a.planVP
	}
	if m.Mouse().Button == tea.MouseWheelUp {
		vp.ScrollUp(3)
	} else if m.Mouse().Button == tea.MouseWheelDown {
		vp.ScrollDown(3)
	}
	if vp == &a.transcript {
		a.follow = a.transcript.AtBottom()
	}
}

func (a *App) activeVP() *viewport.Model {
	if (a.wide() && a.focus == focusPlan) || (!a.wide() && a.showPlan) {
		return &a.planVP
	}
	return &a.transcript
}

func (a *App) scrollKey(dir int, page bool) {
	vp := a.activeVP()
	switch {
	case dir < 0 && page:
		vp.HalfPageUp()
	case dir > 0 && page:
		vp.HalfPageDown()
	case dir < 0:
		vp.ScrollUp(1)
	default:
		vp.ScrollDown(1)
	}
	if vp == &a.transcript {
		a.follow = a.transcript.AtBottom()
	}
}

// refresh recomputes sizes and content after any state change.
func (a *App) refresh() {
	if a.screen != screenSession || a.sess == nil {
		return
	}
	mw, bh := a.mainW(), a.bodyH()
	a.transcript.SetWidth(mw)
	a.transcript.SetHeight(bh)
	a.transcript.SetContent(renderTranscript(a.sess, a.th, mw, a.spin.View()))
	if a.follow {
		a.transcript.GotoBottom()
	}

	pw, ph := a.layoutSide()
	a.planVP.SetWidth(pw)
	a.planVP.SetHeight(ph)
	if a.sess.plan == "" {
		a.planVP.SetContent(fg(a.th.Muted).Italic(true).Render("The plan will appear here once the drafter has written the first version."))
	} else {
		a.planVP.SetContent(renderMarkdown(a.sess.plan, pw, a.th))
	}

	a.input.SetWidth(a.w - 6)
	switch {
	case a.sess.canType():
		a.input.Placeholder = "Ask the Chair, @name to ask one member, /steer to guide — or press Enter to continue"
	case a.sess.phase == phaseDone:
		a.input.Placeholder = "Session complete."
	default:
		a.input.Placeholder = "The council is deliberating…"
	}
	a.input.SetPromptFunc(10, func(pi textarea.PromptInfo) string {
		if pi.LineNumber != 0 {
			return strings.Repeat(" ", 10)
		}
		target := "chair"
		if v := a.input.Value(); strings.HasPrefix(v, "@") {
			target = strings.ToLower(strings.TrimPrefix(strings.Fields(v + " ")[0], "@"))
		} else if strings.HasPrefix(v, "/") {
			target = "cmd"
		}
		c := a.th.Chair
		if target != "chair" && target != "cmd" {
			c = a.sess.memberColor(a.th, target)
		}
		return fg(c).Bold(true).Render(fmt.Sprintf("%-8s", target)) + fg(a.th.Subtle).Render("▸ ")
	})
}

// layoutSide builds the sidebar header (roster, notes, plan title) and returns the plan viewport size.
func (a *App) layoutSide() (int, int) {
	if !a.wide() {
		return a.w, max(a.bodyH()-1, 3)
	}
	s := a.sess
	w := a.sidebarW() - 2
	roster := renderRoster(s, a.th, w, a.spin.View())
	parts := []string{roster}
	if free := a.bodyH() - lipgloss.Height(roster) - 3 - 6; free > 4 {
		if notes := renderNotes(s, a.th, w, free); notes != "" {
			parts = append(parts, notes)
		}
	}
	title := "Plan"
	if s.planRev > 0 {
		title = fmt.Sprintf("Plan · revision %d", s.planRev)
	}
	parts = append(parts, "", sectionTitle(title, w, a.th, a.focus == focusPlan))
	a.sideTop = strings.Join(parts, "\n")
	return w, max(a.bodyH()-lipgloss.Height(a.sideTop), 3)
}

// ---- view ----

func (a *App) View() tea.View {
	var content string
	if a.screen == screenStart {
		repo := a.opts.Repo
		content = a.start.view(a.th, a.w, a.h, repo, !a.loaded && a.engineErr == "", a.spin.View())
		if a.engineErr != "" {
			content = lipgloss.JoinVertical(lipgloss.Left, content, fg(a.th.Err).Render("✗ "+a.engineErr))
		}
	} else {
		content = a.sessionView()
	}
	v := tea.NewView(content)
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	v.WindowTitle = "Quorum"
	return v
}

func (a *App) sessionView() string {
	s := a.sess
	spin := a.spin.View()
	header := renderHeader(s, a.th, a.w, spin)

	var body string
	if a.wide() {
		body = lipgloss.JoinHorizontal(lipgloss.Top,
			lipgloss.NewStyle().Width(a.mainW()).Height(a.bodyH()).Render(a.transcript.View()),
			lipgloss.NewStyle().Foreground(a.th.Subtle).Render(strings.TrimRight(strings.Repeat("│\n", a.bodyH()), "\n")),
			a.sidebar(),
		)
	} else if a.showPlan {
		body = lipgloss.NewStyle().Width(a.w).Height(a.bodyH()).Render(
			sectionTitle(fmt.Sprintf("Plan (revision %d)", s.planRev), a.w, a.th, true) + "\n" + a.planVP.View())
	} else {
		body = lipgloss.NewStyle().Width(a.w).Height(a.bodyH()).Render(a.transcript.View())
	}

	border := a.th.Border
	if s.canType() {
		border = a.th.Accent
	}
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(border).Width(a.w).Render(a.input.View())
	footer := footerHint(s, a.th, a.w)
	return lipgloss.JoinVertical(lipgloss.Left, header, "", body, box, footer)
}

func (a *App) sidebar() string {
	return lipgloss.NewStyle().Width(a.sidebarW()).Height(a.bodyH()).PaddingLeft(1).Render(a.sideTop + "\n" + a.planVP.View())
}

// Run starts the program.
func Run(o Options) error {
	p := tea.NewProgram(New(o))
	_, err := p.Run()
	return err
}
