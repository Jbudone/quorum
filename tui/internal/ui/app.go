// Package ui is Quorum's terminal interface (Bubble Tea v2).
package ui

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

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
	Calm     bool // no animation: diagrams show their final frame
	// Council opens the round-based council instead of the room (quorum --council).
	Council bool
}

type screen int

const (
	screenStart screen = iota
	screenSession
	screenRoom
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

	start           startModel
	loaded          bool // presets received
	engineErr       string
	selectAfterLoad string // preset to highlight once presets.list is re-read (after a save)

	sess       *session
	rm         *roomUI // the room screen, when one is open
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
	frame      int    // animation clock
	sideTop    string // roster, notes and plan title, rebuilt in refresh
}

// animFPS is the animation clock. Every effect is counted in these ticks, so raising it speeds
// them all up together (10 was the original pace; 24 is about 2.4x). QUORUM_FPS overrides it.
func animFPS() int {
	if v, err := strconv.Atoi(os.Getenv("QUORUM_FPS")); err == nil && v >= 5 && v <= 60 {
		return v
	}
	return 24
}

// animStep is how many animation ticks pass per clock tick (QUORUM_SPEED, default 2): the clock
// keeps its smooth redraw rate while every effect plays that many times faster.
func animStep() int {
	if v, err := strconv.Atoi(os.Getenv("QUORUM_SPEED")); err == nil && v >= 1 && v <= 8 {
		return v
	}
	return 2
}

// animSpinner is the dot spinner stretched so its glyph still turns at a calm ~8 steps a second
// while the clock ticks faster.
func animSpinner() spinner.Spinner {
	fps := animFPS()
	rep := max(fps/8, 1)
	var frames []string
	for _, f := range spinner.Dot.Frames {
		for i := 0; i < rep; i++ {
			frames = append(frames, f)
		}
	}
	return spinner.Spinner{Frames: frames, FPS: time.Second / time.Duration(fps)}
}

