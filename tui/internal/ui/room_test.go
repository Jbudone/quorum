package ui

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// roomHarness drives the app through a recorded channel (scripts/record-session.ts). The app's request
// ids differ from the recording's, so each reply names the recorded response it answers with.
type roomHarness struct {
	*harness
	recorded map[int]rpc.Response
	setupEv  []rpc.Event // the setup chat's events
	roomEv   []rpc.Event // everything after the channel opened
}

// newRoomHarness launches the app the way `quorum` does: straight into the workspace.
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
			if strings.HasPrefix(v.Name, "setup.") {
				rh.setupEv = append(rh.setupEv, v)
			} else {
				rh.roomEv = append(rh.roomEv, v)
			}
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

// callTo finds the app's latest request for a method (others may have followed it).
func (h *roomHarness) callTo(method string) call {
	h.t.Helper()
	for i := len(h.fc.calls) - 1; i >= 0; i-- {
		if h.fc.calls[i].method == method {
			return h.fc.calls[i]
		}
	}
	h.t.Fatalf("no %s call", method)
	return call{}
}

// pick moves the open list to the entry containing text and opens it.
func (h *roomHarness) pick(text string) {
	h.t.Helper()
	for _, d := range h.app.rm.room.overlay.list {
		if strings.Contains(d.label, text) {
			h.press("enter")
			return
		}
		h.press("down")
	}
	h.t.Fatalf("nothing in the list says %q", text)
}

// review enters review mode and moves to the suggestion with this id.
func (h *roomHarness) review(id int) {
	h.t.Helper()
	h.press("ctrl+n")
	for _, p := range h.app.rm.room.pending {
		if p.ID == id {
			return
		}
		h.press("down")
	}
	h.t.Fatalf("no pending suggestion %d", id)
}

func (h *roomHarness) event(e rpc.RoomEvent) {
	h.send(engineMsg{rpc.Event{Name: "room.event", Data: e}})
}

// setup answers the first launch: no channels, so the app opens the setup chat. It talks the
// lineup through and opens the channel, then replays the recorded channel until its milestone pause.
func (h *roomHarness) setup() {
	h.t.Helper()
	ws := h.expectCall("workspace.open")
	if ws.params["repo"] != "/work/proj" {
		h.t.Fatalf("workspace.open params: %v", ws.params)
	}
	h.answer(ws.id, 1)
	start := h.expectCall("setup.start")
	if start.params["repo"] != "/work/proj" || start.params["mock"] != true {
		h.t.Fatalf("setup.start params: %v", start.params)
	}
	h.answer(start.id, 2)
	s := h.screen()
	contains(h.t, s, "new channel")
	contains(h.t, s, "What should this channel work on?")
	if h.app.w >= 90 {
		contains(h.t, s, "The plan appears here") // beside the chat; on narrow screens it waits for a plan
	}
	lacks(h.t, s, "RECENT") // no channel, no stats, until the human approves a lineup

	h.typ("Should we add a cache to the product API?")
	h.press("enter")
	if c := h.expectCall("setup.say"); c.params["text"] != "Should we add a cache to the product API?" {
		h.t.Fatalf("say params: %v", c.params)
	}
	contains(h.t, h.screen(), "typing…") // the assistant visibly working
	h.answer(h.fc.last().id, 3)
	// The first reply asks two choice-card questions; answering both sends them together.
	first := 0
	for i, ev := range h.setupEv {
		if ev.Name == "setup.reply" {
			first = i
			break
		}
	}
	for _, ev := range h.setupEv[:first+1] {
		h.send(engineMsg{ev})
	}
	s = h.screen()
	contains(h.t, s, "GOAL  1 of 2")
	contains(h.t, s, "Ship something soon (recommended)")
	contains(h.t, s, "type your own…")
	lacks(h.t, s, ">> option")
	h.press("enter") // the recommended answer
	contains(h.t, h.screen(), "DOCS  2 of 2")
	h.press("down", "down", "enter")
	h.typ("notes are in docs/")
	h.press("enter")
	if c := h.expectCall("setup.say"); c.params["text"] != "Goal: Ship something soon\nDocs: notes are in docs/" {
		h.t.Fatalf("answers: %q", c.params["text"])
	}
	h.answer(h.fc.last().id, 4)
	for _, ev := range h.setupEv[first+1:] {
		h.send(engineMsg{ev})
	}
	s = h.screen()
	contains(h.t, s, "#product-cache")
	contains(h.t, s, "perf-researcher · mock")
	contains(h.t, s, "Edge cases for cached prices")
	contains(h.t, s, "ctrl+s review and apply")
	lacks(h.t, s, ">> member") // action lines never show as prose

	// The plan form: everything included until left out.
	h.press("ctrl+s")
	s = h.screen()
	contains(h.t, s, "THE PLAN")
	contains(h.t, s, "[x] tenants sharing one cache")
	h.press("enter")
	create := h.expectCall("setup.create")
	if p, ok := create.params["proposal"].(*rpc.SetupProposal); !ok || p.Name != "product-cache" || len(p.Members) != 3 {
		h.t.Fatalf("create params: %#v", create.params)
	}
	h.answer(create.id, 5)
	h.answer(h.callTo("room.resume").id, 6)
	h.answer(h.callTo("workspace.open").id, 12)
	for _, ev := range h.roomEv {
		h.send(engineMsg{ev})
	}
}

