package ui

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// roomUI is the room screen's own widgets, kept apart from the council session's. It shows either
// the setup chat (no channel yet) or a channel.
type roomUI struct {
	room       *roomModel
	setup      *setupModel
	join       *joinModal         // the add-member modal, when open
	channels   []rpc.RoomListItem // the workspace's channels, for the switcher
	feedVP     viewport.Model
	assistVP   viewport.Model
	overlayVP  viewport.Model
	roomIn     textarea.Model
	assistIn   textarea.Model
	feedFollow bool
	asstFollow bool
	hideStats  bool
	opening    string // what we're waiting for ("opening", "reopening"); "" once something is on screen
	err        string // why nothing could be opened
	switching  bool   // a workspace.open is for the switcher
	openThread bool   // the next room.post answer is an /ask: show its thread
}

const (
	roomSideMin   = 64 // below this the assistant sits under the feed instead of beside it
	roomInputRows = 2
)

func workspaceName(repo string) string { return filepath.Base(repo) }

func (a *App) newRoomUI(opening string) {
	in := newInput(a.th, roomInputRows)
	as := newInput(a.th, roomInputRows)
	as.Placeholder = "Ask your assistant anything…"
	var channels []rpc.RoomListItem
	if a.rm != nil {
		channels = a.rm.channels
	}
	a.rm = &roomUI{
		feedVP: viewport.New(), assistVP: viewport.New(), overlayVP: viewport.New(),
		roomIn: in, assistIn: as, feedFollow: true, asstFollow: true, opening: opening, channels: channels,
	}
	a.rm.feedVP.MouseWheelEnabled = true
	a.rm.assistVP.MouseWheelEnabled = true
	a.rm.roomIn.Focus()
	a.screen = screenRoom
}

// startSetup opens the setup chat for a new channel; the channel on screen (if any) pauses meanwhile.
func (a *App) startSetup() {
	if a.rm != nil && a.rm.room != nil && a.rm.room.state != "paused" {
		a.call("room.pause", map[string]any{"reason": "switched away"})
	}
	canLeave := a.rm != nil && len(a.rm.channels) > 0
	a.newRoomUI("")
	a.rm.setup = newSetup(a.th, canLeave)
	params := map[string]any{"repo": a.opts.Repo}
	if a.opts.Mock {
		params["mock"] = true
	}
	a.call("setup.start", params)
}

func (a *App) openRoom(id string) {
	a.newRoomUI("reopening")
	a.call("room.open", map[string]any{"repo": a.opts.Repo, "id": id})
}

