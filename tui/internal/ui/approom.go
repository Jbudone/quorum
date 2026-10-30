package ui

import (
	"strings"

	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// roomUI is the room screen's own widgets, kept apart from the council session's.
type roomUI struct {
	room       *roomModel
	feedVP     viewport.Model
	assistVP   viewport.Model
	overlayVP  viewport.Model
	roomIn     textarea.Model
	assistIn   textarea.Model
	feedFollow bool
	asstFollow bool
	opening    string // what we're waiting for: "starting" or "reopening", "" once the room is here
}

const (
	roomWideMin   = 100 // below this the two panes become tabs
	roomInputRows = 2
)

func (a *App) newRoomUI(opening string) {
	in := newInput(a.th, roomInputRows)
	in.Placeholder = "Say something to the room, @name for one member, /help for commands"
	as := newInput(a.th, roomInputRows)
	as.Placeholder = "Ask your assistant…"
	a.rm = &roomUI{
		feedVP: viewport.New(), assistVP: viewport.New(), overlayVP: viewport.New(),
		roomIn: in, assistIn: as, feedFollow: true, asstFollow: true, opening: opening,
	}
	a.rm.feedVP.MouseWheelEnabled = true
	a.rm.assistVP.MouseWheelEnabled = true
	a.rm.roomIn.Focus()
	a.screen = screenRoom
}

// startRoom sends room.start with the start screen's choices.
func (a *App) startRoom(params map[string]any) {
	a.newRoomUI("starting")
	a.call("room.start", params)
}

func (a *App) openRoom(id string) {
	a.newRoomUI("reopening")
	a.call("room.open", map[string]any{"repo": a.opts.Repo, "id": id})
}

// handleRoomResponse handles answers to room.* requests. It reports whether it took the method.
func (a *App) handleRoomResponse(method string, r rpc.Response) bool {
	if method == "rooms.list" {
		var l []rpc.RoomListItem
		if r.Err == "" && rpc.DecodeResult(r.Result, &l) == nil {
			a.start.rooms = l
			a.start.roomCur = min(a.start.roomCur, max(len(l)-1, 0))
		}
		return true
	}
	if !strings.HasPrefix(method, "room.") {
		return false
	}
	u := a.rm
	if r.Err != "" {
		if (method == "room.start" || method == "room.open") && u != nil && u.room == nil {
			// Nothing opened, so go back and let the user adjust.
			a.rm, a.screen = nil, screenStart
			a.start.err = r.Err
			return true
		}
		if u != nil && u.room != nil {
			u.room.asides = append(u.room.asides, noteItem{kind: "error", text: r.Err})
			if method == "room.ask" {
				u.room.asking = false
			}
		} else {
			a.fail(r.Err)
		}
		return true
	}
	if u == nil {
		return true
	}
	switch method {
	case "room.start", "room.open":
		var s rpc.RoomSnapshot
		if err := rpc.DecodeResult(r.Result, &s); err != nil {
			a.rm, a.screen = nil, screenStart
			a.start.err = "bad room from engine: " + err.Error()
			return true
		}
		u.room = newRoom(s, a.opts.Calm)
		u.room.frame = a.frame
		for _, sub := range s.Substitutions {
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: sub.Agent + " uses " + sub.To + " instead of " + sub.From + " (" + sub.From + " is unavailable)."})
		}
		if method == "room.start" {
			a.call("room.resume", map[string]any{})
		} else {
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: "Room reopened and paused. Press ctrl+p to carry on, or ask me /catchup for a recap first."})
		}
		u.opening = ""
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
	case "room.add", "room.rejoin":
		var res struct {
			ID string `json:"id"`
		}
		if rpc.DecodeResult(r.Result, &res) == nil && u.room != nil {
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: res.ID + " joined the room."})
		}
	}
	return true
}

