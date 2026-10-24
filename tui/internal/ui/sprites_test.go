package ui

import (
	tea "charm.land/bubbletea/v2"
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

func TestSpriteChosenByTopic(t *testing.T) {
	cases := map[string]string{
		"What is the best burrito in the world?": "burrito",
		"Replace session cookies with JWTs":      "lock",
		"Which chocolate bar is best":            "chocolate",
		"Pick a Postgres migration strategy":     "database",
		"Should we do ice cream or cake":         "icecream",
		"Plan the Kubernetes rollout":            "cloud",
		"Name our new team mascot":               "bulb",
		"":                                       "bulb",
	}
	for topic, want := range cases {
		if got := spriteFor(topic).id; got != want {
			t.Errorf("spriteFor(%q) = %s, want %s", topic, got, want)
		}
	}
}

func TestEverySpriteAnimatesInsideItsBounds(t *testing.T) {
	th := theme.Default()
	for i := range sprites {
		sp := &sprites[i]
		if len(sp.art) == 0 || sp.mini == "" && sp.id != "bug" {
			t.Errorf("%s: needs art and a mini glyph", sp.id)
		}
		width := sp.width() + 8
		want := -1
		for tick := 0; tick <= artTicks+2; tick += 2 {
			lines := strings.Split(renderSprite(sp, "topic", width+20, th, tick, true), "\n")
			if want < 0 {
				want = len(lines)
			}
			if len(lines) != want {
				t.Fatalf("%s: height changed %d -> %d at tick %d", sp.id, want, len(lines), tick)
			}
			for _, l := range lines[1:] {
				if lw := lipgloss.Width(l); lw > sp.width()+8 {
					t.Fatalf("%s tick %d: %d wide: %q", sp.id, tick, lw, ansi.Strip(l))
				}
			}
		}
		final := ansi.Strip(renderSprite(sp, "topic", width+20, th, 0, false))
		for _, row := range sp.art {
			if !strings.Contains(final, strings.TrimRight(row, " ")) {
				t.Errorf("%s: the finished picture lacks the row %q", sp.id, row)
			}
		}
	}
}

func TestSpriteNarrowFallsBackToTitleOnly(t *testing.T) {
	out := ansi.Strip(renderSprite(spriteFor("burrito"), "burrito", 20, theme.Default(), 0, true))
	if strings.Contains(out, "\n") || !strings.Contains(out, "TOPIC") {
		t.Errorf("got %q", out)
	}
}

func TestSessionOpensWithTheTopicPicture(t *testing.T) {
	h := newHarness(t, 150, 60)
	h.press("tab")
	h.typ("What is the best burrito?")
	h.press("enter")
	var art *entry
	for _, e := range h.app.sess.entries {
		if e.kind == kindArt {
			art = e
		}
	}
	if art == nil || h.app.sess.sprite.id != "burrito" {
		t.Fatalf("the session should open with a burrito picture, got %+v", h.app.sess.sprite)
	}
	h.app.sess.frame = 500
	h.send(tea.WindowSizeMsg{Width: 150, Height: 60})
	contains(t, h.screen(), "TOPIC  burrito")
}