// New builds the app.
func New(o Options) *App {
	sp := spinner.New(spinner.WithSpinner(animSpinner()))
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
	if a.opts.Council {
		a.call("presets.list", map[string]any{})
		a.call("personas.list", map[string]any{})
		a.call("clis.list", map[string]any{})
	} else {
		// The room is the app: reopen this repo's latest room, or start an empty one.
		a.newRoomUI("opening")
		a.call("rooms.list", map[string]any{"repo": a.opts.Repo})
	}
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
		return true // the banner animates
	}
	if a.screen == screenRoom {
		return a.rm != nil && (a.rm.room == nil || a.rm.room.animating())
	}
	s := a.sess
	return s != nil && (s.animating() || s.phase == phaseStarting || s.phase == phaseRunning || s.busy() || s.anyThinking())
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
		a.frame += animStep()
		if a.sess != nil {
			a.sess.frame = a.frame
		}
		if a.rm != nil && a.rm.room != nil {
			a.rm.room.frame = a.frame
		}
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
		if a.screen == screenRoom {
			a.roomWheel(m)
			a.refresh()
			return a, nil
		}
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
	if a.screen == screenRoom && a.rm != nil && a.rm.room != nil {
		var c tea.Cmd
		if a.rm.room.pane == paneAssistant {
			a.rm.assistIn, c = a.rm.assistIn.Update(msg)
		} else {
			a.rm.roomIn, c = a.rm.roomIn.Update(msg)
		}
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
		if a.screen == screenRoom && a.rm != nil {
			if a.rm.room != nil {
				a.rm.room.apply(v)
			}
			return nil
		}
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
	if a.handleRoomResponse(method, r) {
		return
	}
	if r.Err != "" {
		switch {
		case method == "session.start":
			// Nothing started, so go back and let the user adjust.
			a.sess, a.screen = nil, screenStart
			a.start.err = r.Err
		case method == "council.design":
			a.start.designing = false
			a.start.err = r.Err
		case method == "presets.save" && a.start.drawer != nil:
			a.start.drawer.err = r.Err
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
		if a.selectAfterLoad != "" {
			for i, p := range ps {
				if p.Name == a.selectAfterLoad {
					a.start.cursor = i
				}
			}
			a.selectAfterLoad = ""
		}
		a.start.cursor = min(a.start.cursor, max(len(ps)-1, 0))
	case "personas.list":
		var ps []rpc.Persona
		if err := rpc.DecodeResult(r.Result, &ps); err != nil {
			a.fail("bad personas from engine: " + err.Error())
			return
		}
		a.start.personas = ps
	case "clis.list":
		var cs []rpc.CLIInfo
		if err := rpc.DecodeResult(r.Result, &cs); err != nil {
			a.fail("bad CLI list from engine: " + err.Error())
			return
		}
		a.start.clis = cs
	case "council.design":
		var dr rpc.DesignResult
		if err := rpc.DecodeResult(r.Result, &dr); err != nil {
			a.start.designing = false
			a.fail("bad council design from engine: " + err.Error())
			return
		}
		if a.start.designing { // not cancelled meanwhile
			a.start.applyDesign(dr)
		}
	case "presets.save":
		var sr rpc.SaveResult
		if err := rpc.DecodeResult(r.Result, &sr); err != nil {
			a.fail("bad save result from engine: " + err.Error())
			return
		}
		delete(a.start.drafts, a.start.savingFrom)
		a.start.drawer = nil
		a.start.notice = "Saved “" + sr.Name + "”. It will be listed with the others."
		a.selectAfterLoad = sr.Name
		a.call("presets.list", map[string]any{})
		a.call("personas.list", map[string]any{})
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
	if a.screen == screenRoom {
		return a.handleRoomKey(k)
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
		if s.canType() && s.qa.active {
			s.qa.active = false
			s.system("Skipped the open questions. Press Enter to continue to the next round.")
		}
		return nil
	case "ctrl+r":
		if !s.replay() {
			s.system("No diagram to replay yet.")
		}
		return nil
	case "ctrl+o":
		s.full = !s.full
		for _, e := range s.entries {
			e.cacheW = 0
		}
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
	if it := s.currentItem(); it != nil && len(it.options) > 0 && s.canType() {
		empty := strings.TrimSpace(a.input.Value()) == ""
		switch {
		case key == "up":
			s.moveOption(-1)
			return nil
		case key == "down":
			s.moveOption(1)
			return nil
		case key == "space" && empty:
			s.pickOption(s.qa.cursor)
			return nil
		case empty && len(key) == 1 && key[0] >= '1' && key[0] <= '9':
			s.pickOption(int(key[0] - '1'))
			return nil
		}
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
	a.start.notice = ""
	start, c := a.start.update(k)
	if name := a.start.saveReq; name != "" {
		a.start.saveReq = ""
		a.start.savingFrom = a.start.drawer.base.Name
		a.call("presets.save", map[string]any{"name": name, "config": a.start.drawer.wire(name)})
	}
	if a.start.designReq {
		a.start.designReq = false
		params := map[string]any{"topic": strings.TrimSpace(a.start.topic.Value()), "repo": a.opts.Repo}
		if a.start.mock {
			params["mock"] = true
		}
		a.call("council.design", params)
		return c
	}
	if !start {
		return c
	}
	params := a.start.startParams(a.opts.Repo)
	p := a.start.effective()
	a.sess = newSession(p, a.opts.Repo, params["topic"].(string), 0)
	a.sess.calm = a.opts.Calm
	delete(a.start.drafts, "auto") // a designed council is for this topic only
	a.sess.add(&entry{kind: kindHuman, to: "the council", text: a.sess.topic})
	a.sess.splashAt = a.frame
	a.sess.add(&entry{kind: kindArt, diagramAt: a.sess.frame})
	a.screen = screenSession
	a.follow = true
	a.input.Reset()
	a.call("session.start", params)
	return nil
}

// submit acts on the input line at a pause.
func (a *App) submit() tea.Cmd {
	s := a.sess
	if q, ok := s.currentQuestion(); ok && !strings.HasPrefix(strings.TrimSpace(a.input.Value()), "/") {
		return a.answerQuestion(q)
	}
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
		s.system("Enter continues the next round. Type to ask the Chair, @name to ask one member, /steer <directive> to guide the next round, /pause round|message|auto and /rounds N to retune the pacing, /stop to finish now, /plan to show the plan, ctrl+r to replay the latest diagram.")
		a.input.Reset()
		return nil
	case "configure":
		a.call("session.configure", cmd.params)
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

// answerQuestion sends the typed answer as a decision (empty input skips the question).
func (a *App) answerQuestion(q string) tea.Cmd {
	s := a.sess
	typed := strings.TrimSpace(a.input.Value())
	ans := strings.Join(s.chosen(), ", ")
	if typed != "" {
		if ans != "" {
			ans += " — "
		}
		ans += typed
	}
	if s.qa.entry != nil {
		s.qa.entry.answer, s.qa.entry.cacheW = ans, 0
	}
	if ans != "" {
		s.add(&entry{kind: kindHuman, to: "the council", text: ans})
		a.call("session.steer", map[string]any{"text": ans, "question": q})
	}
	a.input.Reset()
	a.follow = true
	if !s.nextQuestion() {
		s.system("That is every open question. Press Enter to continue to the next round, or keep talking to the Chair.")
	}
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
	if a.screen == screenRoom {
		a.refreshRoom()
		return
	}
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
	case a.sess.canType() && a.sess.qa.active:
		a.input.Placeholder = "Your answer to the open question — Enter alone skips it, Esc skips them all"
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
		if _, asking := a.sess.currentQuestion(); asking && !strings.HasPrefix(a.input.Value(), "/") {
			return fg(a.th.Warn).Bold(true).Render(fmt.Sprintf("%-8s", "answer")) + fg(a.th.Subtle).Render("▸ ")
		}
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
		content = a.start.view(a.th, a.w, a.h, repo, !a.loaded && a.engineErr == "", a.spin.View(), a.frame)
		if a.engineErr != "" {
			content = lipgloss.JoinVertical(lipgloss.Left, content, fg(a.th.Err).Render("✗ "+a.engineErr))
		}
	} else if a.screen == screenRoom && a.rm != nil {
		content = a.roomView()
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
	if s.showSplash() {
		pic := renderSpriteLoop(s.sprite, s.topic, a.w-4, a.th, s.frame-s.splashAt, !s.calm, true)
		wait := fg(a.th.Muted).Italic(true).Render(spin + " convening the council…")
		if s.firstTurn {
			wait = fg(a.th.OK).Render("✓ the council is talking")
		}
		body = lipgloss.Place(a.w, a.bodyH(), lipgloss.Center, lipgloss.Center, pic+"\n\n"+wait)
	} else if a.wide() {
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
	boxStyle := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(border).Width(a.w)
	if s.canType() {
		boxStyle = boxStyle.BorderForegroundBlend(a.th.Accent2, a.th.Accent, a.th.Info, a.th.Speaker(2)).BorderForegroundBlendOffset(a.frame)
	}
	box := boxStyle.Render(a.input.View())
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
