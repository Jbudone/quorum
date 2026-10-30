package ui

import (
	"strings"
	"time"

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
	opening    string // what we're waiting for ("opening", "starting", "reopening"); "" once the room is here
	err        string // why the room couldn't be opened
	listing    bool   // a rooms.list is for the /rooms overlay
}

const (
	roomSideMin   = 64 // below this the assistant sits under the feed instead of beside it
	roomInputRows = 2
)

func (a *App) newRoomUI(opening string) {
	in := newInput(a.th, roomInputRows)
	as := newInput(a.th, roomInputRows)
	as.Placeholder = "Ask your assistant anything…"
	a.rm = &roomUI{
		feedVP: viewport.New(), assistVP: viewport.New(), overlayVP: viewport.New(),
		roomIn: in, assistIn: as, feedFollow: true, asstFollow: true, opening: opening,
	}
	a.rm.feedVP.MouseWheelEnabled = true
	a.rm.assistVP.MouseWheelEnabled = true
	a.rm.roomIn.Focus()
	a.screen = screenRoom
}

func (a *App) startRoom() {
	a.newRoomUI("starting")
	params := map[string]any{"repo": a.opts.Repo}
	if a.opts.Mock {
		params["mock"] = true
	}
	a.call("room.start", params)
}

func (a *App) openRoom(id string) {
	a.newRoomUI("reopening")
	a.call("room.open", map[string]any{"repo": a.opts.Repo, "id": id})
}

// handleRoomResponse handles answers to room requests. It reports whether it took the method.
func (a *App) handleRoomResponse(method string, r rpc.Response) bool {
	if method != "rooms.list" && !strings.HasPrefix(method, "room.") {
		return false
	}
	u := a.rm
	if u == nil {
		return true
	}
	if r.Err != "" {
		switch {
		case u.room == nil:
			u.err, u.opening = r.Err, ""
		case method == "room.ask":
			u.room.asides = append(u.room.asides, noteItem{kind: "error", text: r.Err})
			u.room.asking = false
		default:
			u.room.asides = append(u.room.asides, noteItem{kind: "error", text: r.Err})
		}
		return true
	}
	switch method {
	case "rooms.list":
		var l []rpc.RoomListItem
		if err := rpc.DecodeResult(r.Result, &l); err != nil {
			u.err = "bad room list from engine: " + err.Error()
			return true
		}
		if u.listing && u.room != nil {
			u.listing = false
			o := &docOverlay{title: "Rooms in this project", list: []docRef{}, rooms: true}
			for _, it := range l {
				label := it.Topic
				if label == "" {
					label = "(empty room)"
				}
				label = ansiCut(firstLine(label), 60) + "  " + shortTime(it.Updated)
				if it.ID == u.room.id {
					label += "  · this room"
				}
				o.list = append(o.list, docRef{name: it.ID, label: label})
			}
			u.room.overlay = o
			return true
		}
		if u.room == nil {
			// Opening the app: pick up the latest room here, or start a fresh one.
			if len(l) == 0 {
				a.startRoom()
			} else {
				a.openRoom(l[0].ID)
			}
		}
	case "room.start", "room.open":
		var s rpc.RoomSnapshot
		if err := rpc.DecodeResult(r.Result, &s); err != nil {
			u.err = "bad room from engine: " + err.Error()
			return true
		}
		u.room = newRoom(s, a.opts.Calm)
		u.room.frame = a.frame
		u.opening = ""
		for _, sub := range s.Substitutions {
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: sub.Agent + " uses " + sub.To + " instead of " + sub.From + " (" + sub.From + " is unavailable)."})
		}
		switch {
		case method == "room.start":
			a.call("room.resume", map[string]any{})
		case u.room.resumesOnOpen():
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: "Picked up where you left off. ctrl+p pauses."})
			a.call("room.resume", map[string]any{})
		case len(u.room.agents) == 0:
			a.call("room.resume", map[string]any{})
		default:
			why := u.room.lastPause
			if why == "" {
				why = "paused"
			}
			u.room.asides = append(u.room.asides, noteItem{kind: "system", text: "This room is paused (" + why + "). ctrl+p carries on; ask me /catchup for a recap first."})
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
				pick := o.list[o.cur].name
				switch {
				case o.rooms && pick == r.id:
					r.overlay = nil
				case o.rooms:
					a.openRoom(pick)
				default:
					a.call("room.doc", map[string]any{"name": pick})
				}
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
		u.asstFollow = true
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
	case "rooms":
		u.listing = true
		a.call("rooms.list", map[string]any{"repo": a.opts.Repo})
		return nil
	case "new":
		a.startRoom()
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

