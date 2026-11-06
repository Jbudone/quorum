package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/jbud/quorum/tui/internal/rpc"
)

// Every screen lays itself out for the terminal: no line wider than it (it would wrap and shift
// everything under it) and no more lines than it has, from a phone over ssh to a wide window, and
// after resizing either way.
func TestEveryScreenFitsTheTerminal(t *testing.T) {
	sizes := [][2]int{{150, 46}, {100, 30}, {80, 24}, {60, 30}, {45, 40}, {38, 22}, {30, 16}}
	screens := []string{"", "alt+t", "ctrl+o", "alt+a", "alt+o", "alt+u", "alt+k", "alt+h", "alt+n", "alt+g", "?"}
	for _, open := range screens {
		h := newRoomHarness(t, 150, 46)
		h.setup()
		h.press("esc")
		m := firstMemberMessage(t, h)
		h.event(rpc.RoomEvent{Type: "tags", Seq: 990, Items: []rpc.MessageTag{{Seq: m.Seq, From: m.From, Kind: "idea", Gist: "proposed a per-instance cache with a thirty second bound"}}})
		if open != "" {
			h.press(open)
		}
		if open == "alt+t" {
			h.reply("room.glossary", `{"entries":[{"term":"ADR 0001","kind":"adr","brief":"Use an in-process LRU cache (accepted) — cache product reads for 30 s","source":"docs/adr/0001-cache.md"}]}`)
		}
		// Shrink step by step, then grow back: a resize must never leave the old layout behind.
		for _, sz := range append(sizes, sizes[0]) {
			h.send(tea.WindowSizeMsg{Width: sz[0], Height: sz[1]})
			lines := strings.Split(h.app.content(), "\n")
			if len(lines) > sz[1] {
				t.Errorf("%q at %dx%d: %d lines", open, sz[0], sz[1], len(lines))
			}
			for i, l := range lines {
				if w := ansi.StringWidth(l); w > sz[0] {
					t.Errorf("%q at %dx%d: line %d is %d wide: %q", open, sz[0], sz[1], i, w, ansi.Strip(l))
					break
				}
			}
		}
	}
}

func TestTheCouncilScreenFitsTheTerminal(t *testing.T) {
	h := newHarness(t, 150, 60)
	// The start screen first, then a round in progress.
	for _, sz := range [][2]int{{80, 24}, {45, 40}, {38, 22}, {30, 16}, {150, 60}} {
		h.send(tea.WindowSizeMsg{Width: sz[0], Height: sz[1]})
		for i, l := range strings.Split(h.app.content(), "\n") {
			if w := ansi.StringWidth(l); w > sz[0] {
				t.Errorf("start at %dx%d: line %d is %d wide: %q", sz[0], sz[1], i, w, ansi.Strip(l))
				break
			}
		}
	}
	h.press("tab")
	h.typ("topic")
	h.press("enter")
	h.reply(h.fc.last().id)
	h.feedThrough("awaiting_human")
	for _, sz := range [][2]int{{150, 60}, {80, 24}, {60, 30}, {38, 22}, {30, 16}, {150, 60}} {
		h.send(tea.WindowSizeMsg{Width: sz[0], Height: sz[1]})
		lines := strings.Split(h.app.content(), "\n")
		if len(lines) > sz[1] {
			t.Errorf("council at %dx%d: %d lines", sz[0], sz[1], len(lines))
		}
		for i, l := range lines {
			if w := ansi.StringWidth(l); w > sz[0] {
				t.Errorf("council at %dx%d: line %d is %d wide: %q", sz[0], sz[1], i, w, ansi.Strip(l))
				break
			}
		}
	}
}
