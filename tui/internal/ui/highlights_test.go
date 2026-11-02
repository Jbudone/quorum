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
	contains(t, s, "╭─ HIGHLIGHTS ") // its own box across the top of the channel
	contains(t, s, m.From+" found that stale prices outlive the cache")
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
	h.send(tea.MouseClickMsg{X: 6, Y: h.app.stripTop() + 1, Button: tea.MouseLeft})
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

func TestHeldMembersShowInTheRosterUntilReleased(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("esc")
	h.event(rpc.RoomEvent{Type: "budget", Seq: 960, Level: "hold", CLI: "mock", Members: []string{"perf-researcher"}, Detail: "fable is out of usage credits; perf-researcher sits out. Move it to another model (/swap perf-researcher, or pick a model in alt+o and press enter), or add credits and resume."})
	s := h.screen()
	contains(t, s, "⏸ perf-researcher sitting out a limit")
	contains(t, s, "Limit: fable is out of usage credits")
	h.event(rpc.RoomEvent{Type: "budget", Seq: 961, Level: "release", CLI: "mock", Members: []string{"perf-researcher"}, Detail: "perf-researcher is back on mock sonnet"})
	lacks(t, h.screen(), "sitting out a limit")
}

func TestOlderChannelsGetHighlightsFromGists(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("esc")
	contains(t, h.screen(), "none yet: when a member finds a flaw")
	h.send(engineMsg{rpc.Event{Name: "room.support", Data: rpc.RoomSupportEvent{Role: "highlights", Busy: true}}})
	contains(t, h.screen(), "reading back through the channel")
	m := firstMemberMessage(t, h)
	h.event(rpc.RoomEvent{Type: "gists", Seq: 970, Items: []rpc.MessageTag{{Seq: m.Seq, From: m.From, Kind: "idea", Gist: "proposed an in-process cache per instance"}}})
	h.send(engineMsg{rpc.Event{Name: "room.support", Data: rpc.RoomSupportEvent{Role: "highlights", Busy: false}}})
	s := h.screen()
	contains(t, s, m.From+" proposed an in-process cache")
	lacks(t, s, "none yet")
}

func TestHoveringAHighlightShowsItsCard(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("esc")
	m := firstMemberMessage(t, h)
	h.event(rpc.RoomEvent{Type: "tags", Seq: 980, Items: []rpc.MessageTag{{Seq: m.Seq, From: m.From, Kind: "idea", Gist: "proposed a per-instance cache"}}})
	contains(t, h.screen(), "proposed a per-instance cache") // drawn, as the app draws after every event
	// Hovering the row asks for the card once, and says it's on its way.
	h.send(tea.MouseMotionMsg{X: 8, Y: h.app.stripTop() + 1})
	c := h.expectCall("room.highlight")
	if c.params["seq"] != m.Seq {
		t.Fatalf("card params %v", c.params)
	}
	contains(t, h.screen(), "writing a short summary")
	h.send(tea.MouseMotionMsg{X: 9, Y: h.app.stripTop() + 1})
	if n := len(h.fc.calls); h.fc.calls[n-1].method != "room.highlight" {
		t.Fatal("moving within the row shouldn't ask again")
	}
	h.reply("room.highlight", `{"text":"They proposed a cache in each instance.\n\n- reads drop to memory\n- stale for 30 s at most"}`)
	s := h.screen()
	contains(t, s, "They proposed a cache in each instance.")
	contains(t, s, "stale for 30 s at most")
	contains(t, s, "click to jump to it")
	// Moving away hides it; the card comes back from memory without asking again.
	calls := len(h.fc.calls)
	h.send(tea.MouseMotionMsg{X: 8, Y: h.app.bodyTop() + 20})
	lacks(t, h.screen(), "They proposed a cache in each instance.")
	h.send(tea.MouseMotionMsg{X: 8, Y: h.app.stripTop() + 1})
	contains(t, h.screen(), "They proposed a cache in each instance.")
	if len(h.fc.calls) != calls {
		t.Fatal("asked for a card it already had")
	}
}
