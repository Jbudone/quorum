package ui

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

func sampleDebate() *debateData {
	return &debateData{round: 1, agree: 1, pct: 33, members: []debateMember{
		{id: "architect", color: 0, stance: "agree", conf: 78, headline: "Short-lived JWTs with refresh rotation"},
		{id: "skeptic", color: 1, stance: "disagree", conf: 80, headline: "Rotation needs reuse detection and an exit plan"},
		{id: "pragmatist", color: 2, stance: "mixed", conf: 70, headline: "Ship the token service alone first"},
	}}
}

func TestDebateFinalFrameShowsEveryone(t *testing.T) {
	out := ansi.Strip(renderDebate(sampleDebate(), 90, theme.Default(), 0, false, 0))
	for _, want := range []string{"ROUND 1 DEBATE", "1 of 3 agree", "agreement  33%", "✓ AGREE 78%", "✗ DISAGREE 80%", "◐ MIXED 70%", "architect", "skeptic", "pragmatist", "refresh rotation", "exit plan"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
}

func TestDebateMembersJoinOneAtATime(t *testing.T) {
	d, th := sampleDebate(), theme.Default()
	first := ansi.Strip(renderDebate(d, 90, th, debateIntro+4, true, 0))
	if !strings.Contains(first, "architect") || strings.Contains(first, "skeptic") {
		t.Errorf("only the first member has joined:\n%s", first)
	}
	end := ansi.Strip(renderDebate(d, 90, th, debateTicks(d), true, 0))
	if !strings.Contains(end, "pragmatist") || !strings.Contains(end, "exit plan") {
		t.Errorf("everyone has joined and spoken by the end:\n%s", end)
	}
}

func TestDebateHeightStableAndInBounds(t *testing.T) {
	d, th := sampleDebate(), theme.Default()
	want := -1
	for _, w := range []int{48, 60, 90, 160} {
		for tick := 0; tick <= debateTicks(d); tick++ {
			lines := strings.Split(renderDebate(d, w, th, tick, true, tick), "\n")
			if want < 0 {
				want = len(lines)
			}
			if len(lines) != want {
				t.Fatalf("height changed %d -> %d (w=%d tick=%d)", want, len(lines), w, tick)
			}
			for _, l := range lines {
				if lw := lipgloss.Width(l); lw > w {
					t.Fatalf("w=%d tick=%d: %d wide: %q", w, tick, lw, ansi.Strip(l))
				}
			}
		}
	}
}

func TestDebateNarrowFallsBackToList(t *testing.T) {
	out := ansi.Strip(renderDebate(sampleDebate(), 40, theme.Default(), 0, true, 0))
	if !strings.Contains(out, "✗ DISAGREE skeptic") {
		t.Errorf("got:\n%s", out)
	}
}

func TestRoundEndsWithDebateMapAndEscSkipsQuestions(t *testing.T) {
	h := newHarness(t, 150, 60)
	h.press("tab")
	h.typ("topic")
	h.press("enter")
	h.reply(h.fc.last().id)
	h.feedThrough("awaiting_human")
	h.feedThrough("idle")
	s := h.app.sess
	var m *entry
	for _, e := range s.entries {
		if e.kind == kindMap {
			m = e
		}
	}
	if m == nil || len(m.debate.members) < 2 {
		t.Fatal("a round with several digests should end with a debate map")
	}
	if !s.qa.active {
		t.Fatal("the Chair's open questions should be offered")
	}
	h.press("esc")
	if s.qa.active {
		t.Fatal("esc skips the questions")
	}
	h.press("enter")
	if h.fc.last().method != "session.continue" {
		t.Fatalf("with questions skipped, Enter continues: %+v", h.fc.last())
	}
}

func TestQuestionItemsParsing(t *testing.T) {
	got := questionItems("- Who owns key rotation?\n* What threshold ends dual-read?\n3. Mobile clients?\n\n")
	if len(got) != 3 || got[0] != "Who owns key rotation?" || got[2] != "Mobile clients?" {
		t.Fatalf("got %q", got)
	}
	if n := questionItems("none"); len(n) != 0 {
		t.Fatalf("'none' means no questions: %q", n)
	}
	if n := questionItems("- None.\n"); len(n) != 0 {
		t.Fatalf("'None.' means no questions: %q", n)
	}
}
