package ui

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

func attackDiagram() *rpc.Diagram {
	return &rpc.Diagram{
		Kind: "attack", Title: "Refresh-token theft",
		Actors: []rpc.DiagramActor{{ID: "attacker", Label: "Attacker", Icon: "skull"}, {ID: "client", Label: "Client", Icon: "user"}, {ID: "api", Label: "Token API", Icon: "server"}},
		Steps: []rpc.DiagramStep{
			{From: "attacker", To: "client", Text: "steals refresh token"},
			{From: "attacker", To: "api", Text: "refresh with stolen"},
			{From: "api", To: "attacker", Text: "issues new tokens", Danger: true},
		},
	}
}

func TestDiagramFinalFrameShowsEveryStep(t *testing.T) {
	out := ansi.Strip(renderDiagram(attackDiagram(), 100, theme.Default(), 0, false))
	for _, want := range []string{"ATTACK CHAIN", "Refresh-token theft", "Attacker", "Token API", "1 steals refresh token", "3 issues new tokens", "✗", "▶", "◀"} {
		if !strings.Contains(out, want) {
			t.Errorf("final frame lacks %q:\n%s", want, out)
		}
	}
}

func TestDiagramRevealsStepsInOrder(t *testing.T) {
	d, th := attackDiagram(), theme.Default()
	at0 := ansi.Strip(renderDiagram(d, 100, th, 0, true))
	if strings.Contains(at0, "issues new tokens") || strings.Contains(at0, "2 refresh") {
		t.Errorf("later steps must not show at the start:\n%s", at0)
	}
	if !strings.Contains(at0, "●") && !strings.Contains(at0, "◆") {
		t.Errorf("a packet should be in flight:\n%s", at0)
	}
	mid := ansi.Strip(renderDiagram(d, 100, th, stepFrames+3, true))
	if !strings.Contains(mid, "1 steals refresh token") || !strings.Contains(mid, "2 refresh") || strings.Contains(mid, "issues new tokens") {
		t.Errorf("step 1 done, step 2 in flight, step 3 hidden:\n%s", mid)
	}
	end := ansi.Strip(renderDiagram(d, 100, th, diagramTicks(d), true))
	if !strings.Contains(end, "3 issues new tokens") {
		t.Errorf("playback should end on the full diagram:\n%s", end)
	}
}

func TestDiagramHeightIsStableAndNeverTooWide(t *testing.T) {
	d, th := attackDiagram(), theme.Default()
	want := -1
	for _, w := range []int{52, 60, 70, 100, 150} {
		for tick := 0; tick <= diagramTicks(d); tick++ {
			out := renderDiagram(d, w, th, tick, true)
			lines := strings.Split(out, "\n")
			if want < 0 {
				want = len(lines)
			}
			if len(lines) != want {
				t.Fatalf("height changed %d -> %d at width %d tick %d", want, len(lines), w, tick)
			}
			for _, l := range lines {
				if lw := lipgloss.Width(l); lw > w {
					t.Fatalf("line %d wide (> %d) at tick %d: %q", lw, w, tick, ansi.Strip(l))
				}
			}
		}
	}
}

func TestNarrowTerminalFallsBackToNumberedList(t *testing.T) {
	out := ansi.Strip(renderDiagram(attackDiagram(), 30, theme.Default(), 0, true))
	if !strings.Contains(out, "1. Attacker → Client:") {
		t.Errorf("expected the static list:\n%s", out)
	}
}

func TestSelfStepAndBackwardsArrow(t *testing.T) {
	d := &rpc.Diagram{Kind: "sequence", Title: "t",
		Actors: []rpc.DiagramActor{{ID: "a", Label: "A", Icon: "user"}, {ID: "b", Label: "B", Icon: "db"}},
		Steps:  []rpc.DiagramStep{{From: "b", To: "a", Text: "rows"}, {From: "b", To: "b", Text: "index"}}}
	out := ansi.Strip(renderDiagram(d, 60, theme.Default(), 0, false))
	if !strings.Contains(out, "◀") || !strings.Contains(out, "↻ index") {
		t.Errorf("got:\n%s", out)
	}
}

// A diagram arriving late attaches to its reply, plays, and then caches and stops ticking.
func TestDiagramArrivesLateAndPlaysThenSettles(t *testing.T) {
	h := newHarness(t, 140, 50)
	h.press("tab")
	h.typ("topic")
	h.press("enter")
	h.reply(h.fc.last().id)
	h.feedThrough("awaiting_human")
	h.feedThrough("idle")
	s := h.app.sess
	var target *entry
	for _, e := range s.entries {
		if e.kind == kindAgent && e.tldr != nil {
			target = e
		}
	}
	if target == nil {
		t.Fatal("no digest entry in the recording")
	}
	d := attackDiagram()
	s.apply(rpc.Event{Name: "turn.diagram", Data: rpc.TurnDiagram{Round: target.round, Agent: target.speaker, Diagram: *d}})
	if target.diagram == nil || !s.animating() {
		t.Fatal("the diagram should attach and start playing")
	}
	s.frame += 200
	if s.animating() {
		t.Fatal("playback should end")
	}
	s.calm = true
	s.frame = 0
	target.diagramAt = 0
	if s.animating() {
		t.Fatal("calm mode never animates")
	}
	s.calm = false
	if !s.replay() || !s.animating() {
		t.Fatal("ctrl+r should replay")
	}
}