func TestRoomJourney(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	s := h.screen()
	contains(t, s, "proj › #product-cache")           // workspace › channel
	contains(t, s, "Plan v2 answers every objection") // the Chair in the feed
	contains(t, s, "RECENT")                          // the stats strip
	contains(t, s, "DISCUSSIONS")
	contains(t, s, "MEMBERS")
	contains(t, s, "plan v2 accepted")
	contains(t, s, "WHERE WE ARE") // the assistant's pinned status
	contains(t, s, "Not on the reading list")
	contains(t, s, "↳ thread: ") // threads under their messages in the channel
	contains(t, s, "· settled")
	lacks(t, s, "nobody pays a stale price") // ...but not the thread's replies
	lacks(t, s, ">> ")
	lacks(t, s, "PASS")

	// A suggestion waits in the "needs you" card; nothing is selected until ctrl+n.
	h.event(rpc.RoomEvent{Type: "suggestion", Seq: 90, ID: 9, From: "assistant", Action: "steer", Args: []string{"Settle the TTL first."}, Why: "they keep circling"})
	s = h.screen()
	contains(t, s, fmt.Sprintf("NEEDS YOU · %d", len(h.app.rm.room.pending))) // recorded suggestions are still waiting too
	contains(t, s, "steer the room: “Settle the TTL first.”")
	contains(t, s, "ctrl+n to review")
	lacks(t, s, "❯ steer")

	// With suggestions waiting, typing in the assistant's box and pressing Enter sends the question.
	h.press("tab")
	h.typ("is the steer worth it?")
	h.press("enter")
	if c := h.expectCall("room.ask"); c.params["text"] != "is the steer worth it?" {
		t.Fatalf("enter should ask, got %s %v", c.method, c.params)
	}
	h.send(engineMsg{rpc.Event{Name: "room.assistant.delta", Data: rpc.AssistantDelta{Delta: "Yes, nobody covers abuse.\n>> pause: look"}}})
	contains(t, h.screen(), "Yes, nobody covers abuse.")
	lacks(t, h.screen(), ">> pause")

	// Reviewing: keys answer suggestions and never reach the text box.
	h.review(9)
	contains(t, h.screen(), "❯ steer the room")
	h.press("y")
	if c := h.expectCall("room.resolve"); c.params["id"] != 9 || c.params["accept"] != true {
		t.Fatalf("resolve params: %v", c.params)
	}
	if v := h.app.rm.assistIn.Value(); v != "" {
		t.Fatalf("review keys leaked into the box: %q", v)
	}
	h.event(rpc.RoomEvent{Type: "suggestion.resolved", Seq: 91, ID: 9, Accepted: true})
	contains(t, h.screen(), "You approved: steer the room")
	h.press("esc", "tab")

	// The room box: open mentions, private messages, commands, and errors that explain themselves.
	h.typ("@nobody hi")
	h.press("enter")
	contains(t, h.screen(), `nobody called "nobody" here`)
	h.app.rm.roomIn.Reset() // the bad line stays in the box for fixing; clear it
	h.typ("/dm reliability-scientist between us")
	h.press("enter")
	if c := h.expectCall("room.post"); c.params["to"] != "reliability-scientist" || c.params["text"] != "between us" {
		t.Fatalf("dm params: %v", c.params)
	}
	h.typ("/independent on")
	h.press("enter")
	if c := h.expectCall("room.configure"); c.params["independent"] != true {
		t.Fatalf("configure params: %v", c.params)
	}

	// A side question goes into a new thread, and the screen follows it there.
	h.typ("/ask How long can a price be stale?")
	h.press("enter")
	ask := h.expectCall("room.post")
	if ask.params["thread"] != "new" || ask.params["text"] != "How long can a price be stale?" {
		t.Fatalf("ask params: %v", ask.params)
	}
	h.answer(ask.id, 10)
	s = h.screen()
	contains(t, s, "thread: How long can a price be stale?")
	contains(t, s, "nobody pays a stale price") // the reply inside the thread
	contains(t, s, "esc back to the channel")
	h.typ("thanks")
	h.press("enter")
	var asked struct{ Seq int }
	_ = json.Unmarshal(h.recorded[10].Result, &asked)
	if c := h.expectCall("room.post"); c.params["thread"] != asked.Seq {
		t.Fatalf("a reply in a thread should stay in it: %v", c.params)
	}
	h.press("esc")
	lacks(t, h.screen(), "nobody pays a stale price")

	// Members stream in as they write; support roles show they're working.
	contains(t, h.screen(), "❚❚ PAUSED")
	h.press("ctrl+p")
	h.expectCall("room.resume")
	h.send(engineMsg{rpc.Event{Name: "room.state", Data: rpc.RoomStateEvent{State: "running"}}})
	contains(t, h.screen(), "▶ Resumed. The channel is live again.") // and the bar no longer says paused
	lacks(t, h.screen(), "❚❚ PAUSED")
	h.send(engineMsg{rpc.Event{Name: "room.support", Data: rpc.RoomSupportEvent{Role: "floor", Busy: true}}})
	contains(t, h.screen(), "deciding who speaks")
	h.send(engineMsg{rpc.Event{Name: "room.turn.start", Data: rpc.RoomTurn{Agent: "product-engineer"}}})
	h.send(engineMsg{rpc.Event{Name: "room.turn.delta", Data: rpc.RoomTurnDelta{Agent: "product-engineer", Delta: "Let me check."}}})
	h.send(engineMsg{rpc.Event{Name: "room.turn.tool", Data: rpc.RoomTurnTool{Agent: "product-engineer", Name: "mcp__quorum__doc_draft"}}})
	contains(t, h.screen(), "product-engineer drafting a document")
	lacks(t, h.screen(), "Let me check.") // thinking aloud before a tool call is dropped
	h.send(engineMsg{rpc.Event{Name: "room.turn.delta", Data: rpc.RoomTurnDelta{Agent: "product-engineer", Delta: "Sixty seconds, no more."}}})
	contains(t, h.screen(), "Sixty seconds, no more.▌")
	lacks(t, h.screen(), "❚❚ PAUSED")

	// The stats strip can be put away.
	h.press("ctrl+t")
	lacks(t, h.screen(), "DISCUSSIONS")
	h.press("ctrl+t")

	// Documents.
	h.press("ctrl+o")
	contains(t, h.screen(), "plan  plan v2  ✓ v2 accepted")
	h.press("enter")
	h.answer(h.expectCall("room.doc").id, 8)
	contains(t, h.screen(), "cache layer for the product API")
	h.press("esc")

	// The switcher: channels, this channel's threads, and a new channel.
	h.press("ctrl+k")
	h.answer(h.expectCall("workspace.open").id, 12)
	s = h.screen()
	contains(t, s, "SWITCH TO")
	contains(t, s, "# product-cache  · here")
	contains(t, s, "↳ How long can a price be stale?  · settled")
	contains(t, s, "+ new channel")
	h.pick("How long can a price be stale?")
	contains(t, h.screen(), "thread: How long can a price be stale?")
	h.press("esc", "ctrl+k")
	h.answer(h.expectCall("workspace.open").id, 12)
	h.pick("+ new channel")
	h.expectCall("setup.start")
	contains(t, h.screen(), "What should this channel work on?")
}

