package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

// Touch. A phone's ssh app sends a tap as a click and a swipe as wheel events (sideways ones for a
// horizontal swipe) or as a press, drag and release. In touch mode (on by itself at phone widths,
// or with /touch on) a drag is a gesture instead of a text selection: up and down scrolls the pane
// under the finger, sideways is a swipe. Swiping left goes forward (to the assistant, the next
// tab), swiping right goes back (closes what's open, back to the channel). Taps work in either mode:
// a double tap picks a message and offers its shortcuts, a tap on a footer hint runs it (no Alt key
// needed), and a tap on a pane moves typing there.

type touch struct {
	mode  string // "auto" (on below roomSideMin columns), "on" or "off"
	synth bool   // a gesture is pressing a key

	down       bool
	bar        bool // a press on the header bar: a drag there swipes, in any mode
	replay     bool // passing a header press on as a plain click
	press      tea.MouseClickMsg
	x0, y0     int // where the finger went down
	lastY      int // last row the drag scrolled to
	scrolling  bool
	lastSwipe  time.Time
	lastTap    time.Time
	tapX, tapY int
}

// logInput writes key and mouse events to the input log while /inputlog is on, to see what a
// terminal (or a multiplexer in front of it) actually sends for a swipe or a key.
func (a *App) logInput(msg tea.Msg) {
	if a.inputLog == "" || a.touch.synth {
		return
	}
	var line string
	switch m := msg.(type) {
	case tea.MouseWheelMsg:
		line = fmt.Sprintf("wheel   %-22s at %d,%d", m.Mouse().String(), m.Mouse().X, m.Mouse().Y)
	case tea.MouseClickMsg:
		line = fmt.Sprintf("press   %-22s at %d,%d", m.Mouse().String(), m.Mouse().X, m.Mouse().Y)
	case tea.MouseReleaseMsg:
		line = fmt.Sprintf("release %-22s at %d,%d", m.Mouse().String(), m.Mouse().X, m.Mouse().Y)
	case tea.MouseMotionMsg:
		if m.Mouse().Button == tea.MouseNone {
			return // plain hovering would flood the log
		}
		line = fmt.Sprintf("drag    %-22s at %d,%d", m.Mouse().String(), m.Mouse().X, m.Mouse().Y)
	case tea.KeyPressMsg:
		line = fmt.Sprintf("key     %q", m.String())
	case tea.WindowSizeMsg:
		line = fmt.Sprintf("size    %dx%d", m.Width, m.Height)
	default:
		return
	}
	if f, err := os.OpenFile(a.inputLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		fmt.Fprintf(f, "%s %s touch=%v\n", time.Now().Format("15:04:05.000"), line, a.touchMode())
		f.Close()
	}
}

// footKey is a tappable hint in the footer: its columns and the key it stands for.
type footKey struct {
	from, to int
	key      string
}

// feedRow is the feed lines a message takes, in the feed's own coordinates.
type feedRow struct {
	from, to, seq int
}

const (
	swipeMin     = 6 // columns a sideways drag must cover to count as a swipe
	swipeEvery   = 450 * time.Millisecond
	doubleTapGap = 450 * time.Millisecond
)

func (a *App) touchMode() bool {
	switch a.touch.mode {
	case "on":
		return true
	case "off":
		return false
	}
	return a.w < roomSideMin
}

// synthKey is the key press a gesture or a tapped hint stands for.
func synthKey(s string) (tea.KeyPressMsg, bool) {
	switch s {
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}, true
	case "tab":
		return tea.KeyPressMsg{Code: tea.KeyTab}, true
	case "down":
		return tea.KeyPressMsg{Code: tea.KeyDown}, true
	case "up":
		return tea.KeyPressMsg{Code: tea.KeyUp}, true
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}, true
	case "space":
		return tea.KeyPressMsg{Code: tea.KeySpace, Text: " "}, true
	case "right":
		return tea.KeyPressMsg{Code: tea.KeyRight}, true
	case "left":
		return tea.KeyPressMsg{Code: tea.KeyLeft}, true
	case "alt+right":
		return tea.KeyPressMsg{Code: tea.KeyRight, Mod: tea.ModAlt}, true
	case "alt+left":
		return tea.KeyPressMsg{Code: tea.KeyLeft, Mod: tea.ModAlt}, true
	case "pgup":
		return tea.KeyPressMsg{Code: tea.KeyPgUp}, true
	case "pgdown":
		return tea.KeyPressMsg{Code: tea.KeyPgDown}, true
	}
	if strings.HasPrefix(s, "alt+") && len(s) == 5 {
		return tea.KeyPressMsg{Code: rune(s[4]), Mod: tea.ModAlt}, true
	}
	if strings.HasPrefix(s, "ctrl+") && len(s) == 6 {
		return tea.KeyPressMsg{Code: rune(s[5]), Mod: tea.ModCtrl}, true
	}
	if len([]rune(s)) == 1 {
		return tea.KeyPressMsg{Code: []rune(s)[0], Text: s}, true
	}
	return tea.KeyPressMsg{}, false
}