// handleRoomResponse handles answers to workspace, setup and room requests. It reports whether it took the method.
func (a *App) handleRoomResponse(method string, r rpc.Response) bool {
	if a.joinResponse(method, r) {
		return true
	}
	if !strings.HasPrefix(method, "room.") && !strings.HasPrefix(method, "setup.") && method != "workspace.open" {
		return false
	}
	u := a.rm
	if u == nil {
		return true
	}
	if r.Err != "" {
		switch {
		case u.setup != nil:
			u.setup.apply(rpc.Event{Name: "error", Data: rpc.EngineError{Message: r.Err}})
		case u.room == nil:
			u.err, u.opening = r.Err, ""
		case method == "room.ask":
			u.room.asides = append(u.room.asides, noteItem{kind: "error", text: r.Err})
			u.room.asking = false
		default:
			u.room.asides = append(u.room.asides, noteItem{kind: "error", text: r.Err})
			u.asstFollow = true
		}
		return true
	}
	switch method {
	case "workspace.open":
		var w rpc.Workspace
		if err := rpc.DecodeResult(r.Result, &w); err != nil {
			u.err = "bad workspace from engine: " + err.Error()
			return true
		}
		u.channels = w.Channels
		if u.switching && u.room != nil {
			u.switching = false
			u.room.overlay = a.switcher()
			return true
		}
		if u.room == nil && u.setup == nil {
			// Opening the app: carry on in the latest channel, or set up the first one.
			if len(w.Channels) == 0 {
				a.startSetup()
			} else {
				a.openRoom(w.Channels[0].ID)
			}
		}
	case "setup.start":
		if u.setup != nil {
			u.setup.ready = true
		}
	case "setup.create", "room.open":
		var s rpc.RoomSnapshot
		if err := rpc.DecodeResult(r.Result, &s); err != nil {
			u.err = "bad channel from engine: " + err.Error()
			return true
		}
		u.setup = nil
		u.room = newRoom(s, a.opts.Calm)
		u.room.workspace = workspaceName(a.opts.Repo)
		u.room.frame = a.frame
		u.opening = ""
		u.roomIn.Focus()
		for _, sub := range s.Substitutions {
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: sub.Agent + " uses " + sub.To + " instead of " + sub.From + " (" + sub.From + " is unavailable)."})
		}
		if len(s.Skipped) > 0 {
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: "Not on the reading list (couldn't find them): " + strings.Join(s.Skipped, ", ") + ". /read sets it."})
		}
		switch {
		case method == "setup.create":
			a.call("room.resume", map[string]any{})
		case u.room.resumesOnOpen():
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: "Picked up where you left off."})
			a.call("room.resume", map[string]any{})
		default:
			why := u.room.lastPause
			if why == "" {
				why = "paused"
			}
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: "Paused (" + why + "). ctrl+p carries on."})
		}
		// Keep the switcher's list current without asking the user to wait for it.
		a.call("workspace.open", map[string]any{"repo": a.opts.Repo})
	case "room.post":
		if u.openThread && u.room != nil {
			u.openThread = false
			var res struct {
				Seq int `json:"seq"`
			}
			if rpc.DecodeResult(r.Result, &res) == nil && res.Seq > 0 {
				u.room.view = res.Seq
				u.feedFollow = true
			}
		}
	case "room.read":
		var res struct {
			Reading []string `json:"reading"`
		}
		if rpc.DecodeResult(r.Result, &res) == nil && u.room != nil {
			u.room.reading = res.Reading
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: "Reading list: " + strings.Join(res.Reading, ", ") + ". Members read what's new on their next turn."})
		}
	case "room.doc":
		var d rpc.RoomDocText
		if rpc.DecodeResult(r.Result, &d) == nil && u.room != nil {
			u.room.overlay = &docOverlay{title: d.Name, text: d.Text}
			u.overlayVP.GotoTop()
		}
	case "room.export":
		var res struct {
			URL string `json:"url"`
		}
		if rpc.DecodeResult(r.Result, &res) == nil && u.room != nil {
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: "Filed: " + res.URL})
		}
	}
	return true
}

// switcher lists the workspace's channels, this channel's threads, and a way to start a new channel.
func (a *App) switcher() *docOverlay {
	r := a.rm.room
	o := &docOverlay{title: "Switch to", list: []docRef{}, rooms: true}
	for _, c := range a.rm.channels {
		name := c.Name
		if name == "" {
			name = ansiCut(firstLine(c.Topic), 30)
		}
		label := "# " + name
		if c.ID == r.id {
			label += "  · here"
		}
		if d := firstLine(c.Digest); d != "" {
			label += "  " + ansiCut(d, 60)
		}
		o.list = append(o.list, docRef{name: c.ID, label: label, kind: "channel"})
		if c.ID != r.id {
			continue
		}
		if r.view != 0 {
			o.list = append(o.list, docRef{name: "0", label: "  ↰ back to the channel", kind: "thread"})
		}
		for _, t := range r.threadList() {
			state := "open"
			if t.summary != "" {
				state = "settled"
			}
			o.list = append(o.list, docRef{name: fmt.Sprint(t.root), label: fmt.Sprintf("  ↳ %s  · %s", ansiCut(t.title, 50), state), kind: "thread"})
		}
	}
	o.list = append(o.list, docRef{label: "+ new channel", kind: "new"})
	return o
}

// shortTime turns a log timestamp into local "Jan 2 15:04".
func shortTime(iso string) string {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		return iso
	}
	return t.Local().Format("Jan 2 15:04")
}