func (a *App) handleRoomKey(k tea.KeyPressMsg) tea.Cmd {
	u := a.rm
	key := k.String()
	if u.room == nil {
		return nil // still opening
	}
	r := u.room
	if r.overlay != nil {
		o := r.overlay
		switch key {
		case "esc", "q":
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
				a.call("room.doc", map[string]any{"name": o.list[o.cur].name})
			}
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
		return nil
	}
	in := &u.roomIn
	if r.pane == paneAssistant {
		in = &u.assistIn
		// With the box empty, the arrow keys and y/n work the suggestion list.
		if strings.TrimSpace(in.Value()) == "" && len(r.pending) > 0 {
			switch key {
			case "up":
				r.sugCur = max(r.sugCur-1, 0)
				return nil
			case "down":
				r.sugCur = min(r.sugCur+1, len(r.pending)-1)
				return nil
			case "y", "n":
				s := r.pending[r.sugCur]
				a.call("room.resolve", map[string]any{"id": s.ID, "accept": key == "y"})
				return nil
			}
		}
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
		return nil
	}
	u.roomIn.Reset()
	switch cmd.local {
	case "help":
		r.overlay = &docOverlay{title: "Room help", text: "```\n" + roomHelp + "\n```"}
		return nil
	case "docs":
		r.overlay = &docOverlay{title: "Documents", list: r.docList()}
		return nil
	case "topics":
		r.asides = append(r.asides, noteItem{kind: "system", text: renderTopics(r)})
		return nil
	case "leave":
		a.call("room.pause", map[string]any{"reason": "left the room"})
		a.rm = nil
		a.screen = screenStart
		a.start.focus = 0
		a.call("rooms.list", map[string]any{"repo": a.opts.Repo})
		return nil
	}
	if cmd.method == "" {
		return nil
	}
	if cmd.echo != "" {
		r.asides = append(r.asides, noteItem{kind: "system", text: cmd.echo})
	}
	u.feedFollow = true
	a.call(cmd.method, cmd.params)
	return nil
}

// ---- layout ----

func (a *App) roomWide() bool { return a.w >= roomWideMin }

func (a *App) assistW() int {
	if !a.roomWide() {
		return a.w
	}
	return max(36, a.w*34/100)
}

func (a *App) feedW() int {
	if !a.roomWide() {
		return a.w
	}
	return a.w - a.assistW() - 1
}

func (a *App) roomBodyH() int {
	// header, spacer, roster line, input boxes (rows + border), footer
	return max(a.h-1-1-1-(roomInputRows+2)-1, 3)
}

func (a *App) refreshRoom() {
	u := a.rm
	if u == nil || u.room == nil {
		return
	}
	r := u.room
	spin := a.spin.View()
	fw, aw, bh := a.feedW(), a.assistW(), a.roomBodyH()
	u.feedVP.SetWidth(fw)
	u.feedVP.SetHeight(bh)
	u.feedVP.SetContent(renderFeed(r, a.th, fw-1, spin))
	if u.feedFollow {
		u.feedVP.GotoBottom()
	}
	sug := renderSuggestions(r, a.th, aw-2, r.pane == paneAssistant)
	ah := bh
	if sug != "" {
		ah = max(bh-lipgloss.Height(sug)-1, 3)
	}
	u.assistVP.SetWidth(aw - 1)
	u.assistVP.SetHeight(ah)
	u.assistVP.SetContent(renderAssistant(r, a.th, aw-2, spin, r.pane == paneAssistant))
	if u.asstFollow {
		u.assistVP.GotoBottom()
	}
	if r.overlay != nil {
		u.overlayVP.SetWidth(a.w - 4)
		u.overlayVP.SetHeight(bh)
		u.overlayVP.SetContent(renderOverlay(r.overlay, a.th, a.w-4))
	}
	boxW := fw - 4
	if !a.roomWide() {
		boxW = a.w - 4
	}
	u.roomIn.SetWidth(boxW)
	u.assistIn.SetWidth(max(aw-4, 10))
	u.roomIn.SetPromptFunc(10, func(pi textarea.PromptInfo) string {
		if pi.LineNumber != 0 {
			return strings.Repeat(" ", 10)
		}
		target, c := "room", a.th.Accent2
		if v := u.roomIn.Value(); strings.HasPrefix(v, "@") {
			target = strings.ToLower(strings.TrimPrefix(strings.Fields(v + " ")[0], "@"))
			c = r.colorOf(a.th, target)
		} else if strings.HasPrefix(v, "/") {
			target, c = "cmd", a.th.Muted
		}
		return fg(c).Bold(true).Render(padRight(target, 8)) + fg(a.th.Subtle).Render("▸ ")
	})
	u.assistIn.SetPromptFunc(5, func(pi textarea.PromptInfo) string {
		if pi.LineNumber != 0 {
			return strings.Repeat(" ", 5)
		}
		return fg(a.th.Info).Bold(true).Render("ask") + fg(a.th.Subtle).Render("▸ ")
	})
}

