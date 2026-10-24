package ui

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// The whole journey against the real recorded engine output: pick a council, state a topic, watch
// round 1, steer, ask the Chair, continue, and finish.
func TestFullSessionJourney(t *testing.T) {
	h := newHarness(t, 140, 44)

	// Start screen lists the councils the engine offers.
	s := h.screen()
	contains(t, s, "CHOOSE A COUNCIL")
	for _, name := range []string{"solo", "trio", "delphi", "deep"} {
		contains(t, s, name)
	}

	h.press("down") // solo -> trio
	h.press("tab")
	h.press("enter") // no topic yet: must not start
	contains(t, h.screen(), "Tell the council what to work on")
	if h.fc.last().method != "clis.list" {
		t.Fatalf("started without a topic: %+v", h.fc.last())
	}
	h.typ("Replace session cookies with JWTs")
	h.press("enter")

	st := h.fc.last()
	if st.method != "session.start" || st.params["preset"] != "trio" || st.params["mock"] != true ||
		st.params["topic"] != "Replace session cookies with JWTs" || st.params["repo"] != "/work/proj" {
		t.Fatalf("bad session.start: %+v", st)
	}
	contains(t, h.screen(), "starting")

	h.reply(st.id)
	if h.fc.last().method != "session.continue" {
		t.Fatalf("the first round should start automatically, got %s", h.fc.last().method)
	}

	// Round 1 streams in, then the council waits for us.
	h.feedThrough("awaiting_human")
	h.feedThrough("idle")
	s = h.screen()
	contains(t, s, "Round 1 of 2")
	contains(t, s, "your turn")
	contains(t, s, "updated the plan")
	contains(t, s, "Chair · round 1 summary")
	contains(t, s, "PLAN · REVISION 1")
	contains(t, s, "OPEN QUESTIONS")
	contains(t, s, "DISSENT")
	lacks(t, s, "CONVERGED")  // raw chair report must not leak into the transcript
	lacks(t, s, "## DISSENT") // ...or its markdown sections

	// Steering is a directive, not a chat message.
	h.typ("/steer Prefer the smallest shippable slice.")
	h.press("enter")
	if c := h.fc.last(); c.method != "session.steer" || c.params["text"] != "Prefer the smallest shippable slice." {
		t.Fatalf("bad steer: %+v", c)
	}
	h.reply(h.fc.last().id)
	contains(t, h.screen(), "Prefer the smallest shippable slice.")

	// Asking the Chair is a job: input locks until the engine is idle again.
	h.typ("Why do they disagree?")
	h.press("enter")
	if c := h.fc.last(); c.method != "session.interject" || c.params["to"] != "chair" || c.params["text"] != "Why do they disagree?" {
		t.Fatalf("bad interject: %+v", c)
	}
	h.reply(h.fc.last().id)
	if h.app.sess.canType() {
		t.Fatal("input should be locked while the Chair answers")
	}
	h.feedThrough("idle")
	if !h.app.sess.canType() {
		t.Fatal("input should unlock once the engine is idle")
	}
	contains(t, h.screen(), "scope, not direction")

	// Pacing can be retuned mid-session.
	h.typ("/rounds 2")
	h.press("enter")
	if c := h.fc.last(); c.method != "session.configure" || c.params["rounds"] != 2 {
		t.Fatalf("bad configure: %+v", c)
	}
	h.reply(h.fc.last().id)
	h.feedThrough("config.changed")
	contains(t, h.screen(), "Pacing updated: 2 rounds")

	// An empty Enter continues; round 2 converges.
	h.press("enter")
	if h.fc.last().method != "session.continue" {
		t.Fatalf("empty Enter should continue, got %s", h.fc.last().method)
	}
	h.reply(h.fc.last().id)
	h.feedThrough("awaiting_human")
	h.feedThrough("idle")
	s = h.screen()
	contains(t, s, "Round 2 of 2")
	contains(t, s, "converged")
	contains(t, s, "finished")

	h.press("enter")
	h.reply(h.fc.last().id)
	h.feedThrough("session.done")
	h.feedThrough("idle")
	s = h.screen()
	contains(t, s, "complete")
	contains(t, s, "new session")
	if h.app.sess.canType() {
		t.Fatal("no input once the session is done")
	}
}