func ansiCut(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func (a *App) handleSetupKey(k tea.KeyPressMsg) tea.Cmd {
	s := a.rm.setup
	switch k.String() {
	case "esc":
		if s.canLeave && len(a.rm.channels) > 0 {
			a.openRoom(a.rm.channels[0].ID)
		}
		return nil
	case "ctrl+s":
		if s.proposal != nil && !s.creating && !s.waiting {
			s.creating = true
			a.call("setup.create", map[string]any{"proposal": s.proposal})
		}
		return nil
	case "pgup", "ctrl+u":
		s.vp.HalfPageUp()
		s.follow = s.vp.AtBottom()
		return nil
	case "pgdown", "ctrl+d":
		s.vp.HalfPageDown()
		s.follow = s.vp.AtBottom()
		return nil
	case "enter":
		text := strings.TrimSpace(s.in.Value())
		if text == "" || s.waiting || s.creating {
			return nil
		}
		s.in.Reset()
		s.msgs = append(s.msgs, noteItem{kind: "you", text: text})
		s.waiting, s.follow = true, true
		a.call("setup.say", map[string]any{"text": text})
		return nil
	case "alt+enter", "shift+enter":
		s.in.InsertString("\n")
		return nil
	}
	var c tea.Cmd
	s.in, c = s.in.Update(k)
	return c
}

func (a *App) handleRoomKey(k tea.KeyPressMsg) tea.Cmd {
	u := a.rm
	key := k.String()
	if u.setup != nil {
		return a.handleSetupKey(k)
	}
	if u.room == nil {
		return nil // still opening
	}
	if u.join != nil {
		return a.handleJoinKey(k)
	}
	r := u.room
	if r.overlay != nil {
		o := r.overlay
		switch key {
		case "esc", "q", "ctrl+k":
			r.overlay = nil
		case "up", "k":
			if o.list != nil {
				o.cur = max(o.cur-1, 0)
			} else {
				u.overlayVP.ScrollUp(1)
			}
		case "down", "j":
			if o.list != nil {
				o.cur = min(o.cur+1, len(o.list)-1)
			} else {
				u.overlayVP.ScrollDown(1)
			}
		case "pgup", "ctrl+u":
			u.overlayVP.HalfPageUp()
		case "pgdown", "ctrl+d":
			u.overlayVP.HalfPageDown()
		case "enter":
			if o.list != nil && o.cur < len(o.list) {
				pick := o.list[o.cur]
				switch {
				case !o.rooms:
					a.call("room.doc", map[string]any{"name": pick.name})
				case pick.kind == "new":
					a.startSetup()
				case pick.kind == "thread":
					var seq int
					fmt.Sscan(pick.name, &seq)
					r.view, r.overlay, u.feedFollow = seq, nil, true
				case pick.name == r.id:
					r.overlay = nil
				default:
					if r.state != "paused" {
						a.call("room.pause", map[string]any{"reason": "switched away"})
					}
					a.openRoom(pick.name)
				}
			}
		}
		return nil
	}
	// Reviewing the assistant's suggestions: keys answer them, nothing reaches the text boxes.
	if r.review {
		switch key {
		case "up", "k":
			r.sugCur = max(r.sugCur-1, 0)
		case "down", "j":
			r.sugCur = min(r.sugCur+1, len(r.pending)-1)
		case "y", "n":
			if r.sugCur < len(r.pending) {
				s := r.pending[r.sugCur]
				// Bringing someone in opens the add-member modal, filled in, so model and role can be tweaked first.
				if key == "y" && (s.Action == "hire" || s.Action == "add") {
					r.review = false
					a.openJoin(&s)
					return nil
				}
				a.call("room.resolve", map[string]any{"id": s.ID, "accept": key == "y"})
			}
		case "a":
			for _, s := range r.pending {
				a.call("room.resolve", map[string]any{"id": s.ID, "accept": true})
			}
		case "esc", "ctrl+n":
			r.review = false
		}
		return nil
	}
	switch key {
	case "tab", "shift+tab":
		if r.pane == paneRoom {
			r.pane = paneAssistant
			u.roomIn.Blur()
			return u.assistIn.Focus()
		}
		r.pane = paneRoom
		u.assistIn.Blur()
		return u.roomIn.Focus()
	case "ctrl+n":
		if len(r.pending) > 0 {
			r.review = true
			r.sugCur = min(r.sugCur, len(r.pending)-1)
		}
		return nil
	case "ctrl+k":
		u.switching = true
		a.call("workspace.open", map[string]any{"repo": a.opts.Repo})
		return nil
	case "ctrl+t":
		u.hideStats = !u.hideStats
		return nil
	case "ctrl+a":
		a.openJoin(nil)
		return nil
	case "ctrl+p":
		if r.state == "paused" {
			a.call("room.resume", map[string]any{})
		} else {
			a.call("room.pause", map[string]any{})
		}
		return nil
	case "ctrl+o":
		r.overlay = &docOverlay{title: "Documents", list: r.docList()}
		return nil
	case "pgup", "ctrl+u":
		a.roomScroll(-1, true)
		return nil
	case "pgdown", "ctrl+d":
		a.roomScroll(1, true)
		return nil
	case "esc":
		a.help = false
		if r.view != 0 {
			r.view, u.feedFollow = 0, true
		}
		return nil
	}
	in := &u.roomIn
	if r.pane == paneAssistant {
		in = &u.assistIn
	}
	switch key {
	case "enter":
		return a.submitRoom()
	case "alt+enter", "shift+enter":
		in.InsertString("\n")
		return nil
	}
	var c tea.Cmd
	*in, c = in.Update(k)
	return c
}

func (a *App) submitRoom() tea.Cmd {
	u := a.rm
	r := u.room
	if r.pane == paneAssistant {
		q := strings.TrimSpace(u.assistIn.Value())
		if q == "" {
			return nil
		}
		if q == "/catchup" {
			q = catchUp
		}
		u.assistIn.Reset()
		r.asking, r.answer = true, ""
		u.asstFollow = true
		a.call("room.ask", map[string]any{"text": q})
		return nil
	}
	cmd := r.parseRoomInput(u.roomIn.Value())
	if cmd.err != "" {
		r.asides = append(r.asides, noteItem{kind: "error", text: cmd.err})
		u.asstFollow = true
		return nil
	}
	u.roomIn.Reset()
	switch cmd.local {
	case "help":
		r.overlay = &docOverlay{title: "Help", text: "```\n" + roomHelp + "\n```"}
		return nil
	case "docs":
		r.overlay = &docOverlay{title: "Documents", list: r.docList()}
		return nil
	case "topics":
		r.asides = append(r.asides, noteItem{kind: "system", text: renderTopics(r)})
		return nil
	case "reading":
		r.asides = append(r.asides, noteItem{kind: "system", text: "Reading list: " + strings.Join(r.reading, ", ")})
		return nil
	case "switch":
		u.switching = true
		a.call("workspace.open", map[string]any{"repo": a.opts.Repo})
		return nil
	case "new":
		a.startSetup()
		return nil
	case "join":
		a.openJoin(nil)
		return nil
	case "thread":
		r.view, u.feedFollow = cmd.params["seq"].(int), true
		return nil
	case "open-thread":
		u.openThread = true
	}
	if cmd.method == "" {
		return nil
	}
	// In a thread, what the human says goes into the thread.
	if cmd.method == "room.post" && r.view != 0 && cmd.params["to"] == nil && cmd.params["thread"] == nil {
		cmd.params["thread"] = r.view
	}
	if cmd.echo != "" {
		r.asides = append(r.asides, noteItem{kind: "system", text: cmd.echo})
	}
	u.feedFollow = true
	a.call(cmd.method, cmd.params)
	return nil
}

// ---- layout ----

// roomSide reports whether the assistant sits beside the feed (wide enough) or under it.
func (a *App) roomSide() bool { return a.w >= roomSideMin }

func (a *App) assistW() int {
	if !a.roomSide() {
		return a.w
	}
	if a.w >= 100 {
		return min(max(34, a.w*34/100), 60)
	}
	return max(26, a.w*40/100)
}

func (a *App) feedW() int {
	if !a.roomSide() {
		return a.w
	}
	return a.w - a.assistW() - 1
}

// statsShown reports whether the stats strip is on screen: it's hidden on short terminals and by ctrl+t.
func (a *App) statsShown() bool {
	return a.rm != nil && a.rm.room != nil && a.rm.room.overlay == nil && !a.rm.hideStats && a.h >= 30 && !a.rm.room.empty()
}

func (a *App) roomBodyH() int {
	// header, spacer, roster line, input boxes (rows + border), footer
	h := a.h - 1 - 1 - 1 - (roomInputRows + 2) - 1
	if a.statsShown() {
		h -= statsHeight()
	}
	return max(h, 6)
}

// paneHeights splits the body when the assistant sits under the feed.
func (a *App) paneHeights() (feed, assist int) {
	bh := a.roomBodyH()
	if a.roomSide() {
		return bh, bh
	}
	feed = max(bh*55/100, 3)
	return feed, max(bh-feed-1, 3)
}

// assistantColumn lays out the assistant pane top to bottom: what needs the human, where things stand, the chat.
func (a *App) assistantColumn(width, height int) (top string, vpH int) {
	r := a.rm.room
	var parts []string
	if sug := renderSuggestions(r, a.th, width, false); sug != "" {
		if lipgloss.Height(sug) > height/2 {
			sug = renderSuggestions(r, a.th, width, true)
		}
		parts = append(parts, sug)
	}
	if d := renderDigest(r, a.th, width, 3); d != "" {
		parts = append(parts, d)
	}
	if len(parts) == 0 {
		return "", height
	}
	parts = append(parts, fg(a.th.Subtle).Render(strings.Repeat("─", width)))
	top = strings.Join(parts, "\n\n")
	return top, max(height-lipgloss.Height(top)-1, 3)
}

func (a *App) refreshRoom() {
	u := a.rm
	if u == nil {
		return
	}
	if u.setup != nil {
		a.refreshSetup()
		return
	}
	if u.room == nil {
		return
	}
	r := u.room
	spin := a.spin.View()
	fw, aw := a.feedW(), a.assistW()
	fh, ah := a.paneHeights()
	u.feedVP.SetWidth(fw)
	u.feedVP.SetHeight(fh)
	u.feedVP.SetContent(renderFeed(r, a.th, fw-1, spin))
	if u.feedFollow {
		u.feedVP.GotoBottom()
	}
	inner := aw - 2
	_, vpH := a.assistantColumn(inner, ah)
	u.assistVP.SetWidth(inner)
	u.assistVP.SetHeight(vpH)
	u.assistVP.SetContent(renderAssistant(r, a.th, inner, spin))
	if u.asstFollow {
		u.assistVP.GotoBottom()
	}
	if r.overlay != nil {
		u.overlayVP.SetWidth(a.w - 4)
		u.overlayVP.SetHeight(a.roomBodyH())
		u.overlayVP.SetContent(renderOverlay(r.overlay, a.th, a.w-4))
	}
	roomBox, assistBox := fw-4, aw-4
	if !a.roomSide() {
		roomBox, assistBox = a.w-4, a.w-4
	}
	u.roomIn.SetWidth(roomBox)
	u.assistIn.SetWidth(max(assistBox, 10))
	switch {
	case r.view != 0:
		u.roomIn.Placeholder = "Reply in this thread · esc back to the channel"
	case len(r.agents) == 0:
		u.roomIn.Placeholder = "Nobody's here yet · /add, or ask your assistant who to bring in"
	default:
		u.roomIn.Placeholder = "Say something · @name to ask one member · /ask for a side thread · /help"
	}
	u.roomIn.SetPromptFunc(7, func(pi textarea.PromptInfo) string {
		if pi.LineNumber != 0 {
			return strings.Repeat(" ", 7)
		}
		target, c := "you", a.th.Accent2
		if v := u.roomIn.Value(); strings.HasPrefix(v, "/dm ") {
			target, c = "dm", a.th.Warn
		} else if strings.HasPrefix(v, "/ask ") {
			target, c = "thread", a.th.Info
		} else if strings.HasPrefix(v, "/") {
			target, c = "cmd", a.th.Muted
		} else if r.view != 0 {
			target, c = "thread", a.th.Info
		}
		return fg(c).Bold(true).Render(padRight(target, 6)) + fg(a.th.Subtle).Render("▸")
	})
	u.assistIn.SetPromptFunc(5, func(pi textarea.PromptInfo) string {
		if pi.LineNumber != 0 {
			return strings.Repeat(" ", 5)
		}
		return fg(a.th.Info).Bold(true).Render("ask") + fg(a.th.Subtle).Render("▸ ")
	})
}

func padRight(s string, n int) string {
	if w := lipgloss.Width(s); w >= n {
		return ansiCut(s, n)
	}
	return s + strings.Repeat(" ", n-lipgloss.Width(s))
}

func (a *App) roomScroll(dir int, page bool) {
	u := a.rm
	if u.setup != nil {
		return
	}
	vp, follow := &u.feedVP, &u.feedFollow
	if u.room != nil && u.room.pane == paneAssistant {
		vp, follow = &u.assistVP, &u.asstFollow
	}
	switch {
	case dir < 0 && page:
		vp.HalfPageUp()
	case dir > 0 && page:
		vp.HalfPageDown()
	case dir < 0:
		vp.ScrollUp(3)
	default:
		vp.ScrollDown(3)
	}
	*follow = vp.AtBottom()
}

func (a *App) roomWheel(m tea.MouseWheelMsg) {
	u := a.rm
	if u == nil {
		return
	}
	if u.setup != nil {
		if m.Mouse().Button == tea.MouseWheelUp {
			u.setup.vp.ScrollUp(3)
		} else {
			u.setup.vp.ScrollDown(3)
		}
		u.setup.follow = u.setup.vp.AtBottom()
		return
	}
	if u.room == nil {
		return
	}
	if u.room.overlay != nil {
		if m.Mouse().Button == tea.MouseWheelUp {
			u.overlayVP.ScrollUp(3)
		} else {
			u.overlayVP.ScrollDown(3)
		}
		return
	}
	fh, _ := a.paneHeights()
	top := 2
	if a.statsShown() {
		top += statsHeight()
	}
	inAssist := a.roomSide() && m.Mouse().X > a.feedW() || !a.roomSide() && m.Mouse().Y > top+fh
	vp, follow := &u.feedVP, &u.feedFollow
	if inAssist {
		vp, follow = &u.assistVP, &u.asstFollow
	}
	if m.Mouse().Button == tea.MouseWheelUp {
		vp.ScrollUp(3)
	} else if m.Mouse().Button == tea.MouseWheelDown {
		vp.ScrollDown(3)
	}
	*follow = vp.AtBottom()
}

func (a *App) roomView() string {
	u := a.rm
	if u.setup != nil {
		return a.setupView()
	}
	spin := a.spin.View()
	if u.room == nil {
		msg := fg(a.th.Muted).Italic(true).Render(spin + " " + u.opening + "…")
		if u.err != "" {
			msg = fg(a.th.Err).Render("✗ "+u.err) + "\n\n" + fg(a.th.Muted).Render("ctrl+c to quit")
		}
		return lipgloss.Place(a.w, a.h, lipgloss.Center, lipgloss.Center, renderLogo(a.th, a.frame)+"\n\n"+msg)
	}
	r := u.room
	header := renderRoomHeader(r, a.th, a.w, spin)
	bh := a.roomBodyH()
	fh, ah := a.paneHeights()
	fw, aw := a.feedW(), a.assistW()

	feed := lipgloss.NewStyle().Width(fw).Height(fh).Render(u.feedVP.View())
	top, _ := a.assistantColumn(aw-2, ah)
	col := u.assistVP.View()
	if top != "" {
		col = top + "\n" + col
	}
	assist := lipgloss.NewStyle().Width(aw).Height(ah).MaxHeight(ah).PaddingLeft(1).Render(col)

	var body string
	switch {
	case u.join != nil:
		body = a.joinBox(bh)
	case r.overlay != nil:
		body = lipgloss.NewStyle().Width(a.w).Height(bh).Padding(0, 2).Render(u.overlayVP.View())
	case a.roomSide():
		sep := lipgloss.NewStyle().Foreground(a.th.Subtle).Render(strings.TrimRight(strings.Repeat("│\n", bh), "\n"))
		body = lipgloss.JoinHorizontal(lipgloss.Top, feed, sep, assist)
	default:
		rule := fg(a.th.Subtle).Render(strings.Repeat("─", a.w))
		body = lipgloss.JoinVertical(lipgloss.Left, feed, rule, assist)
	}

	box := func(in textarea.Model, focused bool, w int) string {
		st := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Width(w)
		if focused && !r.review {
			st = st.BorderForegroundBlend(a.th.Accent2, a.th.Accent, a.th.Info, a.th.Speaker(2)).BorderForegroundBlendOffset(a.frame)
		} else {
			st = st.BorderForeground(a.th.Border)
		}
		return st.Render(in.View())
	}
	var inputs string
	switch {
	case a.roomSide():
		inputs = lipgloss.JoinHorizontal(lipgloss.Top, box(u.roomIn, r.pane == paneRoom, fw), " ", box(u.assistIn, r.pane == paneAssistant, aw))
	case r.pane == paneAssistant:
		inputs = box(u.assistIn, true, a.w)
	default:
		inputs = box(u.roomIn, true, a.w)
	}
	rows := []string{header, ""}
	if a.statsShown() {
		rows = append(rows, renderStats(r, a.th, a.w), "")
	}
	rows = append(rows, body, renderRoomRoster(r, a.th, a.w, spin), inputs, roomFooter(r, a.th, a.w))
	return lipgloss.JoinVertical(lipgloss.Left, rows...)
}
