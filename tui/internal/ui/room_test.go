package ui

import (
	"bufio"
	"os"
	"strings"
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
	for _, c := range rh.fc.calls { // presets.list, personas.list, clis.list: ids 1-3 in both
		rh.answer(c.id, c.id)
	}
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

// open starts a room from the start screen and replays the whole recording into it.
func (h *roomHarness) open() {
	h.t.Helper()
	h.press("ctrl+r")
	h.answer(h.expectCall("rooms.list").id, 10)
	contains(h.t, h.screen(), "WHO'S IN THE ROOM")
	contains(h.t, h.screen(), "OR REOPEN A ROOM")
	h.press("tab")
	h.typ("Should we add a cache to the product API?")
	h.press("enter")
	start := h.expectCall("room.start")
	if start.params["topic"] != "Should we add a cache to the product API?" || start.params["mock"] != true {
		h.t.Fatalf("room.start params: %v", start.params)
	}
	contains(h.t, h.screen(), "starting the room")
	h.answer(start.id, 4)
	h.expectCall("room.resume")
	for _, ev := range h.events {
		h.send(engineMsg{ev})
	}
}

func TestRoomJourney(t *testing.T) {
	h := newRoomHarness(t, 150, 44)
	h.open()
	s := h.screen()
	contains(t, s, "// room // should-we-add-a-cache")
	contains(t, s, "Starting point: an in-process LRU") // a member's message in the feed
	contains(t, s, "architect wrote plan v1")           // a document revision
	contains(t, s, "PAUSED")                            // the recording ends paused
	contains(t, s, "where are we?")                     // the human's question in the assistant pane
	contains(t, s, "they agree on a simple")
	contains(t, s, "assistant") // the recorded answer is labeled as the assistant's answer, not a note
	contains(t, s, "You approved: steer the room")
	lacks(t, s, ">> steer") // action lines never show as prose

	// A new suggestion appears under the assistant and is approved with y once that box has focus.
	h.event(rpc.RoomEvent{Type: "suggestion", Seq: 90, ID: 9, From: "assistant", Action: "add", Args: []string{"security", "claude"}, Why: "nobody covers abuse"})
	contains(t, h.screen(), "add a member: security claude")
	contains(t, h.screen(), "1 SUGGESTION")
	h.press("tab", "y")
	if c := h.expectCall("room.resolve"); c.params["id"] != 9 || c.params["accept"] != true {
		t.Fatalf("resolve params: %v", c.params)
	}
	h.event(rpc.RoomEvent{Type: "suggestion.resolved", Seq: 91, ID: 9, Accepted: true})
	contains(t, h.screen(), "You approved: add a member: security claude")

	// Asking the assistant streams its answer, hiding action lines as they arrive.
	h.typ("what is the risk?")
	h.press("enter")
	ask := h.expectCall("room.ask")
	if ask.params["text"] != "what is the risk?" {
		t.Fatalf("ask params: %v", ask.params)
	}
	h.send(engineMsg{rpc.Event{Name: "room.assistant.delta", Data: rpc.AssistantDelta{Delta: "Stale reads (#8).\n>> pause: look"}}})
	contains(t, h.screen(), "Stale reads (#8).")
	lacks(t, h.screen(), ">> pause")
	h.press("tab")

	// The room box: DMs, commands, and errors that explain themselves.
	h.typ("@nobody hi")
	h.press("enter")
	contains(t, h.screen(), `nobody called "nobody" here`)
	h.app.rm.roomIn.Reset() // the bad line stays in the box for fixing; clear it
	h.typ("@skeptic what number would you accept?")
	h.press("enter")
	if c := h.expectCall("room.post"); c.params["to"] != "skeptic" {
		t.Fatalf("dm params: %v", c.params)
	}
	h.typ("/parallel 3")
	h.press("enter")
	if c := h.expectCall("room.configure"); c.params["parallel"] != 3 {
		t.Fatalf("configure params: %v", c.params)
	}
	h.press("ctrl+p")
	h.expectCall("room.resume") // paused, so ctrl+p resumes
	h.send(engineMsg{rpc.Event{Name: "room.state", Data: rpc.RoomStateEvent{State: "running"}}})
	h.send(engineMsg{rpc.Event{Name: "room.turn.start", Data: rpc.RoomTurn{Agent: "skeptic"}}})
	h.send(engineMsg{rpc.Event{Name: "room.turn.tool", Data: rpc.RoomTurnTool{Agent: "skeptic", Name: "mcp__quorum__post"}}})
	contains(t, h.screen(), "skeptic is thinking · post")
	contains(t, h.screen(), "IN SESSION")

	// Documents: the list, then one document.
	h.press("ctrl+o")
	contains(t, h.screen(), "plan  plan v1")
	h.press("enter")
	h.answer(h.expectCall("room.doc").id, 8)
	contains(t, h.screen(), "cache layer for the product API")
	h.press("esc")
	lacks(t, h.screen(), "esc close")

	h.typ("/leave")
	h.press("enter")
	h.expectCall("rooms.list")
	contains(t, h.screen(), "WHO'S IN THE ROOM")
}

func TestRoomNarrowUsesTabs(t *testing.T) {
	h := newRoomHarness(t, 80, 40)
	h.open()
	s := h.screen()
	contains(t, s, "Starting point: an in-process LRU")
	lacks(t, s, "where are we?")
	h.press("tab")
	s = h.screen()
	contains(t, s, "where are we?")
	lacks(t, s, "Starting point: an in-process LRU")
}

func TestRoomReopenAndStartErrors(t *testing.T) {
	h := newRoomHarness(t, 150, 44)
	h.press("ctrl+r")
	h.answer(h.expectCall("rooms.list").id, 10)
	h.press("tab", "tab", "enter") // presets → topic → saved rooms, open the first
	open := h.expectCall("room.open")
	if open.params["repo"] != "/work/proj" || open.params["id"] == "" {
		t.Fatalf("open params: %v", open.params)
	}
	h.answer(open.id, 11)
	contains(t, h.screen(), "Room reopened and paused")

	// A failed start goes back to the start screen with the reason.
	h2 := newRoomHarness(t, 150, 44)
	h2.press("ctrl+r", "tab")
	h2.typ("x")
	h2.press("enter")
	h2.send(engineMsg{rpcResponseErr(h2.expectCall("room.start").id, "no usable CLIs")})
	s := h2.screen()
	contains(t, s, "no usable CLIs")
	if !strings.Contains(s, "WHO'S IN THE ROOM") {
		t.Fatalf("expected the start screen:\n%s", s)
	}
}

func TestParseRoomInput(t *testing.T) {
	r := &roomModel{agents: []rpc.PresetAgent{{ID: "arch"}}, focus: "main"}
	cases := map[string]string{
		"hello":                       "room.post",
		"@arch hi":                    "room.post",
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
	for _, bad := range []string{"/parallel x", "/add security", "/focus", "/nope", "@arch", "@zed hi"} {
		if got := r.parseRoomInput(bad); got.err == "" {
			t.Errorf("%q should be an error, got %+v", bad, got)
		}
	}
	if got := r.parseRoomInput("/add security claude sonnet"); got.params["model"] != "sonnet" {
		t.Errorf("model not passed: %+v", got)
	}
}