func TestInputParsing(t *testing.T) {
	h := newHarness(t, 120, 40)
	s := newSession(h.app.start.presets[1], "/r", "t", 0)
	cases := []struct {
		in         string
		kind, to   string
		text, errc string
	}{
		{"", "continue", "", "", ""},
		{"  ", "continue", "", "", ""},
		{"/stop", "stop", "", "", ""},
		{"/steer drop SSO", "steer", "", "drop SSO", ""},
		{"/steer", "error", "", "", "needs a directive"},
		{"/wat", "error", "", "", "unknown command /wat"},
		{"@skeptic what breaks?", "ask", "skeptic", "what breaks?", ""},
		{"@Skeptic casing", "ask", "skeptic", "casing", ""},
		{"@nobody hi", "error", "", "", "nobody called"},
		{"@skeptic", "error", "", "", "say something"},
		{"why is that?", "ask", "chair", "why is that?", ""},
	}
	for _, c := range cases {
		got := s.parseInput(c.in)
		if got.kind != c.kind || got.to != c.to || got.text != c.text || !strings.Contains(got.error, c.errc) {
			t.Errorf("parseInput(%q) = %+v", c.in, got)
		}
	}
}

func TestStartFailureReturnsToStartScreen(t *testing.T) {
	h := newHarness(t, 120, 40)
	h.press("tab")
	h.typ("anything")
	h.press("enter")
	id := h.fc.last().id
	h.send(engineMsg{rpcResponseErr(id, "no agent CLI is usable")})
	s := h.screen()
	contains(t, s, "CHOOSE A COUNCIL")
	contains(t, s, "no agent CLI is usable")
}

func TestLayoutNeverOverflows(t *testing.T) {
	for _, size := range [][2]int{{200, 55}, {140, 44}, {104, 30}, {103, 30}, {80, 24}, {60, 20}} {
		w, hgt := size[0], size[1]
		h := newHarness(t, w, hgt)
		check := func(stage string) {
			t.Helper()
			content := h.app.View().Content
			lines := strings.Split(content, "\n")
			if len(lines) > hgt {
				t.Errorf("%dx%d %s: %d lines exceed height", w, hgt, stage, len(lines))
			}
			for i, l := range lines {
				if lw := lipgloss.Width(l); lw > w {
					t.Errorf("%dx%d %s: line %d is %d wide (> %d): %q", w, hgt, stage, i, lw, w, ansi.Strip(l))
					return
				}
			}
		}
		check("start")
		h.press("tab")
		h.typ("A topic")
		h.press("enter")
		h.reply(h.fc.last().id)
		h.feedThrough("awaiting_human")
		h.feedThrough("idle")
		check("paused")
		h.press("ctrl+p")
		check("plan toggled")
	}
}

func TestScrollingKeepsOrReleasesTail(t *testing.T) {
	h := newHarness(t, 120, 30)
	h.press("tab")
	h.typ("topic")
	h.press("enter")
	h.reply(h.fc.last().id)
	h.feedThrough("awaiting_human")
	h.feedThrough("idle")
	if !h.app.follow || !h.app.transcript.AtBottom() {
		t.Fatal("transcript should follow the newest message")
	}
	h.press("pgup")
	if h.app.follow {
		t.Fatal("scrolling up should stop following")
	}
	h.press("pgdown", "pgdown", "pgdown", "pgdown", "pgdown", "pgdown")
	if !h.app.follow {
		t.Fatal("reaching the bottom should resume following")
	}
}

func TestQuitClosesEngine(t *testing.T) {
	h := newHarness(t, 120, 40)
	h.press("ctrl+c")
	if !h.fc.closed {
		t.Fatal("ctrl+c should close the engine")
	}
}