func padRight(s string, n int) string {
	if len(s) >= n {
		return s[:n]
	}
	return s + strings.Repeat(" ", n-len(s))
}

func (a *App) roomScroll(dir int, page bool) {
	u := a.rm
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
	if u == nil || u.room == nil {
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
	vp, follow := &u.feedVP, &u.feedFollow
	if a.roomWide() && m.Mouse().X > a.feedW() || !a.roomWide() && u.room.pane == paneAssistant {
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
	spin := a.spin.View()
	if u.room == nil {
		msg := spin + " " + u.opening + " the room…"
		return lipgloss.Place(a.w, a.h, lipgloss.Center, lipgloss.Center, renderLogo(a.th, a.frame)+"\n\n"+fg(a.th.Muted).Italic(true).Render(msg))
	}
	r := u.room
	header := renderRoomHeader(r, a.th, a.w, spin)
	bh := a.roomBodyH()
	sep := lipgloss.NewStyle().Foreground(a.th.Subtle).Render(strings.TrimRight(strings.Repeat("│\n", bh), "\n"))
	feed := lipgloss.NewStyle().Width(a.feedW()).Height(bh).Render(u.feedVP.View())
	assist := u.assistVP.View()
	if sug := renderSuggestions(r, a.th, a.assistW()-2, r.pane == paneAssistant); sug != "" {
		assist += "\n" + sug
	}
	assist = lipgloss.NewStyle().Width(a.assistW()).Height(bh).PaddingLeft(1).Render(assist)

	var body string
	switch {
	case r.overlay != nil:
		body = lipgloss.NewStyle().Width(a.w).Height(bh).Padding(0, 2).Render(u.overlayVP.View())
	case a.roomWide():
		body = lipgloss.JoinHorizontal(lipgloss.Top, feed, sep, assist)
	case r.pane == paneAssistant:
		body = assist
	default:
		body = feed
	}

	box := func(in textarea.Model, focused bool, w int) string {
		c := a.th.Border
		st := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Width(w)
		if focused {
			c = a.th.Accent
			st = st.BorderForegroundBlend(a.th.Accent2, a.th.Accent, a.th.Info, a.th.Speaker(2)).BorderForegroundBlendOffset(a.frame)
		} else {
			st = st.BorderForeground(c)
		}
		return st.Render(in.View())
	}
	var inputs string
	if a.roomWide() {
		inputs = lipgloss.JoinHorizontal(lipgloss.Top, box(u.roomIn, r.pane == paneRoom, a.feedW()), " ", box(u.assistIn, r.pane == paneAssistant, a.assistW()))
	} else if r.pane == paneAssistant {
		inputs = box(u.assistIn, true, a.w)
	} else {
		inputs = box(u.roomIn, true, a.w)
	}
	roster := renderRoomRoster(r, a.th, a.w, spin)
	return lipgloss.JoinVertical(lipgloss.Left, header, "", body, roster, inputs, roomFooter(r, a.th, a.w))
}