// reply answers the app's latest request for a method with a hand-written result.
func (h *roomHarness) reply(method, result string) call {
	h.t.Helper()
	c := h.callTo(method)
	h.send(engineMsg{rpc.Response{ID: c.id, Result: json.RawMessage(result)}})
	return c
}

func TestRoomJoinModal(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("ctrl+a")
	h.answer(h.callTo("workspace.open").id, 12) // everyone in the workspace is already here, so "who" is skipped
	h.reply("personas.list", `[{"key":"skeptic","name":"Skeptic","role":"critic","custom":false}]`)
	h.reply("clis.list", `[{"cli":"claude","usable":true,"models":["sonnet"]},{"cli":"mock","usable":true,"models":[]}]`)
	s := h.screen()
	contains(t, s, "BRING SOMEONE IN")
	contains(t, s, "describe them in a line")
	contains(t, s, "skeptic  critic")

	// Describe in a line; the assistant drafts a persona to edit.
	h.press("enter")
	h.typ("someone who checks tenant isolation")
	h.press("enter")
	if c := h.expectCall("persona.draft"); c.params["line"] != "someone who checks tenant isolation" {
		t.Fatalf("draft params: %v", c.params)
	}
	h.reply("persona.draft", `{"id":"tenancy-auditor","role":"multi-tenancy auditor","persona":"Audits caches for leaks."}`)
	contains(t, h.screen(), "tenancy-auditor")
	contains(t, h.screen(), "Audits caches for leaks.")
	h.press("enter") // past the persona: on to the model

	// Only the CLIs this channel runs on are offered (a mock channel never reaches a real CLI).
	s = h.screen()
	contains(t, s, "❯ mock")
	lacks(t, s, "claude")
	h.press("enter")
	if c := h.expectCall("models.list"); c.params["cli"] != "mock" {
		t.Fatalf("models.list params: %v", c.params)
	}
	h.reply("models.list", `[{"id":"scripted","label":"scripted mock cast"},{"id":"other","label":"another"}]`)
	contains(t, h.screen(), "(default)")
	h.typ("scrip") // search narrows the list
	s = h.screen()
	contains(t, s, "❯ scripted")
	lacks(t, s, "another")
	h.press("enter")

	// Onboarding: the brief is on by default; a first question is optional.
	contains(t, h.screen(), "[x] catch-up brief")
	h.press("down", "down")
	h.typ("Are keys tenant-scoped?")
	h.press("enter")
	join := h.expectCall("room.join")
	want := map[string]any{"id": "tenancy-auditor", "cli": "mock", "model": "scripted", "role": "multi-tenancy auditor", "persona": "Audits caches for leaks.", "brief": true, "question": "Are keys tenant-scoped?"}
	for k, v := range want {
		if join.params[k] != v {
			t.Fatalf("join %s = %v, want %v (%v)", k, join.params[k], v, join.params)
		}
	}
	if _, ok := join.params["reading"]; ok {
		t.Fatalf("an unchanged reading list is left to the channel: %v", join.params)
	}
	contains(t, h.screen(), "onboarding tenancy-auditor")
	h.reply("room.join", `{"id":"tenancy-auditor"}`)
	lacks(t, h.screen(), "BRING SOMEONE IN")
	contains(t, h.screen(), "tenancy-auditor joined.")

	// y on the assistant's "bring in" suggestion opens the modal filled in, ready to join as proposed.
	h.event(rpc.RoomEvent{Type: "suggestion", Seq: 90, ID: 9, From: "assistant", Action: "hire", Args: []string{"edge-case-hunter", "mock", "", "edge-case hunter", "Finds what breaks."}, Why: "nobody covers abuse"})
	h.review(9)
	h.press("y")
	s = h.screen()
	contains(t, s, "BRING SOMEONE IN")
	contains(t, s, "edge-case-hunter on mock")
	h.press("enter")
	join = h.expectCall("room.join")
	if join.params["suggestion"] != 9 || join.params["persona"] != "Finds what breaks." {
		t.Fatalf("prefilled join params: %v", join.params)
	}

	// /add alone opens it too; esc backs out step by step.
	h.reply("room.join", `{"id":"edge-case-hunter"}`)
	h.typ("/add")
	h.press("enter")
	contains(t, h.screen(), "BRING SOMEONE IN")
	h.answer(h.callTo("workspace.open").id, 12)
	h.press("esc", "esc")
	lacks(t, h.screen(), "BRING SOMEONE IN")
}

