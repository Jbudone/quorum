package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// firstMemberMessage finds a member's message in the replayed channel.
func firstMemberMessage(t *testing.T, h *roomHarness) rpc.RoomEvent {
	t.Helper()
	for _, it := range h.app.rm.room.feed {
		if e := it.ev; e.Type == "message" && h.app.rm.room.isMember(e.From) && (e.Thread == 0 || e.Thread == e.Seq) {
			return e
		}
	}
	t.Fatal("no member message in the recording")
	return rpc.RoomEvent{}
}

func TestHighlightsJumpToTheMessageAndOfferShortcuts(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("esc")
	m := firstMemberMessage(t, h)
	h.event(rpc.RoomEvent{Type: "tags", Seq: 950, Items: []rpc.MessageTag{
		{Seq: m.Seq, From: m.From, Kind: "critique", Headline: "x", Gist: "found that stale prices outlive the cache"},
		{Seq: m.Seq + 1, From: m.From, Kind: "agreement", Headline: "agrees"}, // no gist: not a highlight
	}})
	s := h.screen()
	contains(t, s, "HIGHLIGHTS")
	contains(t, s, m.From+" found that stale prices")
	contains(t, s, "│   the cache") // wrapped onto a second line, not cut off
	lacks(t, s, "ask the assistant about it")

	// alt+h picks the newest highlight: the feed jumps to it, marks it and offers shortcuts.
	h.press("alt+h")
	s = h.screen()
	contains(t, s, "❯ "+m.From)
	contains(t, s, "a ask the assistant about it · d DM "+m.From+" · t reply in a thread · esc close")
	contains(t, s, "▌ ")
	if h.app.rm.feedFollow {
		t.Fatal("the feed should stay on the picked message, not follow the bottom")
	}

	// a asks the assistant about it.
	h.press("a")
	ask := h.callTo("room.ask")
	if q, _ := ask.params["text"].(string); !strings.Contains(q, "#") || !strings.Contains(q, "stale prices outlive the cache") {
		t.Fatalf("ask: %q", q)
	}
	lacks(t, h.screen(), "ask the assistant about it")

	// A click on the highlight's row picks it too; d starts a DM to its author.
	top := 3
	if h.app.statsShown() {
		top += statsHeight()
	}
	h.send(tea.MouseClickMsg{X: h.app.feedW() + 4, Y: top + h.app.rm.hlStart, Button: tea.MouseLeft})
	contains(t, h.screen(), "d DM "+m.From)
	h.press("d")
	if v := h.app.rm.roomIn.Value(); !strings.HasPrefix(v, "/dm "+m.From+" About #") {
		t.Fatalf("dm draft: %q", v)
	}

	// Any other key closes the spotlight and types as usual.
	h.app.rm.roomIn.Reset()
	h.press("alt+h")
	h.press("x")
	lacks(t, h.screen(), "ask the assistant about it")
	if v := h.app.rm.roomIn.Value(); v != "x" {
		t.Fatalf("typing after the spotlight: %q", v)
	}
}