// pressKey runs a key as if it was typed.
func (a *App) pressKey(s string) tea.Cmd {
	k, ok := synthKey(s)
	if !ok {
		return nil
	}
	a.touch.synth = true // not logged as typed
	_, c := a.Update(k)
	a.touch.synth = false
	return c
}

// touchMouse turns presses, drags and releases into gestures in touch mode; it reports whether it
// used the event.
func (a *App) touchMouse(msg tea.Msg) (tea.Cmd, bool) {
	t := &a.touch
	switch m := msg.(type) {
	case tea.MouseClickMsg:
		if m.Mouse().Button != tea.MouseLeft {
			return nil, false
		}
		t.down, t.press, t.scrolling = true, m, false
		t.x0, t.y0, t.lastY = m.Mouse().X, m.Mouse().Y, m.Mouse().Y
		return nil, true
	case tea.MouseMotionMsg:
		if !t.down {
			return nil, false
		}
		x, y := m.Mouse().X, m.Mouse().Y
		dx, dy := abs(x-t.x0), abs(y-t.y0)
		// Up and down follows the finger: content moves with it.
		if t.scrolling || dy >= 1 && dy >= dx {
			t.scrolling = true
			if d := y - t.lastY; d != 0 {
				a.scrollAt(t.x0, t.y0, -d)
				t.lastY = y
			}
		}
		return nil, true
	case tea.MouseReleaseMsg:
		if !t.down {
			return nil, false
		}
		t.down = false
		x, y := m.Mouse().X, m.Mouse().Y
		dx, dy := x-t.x0, y-t.y0
		switch {
		case !t.scrolling && abs(dx) >= swipeMin && abs(dx) > 2*abs(dy):
			return a.swipe(dx > 0, t.x0, t.y0), true
		case t.scrolling:
			return nil, true
		}
		return a.tap(t.press), true
	}
	return nil, false
}

// barRows is the top of the screen (the header and status bar), where a one-finger drag sideways
// swipes in any mode; nothing there is worth selecting.
const barRows = 2

// barMouse makes a drag across the header bar a swipe: a press there doesn't start a selection, and
// a release that didn't travel far is passed on as a plain click. It reports whether it used the
// event.
func (a *App) barMouse(msg tea.Msg) (tea.Cmd, bool) {
	t := &a.touch
	if t.replay {
		return nil, false
	}
	switch m := msg.(type) {
	case tea.MouseClickMsg:
		if m.Mouse().Button != tea.MouseLeft || m.Mouse().Y >= barRows {
			return nil, false
		}
		t.bar, t.press = true, m
		t.x0, t.y0 = m.Mouse().X, m.Mouse().Y
		return nil, true
	case tea.MouseMotionMsg:
		return nil, t.bar
	case tea.MouseReleaseMsg:
		if !t.bar {
			return nil, false
		}
		t.bar = false
		if dx := m.Mouse().X - t.x0; abs(dx) >= swipeMin-2 {
			return a.swipe(dx > 0, t.x0, t.y0), true
		}
		t.replay = true
		_, c1 := a.Update(t.press)
		_, c2 := a.Update(m)
		t.replay = false
		return tea.Batch(c1, c2), true
	}
	return nil, false
}

