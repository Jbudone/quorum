package ui

import (
	"os"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func (h *roomHarness) drag(x0, y0, x1, y1 int) {
	h.send(tea.MouseClickMsg{X: x0, Y: y0, Button: tea.MouseLeft})
	steps := max(abs(x1-x0), abs(y1-y0))
	for i := 1; i <= steps; i++ {
		h.send(tea.MouseMotionMsg{X: x0 + (x1-x0)*i/steps, Y: y0 + (y1-y0)*i/steps, Button: tea.MouseLeft})
	}
	h.send(tea.MouseReleaseMsg{X: x1, Y: y1, Button: tea.MouseLeft})
}

func (h *roomHarness) tapAt(x, y int) {
	h.send(tea.MouseClickMsg{X: x, Y: y, Button: tea.MouseLeft})
	h.send(tea.MouseReleaseMsg{X: x, Y: y, Button: tea.MouseLeft})
}

func TestOnAPhoneADragScrollsAndASwipeGoesForwardOrBack(t *testing.T) {
	h := newRoomHarness(t, 40, 30)
	h.setup()
	h.press("esc")
	h.screen()
	a := h.app
	if !a.touchMode() {
		t.Fatal("touch should be on at phone width")
	}
	// Dragging down in the feed pulls the content down with the finger: it scrolls up, no selection.
	top := a.bodyTop()
	before := a.rm.feedVP.YOffset()
	if before < 4 {
		t.Fatalf("the feed should start scrolled to its end, at %d", before)
	}
	h.drag(10, top+1, 10, top+4)
	if got := a.rm.feedVP.YOffset(); got != before-3 {
		t.Fatalf("drag of 3 rows: offset %d → %d", before, got)
	}
	if a.sel.shown {
		t.Fatal("a drag on a phone shouldn't select text")
	}
	// Swiping left goes to the assistant; swiping right comes back.
	h.drag(30, top+2, 15, top+2)
	if a.rm.room.pane != paneAssistant {
		t.Fatal("swipe left should move to the assistant")
	}
	a.touch.lastSwipe = a.touch.lastSwipe.Add(-swipeEvery)
	h.drag(10, top+2, 30, top+2)
	if a.rm.room.pane != paneRoom {
		t.Fatal("swipe right should come back to the channel")
	}
	// Swiping right closes what's open.
	h.typ("/terms")
	h.press("enter")
	if a.rm.room.terms == nil {
		t.Fatal("/terms should open the glossary")
	}
	a.touch.lastSwipe = a.touch.lastSwipe.Add(-swipeEvery)
	h.drag(5, 10, 25, 10)
	if a.rm.room.terms != nil {
		t.Fatal("swipe right should close the glossary")
	}
	// /touch off: a drag selects text again.
	h.typ("/touch off")
	h.press("enter")
	h.screen()
	h.drag(10, top+1, 20, top+1)
	if !a.sel.shown && a.touchMode() {
		t.Fatal("with touch off, a drag should select")
	}
}

func TestSidewaysWheelStepsSwipeOnce(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("esc")
	h.screen()
	for i := 0; i < 6; i++ { // one swipe is a burst of steps
		h.send(tea.MouseWheelMsg{X: 20, Y: 20, Button: tea.MouseWheelRight})
	}
	if h.app.rm.room.pane != paneAssistant {
		t.Fatal("a sideways swipe left should move to the assistant, once")
	}
	h.app.touch.lastSwipe = h.app.touch.lastSwipe.Add(-swipeEvery)
	h.send(tea.MouseWheelMsg{X: 20, Y: 20, Button: tea.MouseWheelLeft})
	if h.app.rm.room.pane != paneRoom {
		t.Fatal("a sideways swipe right should come back")
	}
	// In the providers screen a swipe turns the tab.
	h.press("alt+o")
	h.press("up", "enter") // "just browse models", the last choice
	if h.app.prov == nil {
		t.Fatal("providers screen should be open")
	}
	tab := h.app.prov.tab
	h.app.touch.lastSwipe = h.app.touch.lastSwipe.Add(-swipeEvery)
	h.send(tea.MouseWheelMsg{X: 20, Y: 20, Button: tea.MouseWheelRight})
	if h.app.prov.tab == tab {
		t.Fatal("a swipe should turn the providers tab")
	}
}

func TestTapsPickAMessageRunAHintAndMoveTyping(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("esc")
	h.screen()
	a := h.app
	r := a.rm.room
	// A double tap on a message picks it and offers its shortcuts, without writing a card.
	top := a.bodyTop()
	var row feedRow
	for _, f := range r.feedRows {
		if y := f.from - a.rm.feedVP.YOffset(); y >= 0 && y < 10 {
			row = f
		}
	}
	if row.seq == 0 {
		t.Fatal("no message on screen")
	}
	y := top + row.from - a.rm.feedVP.YOffset()
	h.tapAt(12, y)
	h.tapAt(12, y)
	if r.spot == nil || r.spot.seq != row.seq {
		t.Fatalf("double tap should pick #%d, spot %+v", row.seq, r.spot)
	}
	contains(t, h.screen(), "t reply in a thread")
	for _, c := range h.fc.calls {
		if c.method == "room.highlight" {
			t.Fatal("a plain message shouldn't get a card")
		}
	}
	h.press("esc")
	// A tap on a footer hint runs it: ctrl+o opens the documents.
	h.screen()
	var docs footKey
	for _, k := range a.rm.footKeys {
		if k.key == "ctrl+o" {
			docs = k
		}
	}
	if docs.key == "" {
		t.Fatalf("footer hints: %+v", a.rm.footKeys)
	}
	h.tapAt(docs.from+1, a.rm.footY)
	if r.overlay == nil || r.overlay.title != "Documents" {
		t.Fatal("tapping ctrl+o docs should open the documents")
	}
	h.press("esc")
	// A tap on the assistant's column moves typing there.
	h.screen()
	h.tapAt(a.feedW()+5, top+3)
	if r.pane != paneAssistant {
		t.Fatal("a tap on the assistant should move typing there")
	}
}

func TestShiftWheelSwipesAndTheInputLogShowsWhatArrives(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("esc")
	h.screen()
	h.typ("/inputlog")
	h.press("enter")
	h.send(tea.MouseWheelMsg{X: 20, Y: 20, Button: tea.MouseWheelDown, Mod: tea.ModShift})
	if h.app.rm.room.pane != paneAssistant {
		t.Fatal("shift+wheel down should swipe forward to the assistant")
	}
	h.app.touch.lastSwipe = h.app.touch.lastSwipe.Add(-swipeEvery)
	h.send(tea.MouseWheelMsg{X: 20, Y: 20, Button: tea.MouseWheelUp, Mod: tea.ModShift})
	if h.app.rm.room.pane != paneRoom {
		t.Fatal("shift+wheel up should swipe back")
	}
	h.typ("/inputlog off")
	h.press("enter")
	b, err := os.ReadFile(inputLogPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "wheel   shift+wheeldown") || strings.Contains(string(b), `key     "tab"`) {
		t.Fatalf("log:\n%s", b)
	}
}
