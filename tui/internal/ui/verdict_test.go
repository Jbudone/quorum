package ui

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

func verdictDiagram() *rpc.Diagram {
	w := 1
	return &rpc.Diagram{
		Kind: "verdict", Title: "Best chocolate bar", Winner: &w,
		Options: []rpc.DiagramOption{
			{Name: "Dairy Dream", Rating: "bad", Note: "waxy and cloying"},
			{Name: "Nocturne Dark", Rating: "good", Note: "smooth, balanced"},
		},
	}
}

func TestVerdictFinalFrame(t *testing.T) {
	out := ansi.Strip(renderDiagram(verdictDiagram(), 80, theme.Default(), 0, false))
	for _, want := range []string{"VERDICT", "Best chocolate bar", "Dairy Dream", "✗ BAD", "Nocturne Dark", "✓ GOOD", "★ BEST", "(>_<)", "(^‿^)"} {
		if !strings.Contains(out, want) {
			t.Errorf("final frame lacks %q:\n%s", want, out)
		}
	}
}

func TestVerdictPlaysOptionsInOrderThenBoxesTheWinner(t *testing.T) {
	d, th := verdictDiagram(), theme.Default()
	start := ansi.Strip(renderDiagram(d, 80, th, 2, true))
	if strings.Contains(start, "Nocturne") || strings.Contains(start, "BAD") {
		t.Errorf("only the first option is in play at the start:\n%s", start)
	}
	bad := ansi.Strip(renderDiagram(d, 80, th, 14, true))
	if !strings.Contains(bad, "(>_<)") && !strings.Contains(bad, "(>~<)") {
		t.Errorf("the first option should be spat out:\n%s", bad)
	}
	if strings.Contains(bad, "★ BEST") || strings.Contains(bad, "✓ GOOD") {
		t.Errorf("the winner is not decided yet:\n%s", bad)
	}
	mid := ansi.Strip(renderDiagram(d, 80, th, 2*verdictFrames+boxFrames/2, true))
	if !strings.Contains(mid, "╭") || strings.Contains(mid, "★ BEST") {
		t.Errorf("the box should be partly drawn:\n%s", mid)
	}
	end := ansi.Strip(renderDiagram(d, 80, th, diagramTicks(d), true))
	if !strings.Contains(end, "★ BEST") {
		t.Errorf("playback ends on the finished box:\n%s", end)
	}
}

func TestVerdictHeightStableAndInBounds(t *testing.T) {
	d, th := verdictDiagram(), theme.Default()
	want := -1
	for _, w := range []int{36, 40, 60, 100, 160} {
		if w < 36 {
			continue
		}
		for tick := 0; tick <= diagramTicks(d); tick++ {
			lines := strings.Split(renderDiagram(d, w, th, tick, true), "\n")
			if want < 0 {
				want = len(lines)
			}
			if len(lines) != want {
				t.Fatalf("height changed %d -> %d (w=%d tick=%d)", want, len(lines), w, tick)
			}
			for _, l := range lines {
				if lw := lipgloss.Width(l); lw > w {
					t.Fatalf("w=%d tick=%d: line is %d wide: %q", w, tick, lw, ansi.Strip(l))
				}
			}
		}
	}
}

func TestVerdictNarrowFallsBackToList(t *testing.T) {
	out := ansi.Strip(renderDiagram(verdictDiagram(), 30, theme.Default(), 0, true))
	if !strings.Contains(out, "✗ Dairy Dream") || !strings.Contains(out, "★ Nocturne Dark") {
		t.Errorf("got:\n%s", out)
	}
}

func TestSolveKeepsLayoutAndResolvesInOrder(t *testing.T) {
	st := lipgloss.NewStyle()
	text := "Rotation needs reuse detection"
	for resolved := 0; resolved <= len(text)+solveWindow; resolved++ {
		for frame := 0; frame < 3; frame++ {
			out := ansi.Strip(solve(text, 0, resolved, frame, st, st))
			if len([]rune(out)) != len([]rune(text)) {
				t.Fatalf("rune count changed at %d: %q", resolved, out)
			}
			for i, r := range []rune(text) {
				if r == ' ' && []rune(out)[i] != ' ' {
					t.Fatalf("spaces must survive: %q", out)
				}
				if i < resolved && []rune(out)[i] != r {
					t.Fatalf("char %d should be resolved at %d: %q", i, resolved, out)
				}
			}
		}
	}
	if ansi.Strip(solve(text, 0, len(text)+solveWindow, 0, st, st)) != text {
		t.Fatal("fully resolved text must equal the original")
	}
	if got := ansi.Strip(solve(text, 0, 0, 0, st, st)); strings.Contains(got, "Rotation") {
		t.Fatalf("nothing should be readable at the start: %q", got)
	}
}

func TestFreshDigestDecodesThenSettles(t *testing.T) {
	h := newHarness(t, 140, 50)
	h.press("tab")
	h.typ("topic")
	h.press("enter")
	h.reply(h.fc.last().id)
	h.feedThrough("awaiting_human")
	h.feedThrough("idle")
	s := h.app.sess
	var e *entry
	for _, x := range s.entries {
		if x.tldr != nil {
			e = x
		}
	}
	if e == nil || !e.reveal {
		t.Fatal("a digest reply should start decoding when it lands")
	}
	s.frame = e.revealAt
	early := ansi.Strip(renderEntry(s, e, theme.Default(), 100, ""))
	if strings.Contains(early, e.tldr.Headline) {
		t.Errorf("the headline must not be readable at the start:\n%s", early)
	}
	s.frame = e.revealAt + 100
	if late := ansi.Strip(renderEntry(s, e, theme.Default(), 100, "")); !strings.Contains(late, e.tldr.Headline) {
		t.Errorf("the headline must be readable once decoded:\n%s", late)
	}
	s.calm = true
	s.frame = e.revealAt
	e.cacheW = 0
	if calm := ansi.Strip(renderEntry(s, e, theme.Default(), 100, "")); !strings.Contains(calm, e.tldr.Headline) {
		t.Error("calm mode shows text immediately")
	}
}