// tap is a click in touch mode, or the tap-only parts of a click otherwise.
func (a *App) tap(m tea.MouseClickMsg) tea.Cmd {
	if c, used := a.roomClick(m); used {
		return c
	}
	if a.inChannel() {
		c, _ := a.tapExtras(m)
		return c
	}
	return nil
}

// tapExtras handles what a tap does beyond the room's own click targets: a double tap on a message,
// a footer hint, focus to the pane under the finger. It reports whether it used the tap.
func (a *App) tapExtras(m tea.MouseClickMsg) (tea.Cmd, bool) {
	u := a.rm
	r := u.room
	x, y := m.Mouse().X, m.Mouse().Y
	t := &a.touch
	double := time.Since(t.lastTap) < doubleTapGap && abs(x-t.tapX) <= 2 && abs(y-t.tapY) <= 1
	t.lastTap, t.tapX, t.tapY = time.Now(), x, y
	if double {
		t.lastTap = time.Time{}
	}
	if y == u.footY {
		for _, k := range u.footKeys {
			if x >= k.from && x < k.to {
				if k.key == "/help" {
					r.overlay = &docOverlay{title: "Help", text: "```\n" + roomHelp + "\n```"}
					u.overlayVP.GotoTop()
					return nil, true
				}
				return a.pressKey(k.key), true
			}
		}
		return nil, true
	}
	top := a.bodyTop()
	fh, _ := a.paneHeights()
	inFeed := x < a.feedW() && y >= top && y < top+fh
	if double && inFeed && r.rev == nil {
		row := y - top + u.feedVP.YOffset()
		for _, f := range r.feedRows {
			if row >= f.from && row < f.to {
				a.spotOn(f.seq)
				return nil, true
			}
		}
	}
	// Typing goes to the pane that was tapped.
	inAssist := a.roomSide() && x > a.feedW() && y >= top || !a.roomSide() && y > top+fh && y < u.footY
	if r.spot == nil && !r.review && (inAssist && r.pane == paneRoom || inFeed && r.pane == paneAssistant) {
		return a.pressKey("tab"), false
	}
	return nil, false
}

// swipe is a sideways swipe: back (finger moving right) or forward. Sideways wheel events come in
// bursts, so one swipe acts once.
func (a *App) swipe(back bool, x, y int) tea.Cmd {
	if time.Since(a.touch.lastSwipe) < swipeEvery {
		return nil
	}
	a.touch.lastSwipe = time.Now()
	switch {
	case a.prov != nil:
		return a.pressKey(map[bool]string{true: "alt+left", false: "alt+right"}[back])
	case a.usage != nil:
		return a.pressKey(map[bool]string{true: "left", false: "right"}[back])
	case a.screen != screenRoom || a.rm == nil || a.rm.room == nil:
		return nil
	}
	u := a.rm
	r := u.room
	if u.setup != nil {
		if back {
			return a.pressKey("esc")
		}
		return nil
	}
	// Over the highlights strip, swiping left steps back through them.
	if !back && a.stripShown() && y >= a.stripTop() && y < a.stripTop()+a.stripHeight()-1 {
		a.stepHighlight()
		return nil
	}
	open := u.join != nil || r.edit != nil || r.terms != nil || r.overlay != nil || r.rev != nil || r.spot != nil || r.review || r.view != 0
	switch {
	case back && open:
		return a.pressKey("esc")
	case back && r.pane == paneAssistant, !back && !open && r.pane == paneRoom:
		return a.pressKey("tab")
	}
	return nil
}

// scrollAt scrolls the pane under a screen position by n lines (negative is up).
func (a *App) scrollAt(x, y, n int) {
	if n == 0 {
		return
	}
	b := tea.MouseWheelDown
	if n < 0 {
		b, n = tea.MouseWheelUp, -n
	}
	for i := 0; i < n; i++ {
		// The wheel scrolls three lines; a drag moves one per row the finger travels.
		a.wheelBy(tea.MouseWheelMsg{X: x, Y: y, Button: b}, 1)
	}
}

// inputLogPath is where /inputlog writes: Quorum's state folder.
func inputLogPath() string {
	dir := os.Getenv("XDG_STATE_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".local", "state")
	}
	dir = filepath.Join(dir, "quorum")
	_ = os.MkdirAll(dir, 0o755)
	return filepath.Join(dir, "input.log")
}