func TestRoomNarrowKeepsTheAssistantOnScreen(t *testing.T) {
	h := newRoomHarness(t, 56, 40)
	h.setup()
	s := h.screen()
	contains(t, s, "Plan v2 answers every objection")
	contains(t, s, "WHERE WE ARE")
}

func TestRoomReopensTheLatestChannel(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.answer(h.expectCall("workspace.open").id, 12)
	open := h.expectCall("room.open")
	if open.params["repo"] != "/work/proj" || open.params["id"] == "" {
		t.Fatalf("open params: %v", open.params)
	}
	h.answer(open.id, 13)
	s := h.screen()
	// The human paused it, so it waits instead of carrying on by itself.
	contains(t, s, "❚❚ PAUSED · you paused it.") // the status bar says so, with why
	contains(t, s, "ctrl+p resume")
	contains(t, s, "Paused · you can still write")
	contains(t, s, "WHERE WE ARE")
	if h.callTo("workspace.open").id == 1 {
		t.Fatal("the switcher's channel list should refresh once the channel is open")
	}
	for _, c := range h.fc.calls {
		if c.method == "room.resume" {
			t.Fatal("a channel the human paused should not resume by itself")
		}
	}

	// A channel paused only because the app closed (or you switched away) picks up where it left off.
	for _, why := range []string{"closed", "switched away"} {
		r := newRoom(rpc.RoomSnapshot{Agents: []rpc.PresetAgent{{ID: "arch"}}, Events: []rpc.RoomEvent{{Type: "paused", Seq: 9, Reason: why}}}, true)
		if !r.resumesOnOpen() {
			t.Fatalf("a channel paused as %q should resume on open", why)
		}
	}
}

