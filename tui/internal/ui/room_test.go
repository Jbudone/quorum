package ui

import (
	"bufio"
	"os"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// roomHarness drives the app through a recorded room (scripts/record-session.ts). The app's request
// ids differ from the recording's, so each reply names the recorded response it answers with.
type roomHarness struct {
	*harness
	recorded map[int]rpc.Response
}

// newRoomHarness launches the app the way `quorum` does: straight into the room.
func newRoomHarness(t *testing.T, w, h int) *roomHarness {
	t.Helper()
	f, err := os.Open("../rpc/testdata/room.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rh := &roomHarness{harness: &harness{t: t, fc: &fakeCaller{}, responses: map[int]rpc.Response{}}, recorded: map[int]rpc.Response{}}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for sc.Scan() {
		m, err := rpc.Decode(sc.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		switch v := m.(type) {
		case rpc.Event:
			rh.events = append(rh.events, v)
		case rpc.Response:
			rh.recorded[v.ID] = v
		}
	}
	rh.app = New(Options{Client: rh.fc, Repo: "/work/proj", Mock: true})
	rh.send(tea.WindowSizeMsg{Width: w, Height: h})
	rh.app.Init()
	return rh
}

// answer replies to the app's request `id` with the recording's response `recorded`.
func (h *roomHarness) answer(id, recorded int) {
	h.t.Helper()
	r := h.recorded[recorded]
	r.ID = id
	h.send(engineMsg{r})
}

func (h *roomHarness) expectCall(method string) call {
	h.t.Helper()
	c := h.fc.last()
	if c.method != method {
		h.t.Fatalf("last call was %s %v, want %s", c.method, c.params, method)
	}
	return c
}

func (h *roomHarness) event(e rpc.RoomEvent) {
	h.send(engineMsg{rpc.Event{Name: "room.event", Data: e}})
}

// open answers the launch: no saved rooms, so the app starts an empty room and resumes it.
func (h *roomHarness) open() {
	h.t.Helper()
	list := h.expectCall("rooms.list")
	if list.params["repo"] != "/work/proj" {
		h.t.Fatalf("rooms.list params: %v", list.params)
	}
	h.answer(list.id, 1)
	start := h.expectCall("room.start")
	if start.params["repo"] != "/work/proj" || start.params["mock"] != true || start.params["preset"] != nil {
		h.t.Fatalf("room.start params: %v", start.params)
	}
	contains(h.t, h.screen(), "starting the room")
	h.answer(start.id, 2)
	h.answer(h.expectCall("room.resume").id, 3)
}

// replay delivers every recorded event: the room is staffed, talks, and pauses at a milestone.
func (h *roomHarness) replay() {
	for _, ev := range h.events {
		h.send(engineMsg{ev})
	}
}

func TestRoomJourney(t *testing.T) {
	h := newRoomHarness(t, 150, 44)
	h.open()
	s := h.screen()
	contains(t, s, "This room is empty")
	contains(t, s, "nobody in the room yet")
	contains(t, s, "I'm your assistant") // the assistant is on screen from the start
	contains(t, s, "Describe the problem you want worked out…")

	h.typ("Should we add a cache to the product API?")
	h.press("enter")
	if c := h.expectCall("room.post"); c.params["text"] != "Should we add a cache to the product API?" || c.params["to"] != nil {
		t.Fatalf("post params: %v", c.params)
	}

	h.replay()
	s = h.screen()
	contains(t, s, "Should we add a cache to the product API?") // the header names the topic
	contains(t, s, "Plan v2 answers every objection")           // the Chair's message in the feed
	contains(t, s, "accepted by the chair")
	contains(t, s, "PAUSED")
	contains(t, s, "WHERE WE ARE") // the assistant's pinned digest
	contains(t, s, "Plan is at v2.")
	contains(t, s, "You approved: bring in architect on mock")
	contains(t, s, "↩ skeptic") // replies name who they answer
	lacks(t, s, ">> ")          // action lines never show as prose
	lacks(t, s, "PASS")
	lacks(t, s, "passed")

	// A suggestion is approved with y once the assistant's box has the keyboard.
	h.event(rpc.RoomEvent{Type: "suggestion", Seq: 90, ID: 9, From: "assistant", Action: "add", Args: []string{"security", "claude"}, Why: "nobody covers abuse"})
	contains(t, h.screen(), "bring in security on claude")
	contains(t, h.screen(), "NEEDS YOUR OK · 2") // the recorded steer is still waiting too
	h.press("tab", "down", "y")
	if c := h.expectCall("room.resolve"); c.params["id"] != 9 || c.params["accept"] != true {
		t.Fatalf("resolve params: %v", c.params)
	}
	h.event(rpc.RoomEvent{Type: "suggestion.resolved", Seq: 91, ID: 9, Accepted: true})
	contains(t, h.screen(), "You approved: bring in security on claude")

	// Asking the assistant streams its answer, hiding action lines as they arrive.
	h.typ("what is the risk?")
	h.press("enter")
	if c := h.expectCall("room.ask"); c.params["text"] != "what is the risk?" {
		t.Fatalf("ask params: %v", c.params)
	}
	h.send(engineMsg{rpc.Event{Name: "room.assistant.delta", Data: rpc.AssistantDelta{Delta: "Stale reads (#8).\n>> pause: look"}}})
	contains(t, h.screen(), "Stale reads (#8).")
	lacks(t, h.screen(), ">> pause")
	h.press("tab")

	// The room box: open mentions, private messages, commands, and errors that explain themselves.
	h.typ("@nobody hi")
	h.press("enter")
	contains(t, h.screen(), `nobody called "nobody" here`)
	h.app.rm.roomIn.Reset() // the bad line stays in the box for fixing; clear it
	h.typ("@skeptic what number would you accept?")
	h.press("enter")
	if c := h.expectCall("room.post"); c.params["to"] != nil || c.params["text"] != "@skeptic what number would you accept?" {
		t.Fatalf("mention params: %v", c.params)
	}
	h.typ("/dm skeptic between us")
	h.press("enter")
	if c := h.expectCall("room.post"); c.params["to"] != "skeptic" || c.params["text"] != "between us" {
		t.Fatalf("dm params: %v", c.params)
	}
	h.typ("/parallel 3")
	h.press("enter")
	if c := h.expectCall("room.configure"); c.params["parallel"] != 3 {
		t.Fatalf("configure params: %v", c.params)
	}

	// Resuming, a member streams its words into the feed as it writes them.
	h.press("ctrl+p")
	h.expectCall("room.resume")
	h.send(engineMsg{rpc.Event{Name: "room.state", Data: rpc.RoomStateEvent{State: "running"}}})
	h.send(engineMsg{rpc.Event{Name: "room.turn.start", Data: rpc.RoomTurn{Agent: "skeptic"}}})
	h.send(engineMsg{rpc.Event{Name: "room.turn.delta", Data: rpc.RoomTurnDelta{Agent: "skeptic", Delta: "Let me check first."}}})
	h.send(engineMsg{rpc.Event{Name: "room.turn.tool", Data: rpc.RoomTurnTool{Agent: "skeptic", Name: "mcp__quorum__doc_draft"}}})
	contains(t, h.screen(), "skeptic drafting a document")
	lacks(t, h.screen(), "Let me check first.") // thinking aloud before a tool call is dropped
	h.send(engineMsg{rpc.Event{Name: "room.turn.delta", Data: rpc.RoomTurnDelta{Agent: "skeptic", Delta: "Sixty seconds, no more."}}})
	contains(t, h.screen(), "Sixty seconds, no more.▌")
	contains(t, h.screen(), "skeptic typing")
	contains(t, h.screen(), "TALKING")

	// Documents: the list, then one document.
	h.press("ctrl+o")
	contains(t, h.screen(), "plan  plan v2  ✓ v2 accepted")
	h.press("enter")
	h.answer(h.expectCall("room.doc").id, 9)
	contains(t, h.screen(), "cache layer for the product API")
	h.press("esc")
	lacks(t, h.screen(), "esc close")

	// Other rooms in this project.
	h.typ("/rooms")
	h.press("enter")
	h.answer(h.expectCall("rooms.list").id, 11)
	contains(t, h.screen(), "ROOMS IN THIS PROJECT")
	contains(t, h.screen(), "· this room")
	h.press("enter") // this room: just closes the list
	lacks(t, h.screen(), "ROOMS IN THIS PROJECT")
}

func TestRoomNarrowKeepsTheAssistantOnScreen(t *testing.T) {
	h := newRoomHarness(t, 56, 40)
	h.open()
	h.replay()
	s := h.screen()
	contains(t, s, "Plan v2 answers every objection")
	contains(t, s, "WHERE WE ARE")
}

func TestRoomReopensTheLatestRoom(t *testing.T) {
	h := newRoomHarness(t, 150, 44)
	h.answer(h.expectCall("rooms.list").id, 11)
	open := h.expectCall("room.open")
	if open.params["repo"] != "/work/proj" || open.params["id"] == "" {
		t.Fatalf("open params: %v", open.params)
	}
	h.answer(open.id, 12)
	s := h.screen()
	// It paused for a milestone, so it waits for the human instead of carrying on by itself.
	contains(t, s, "This room is paused (milestone: plan v2 accepted)")
	contains(t, s, "WHERE WE ARE")
	if h.fc.last().method == "room.resume" {
		t.Fatal("a room paused at a milestone should not resume by itself")
	}

	// A room that paused only because the app closed picks up where it left off.
	r := newRoom(rpc.RoomSnapshot{Agents: []rpc.PresetAgent{{ID: "arch"}}, Events: []rpc.RoomEvent{{Type: "paused", Seq: 9, Reason: "closed"}}}, true)
	if !r.resumesOnOpen() {
		t.Fatal("a room closed with the app should resume on open")
	}
}

func TestRoomStartError(t *testing.T) {
	h := newRoomHarness(t, 150, 44)
	h.answer(h.expectCall("rooms.list").id, 1)
	h.send(engineMsg{rpcResponseErr(h.expectCall("room.start").id, "no usable CLIs")})
	contains(t, h.screen(), "✗ no usable CLIs")
}

func TestParseRoomInput(t *testing.T) {
	r := &roomModel{agents: []rpc.PresetAgent{{ID: "arch"}}, focus: "main"}
	cases := map[string]string{
		"hello":                       "room.post",
		"@arch hi":                    "room.post",
		"/dm arch hi":                 "room.post",
		"/pause tea":                  "room.pause",
		"/resume":                     "room.resume",
		"/turns 5":                    "room.configure",
		"/focus main":                 "room.focus",
		"/close main":                 "room.closeTopic",
		"/raise Rollout":              "room.raise",
		"/doc plan":                   "room.doc",
		"/export issue-x":             "room.export",
		"/add security claude sonnet": "room.add",
		"/remove arch":                "room.remove",
		"/rejoin arch":                "room.rejoin",
	}
	for in, want := range cases {
		if got := r.parseRoomInput(in); got.method != want || got.err != "" {
			t.Errorf("%q → %+v, want %s", in, got, want)
		}
	}
	for in, want := range map[string]string{"/new": "new", "/rooms": "rooms", "/docs": "docs", "/help": "help"} {
		if got := r.parseRoomInput(in); got.local != want {
			t.Errorf("%q → %+v, want local %s", in, got, want)
		}
	}
	for _, bad := range []string{"/parallel x", "/add security", "/focus", "/nope", "@arch", "@zed hi", "/dm arch", "/dm zed hi", "/leave"} {
		if got := r.parseRoomInput(bad); got.err == "" {
			t.Errorf("%q should be an error, got %+v", bad, got)
		}
	}
	if got := r.parseRoomInput("@arch hi"); got.params["to"] != nil {
		t.Errorf("an @mention is said to the room: %+v", got)
	}
	if got := r.parseRoomInput("/add security claude sonnet"); got.params["model"] != "sonnet" {
		t.Errorf("model not passed: %+v", got)
	}
}