// roomSide reports whether the assistant sits beside the feed (wide enough) or under it.
func (a *App) roomSide() bool { return a.w >= roomSideMin }

func (a *App) assistW() int {
	if !a.roomSide() {
		return a.w
	}
	if a.w >= 100 {
		return min(max(34, a.w*36/100), 64)
	}
	return max(26, a.w*40/100)
}

func (a *App) feedW() int {
	if !a.roomSide() {
		return a.w
	}
	return a.w - a.assistW() - 1
}

func (a *App) roomBodyH() int {
	// header, spacer, roster line, input boxes (rows + border), footer
	return max(a.h-1-1-1-(roomInputRows+2)-1, 6)
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

// assistantColumn lays out the assistant pane top to bottom: pinned digest, conversation, suggestions.
func (a *App) assistantColumn(width, height int) (digest, sug string, vpH int) {
	r := a.rm.room
	sug = renderSuggestions(r, a.th, width, r.pane == paneAssistant, false)
	if lipgloss.Height(sug) > height/2 {
		sug = renderSuggestions(r, a.th, width, r.pane == paneAssistant, true)
	}
	digest = renderDigest(r, a.th, width, max(height/3, 3))
	used := 0
	if digest != "" {
		used += lipgloss.Height(digest) + 1
	}
	if sug != "" {
		used += lipgloss.Height(sug) + 1
	}
	return digest, sug, max(height-used, 3)
}

func (a *App) refreshRoom() {
	u := a.rm
	if u == nil || u.room == nil {
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
	_, _, vpH := a.assistantColumn(inner, ah)
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
	case len(r.agents) == 0:
		u.roomIn.Placeholder = "Describe the problem you want worked out…"
	default:
		u.roomIn.Placeholder = "Say something to the room · @name to ask one member · /help"
	}
	u.roomIn.SetPromptFunc(6, func(pi textarea.PromptInfo) string {
		if pi.LineNumber != 0 {
			return strings.Repeat(" ", 6)
		}
		target, c := "room", a.th.Accent2
		if v := u.roomIn.Value(); strings.HasPrefix(v, "/dm ") {
			target, c = "dm", a.th.Warn
		} else if strings.HasPrefix(v, "/") {
			target, c = "cmd", a.th.Muted
		}
		return fg(c).Bold(true).Render(padRight(target, 4)) + fg(a.th.Subtle).Render("▸ ")
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
	fh, _ := a.paneHeights()
	inAssist := a.roomSide() && m.Mouse().X > a.feedW() || !a.roomSide() && m.Mouse().Y > 2+fh
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
	spin := a.spin.View()
	if u.room == nil {
		msg := fg(a.th.Muted).Italic(true).Render(spin + " " + u.opening + " the room…")
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
	digest, sug, _ := a.assistantColumn(aw-2, ah)
	parts := []string{}
	if digest != "" {
		parts = append(parts, digest, "")
	}
	parts = append(parts, u.assistVP.View())
	assistBody := lipgloss.NewStyle().Height(ah - lipgloss.Height(sug) - 1).MaxHeight(ah).Render(strings.Join(parts, "\n"))
	if sug != "" {
		assistBody = lipgloss.JoinVertical(lipgloss.Left, assistBody, "", sug)
	}
	assist := lipgloss.NewStyle().Width(aw).Height(ah).MaxHeight(ah).PaddingLeft(1).Render(assistBody)

	var body string
	switch {
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
		if focused {
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
	roster := renderRoomRoster(r, a.th, a.w, spin)
	return lipgloss.JoinVertical(lipgloss.Left, header, "", body, roster, inputs, roomFooter(r, a.th, a.w))
}