func TestRoomSetupError(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.answer(h.expectCall("workspace.open").id, 1)
	h.answer(h.expectCall("setup.start").id, 2)
	h.typ("x")
	h.press("enter")
	h.send(engineMsg{rpcResponseErr(h.expectCall("setup.say").id, "no usable CLIs")})
	contains(t, h.screen(), "✗ no usable CLIs")
	lacks(t, h.screen(), "typing…")
}

func TestParseRoomInput(t *testing.T) {
	r := &roomModel{agents: []rpc.PresetAgent{{ID: "arch"}}, focus: "main", authors: map[int]string{12: "arch"}}
	cases := map[string]string{
		"hello":                       "room.post",
		"@arch hi":                    "room.post",
		"/dm arch hi":                 "room.post",
		"/ask why?":                   "room.post",
		"/pause tea":                  "room.pause",
		"/resume":                     "room.resume",
		"/turns 5":                    "room.configure",
		"/independent off":            "room.configure",
		"/read docs/design notes.md":  "room.read",
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
	for in, want := range map[string]string{"/add": "join", "/new": "new", "/rooms": "switch", "/docs": "docs", "/help": "help", "/thread 12": "thread", "/ask why?": "open-thread"} {
		if got := r.parseRoomInput(in); got.local != want {
			t.Errorf("%q → %+v, want local %s", in, got, want)
		}
	}
	for _, bad := range []string{"/parallel x", "/add security", "/focus", "/nope", "@arch", "@zed hi", "/dm arch", "/dm zed hi", "/thread 99", "/thread x", "/independent maybe", "/read", "/ask"} {
		if got := r.parseRoomInput(bad); got.err == "" {
			t.Errorf("%q should be an error, got %+v", bad, got)
		}
	}
	if got := r.parseRoomInput("/ask why?"); got.params["thread"] != "new" {
		t.Errorf("/ask starts a thread: %+v", got)
	}
	if got := r.parseRoomInput("/read docs/design notes.md"); len(got.params["paths"].([]string)) != 2 {
		t.Errorf("/read takes several paths: %+v", got)
	}
}
