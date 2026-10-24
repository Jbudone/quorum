package ui

import (
	"strings"
	"testing"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

func testSettings() *settings {
	base := rpc.Preset{
		Name: "trio", Protocol: "draft-critique-revise", Rounds: 3, Pause: "round", ReadOnly: true,
		Chair: rpc.ChairSpec{CLI: "claude"},
		Agents: []rpc.PresetAgent{
			{ID: "architect", CLI: "claude", Persona: "architect", Role: "architect"},
			{ID: "skeptic", CLI: "codex", Persona: "skeptic", Role: "skeptic"},
		},
	}
	personas := []rpc.Persona{{Key: "architect", Role: "architect"}, {Key: "pragmatist", Role: "pragmatist"}, {Key: "skeptic", Role: "skeptic"}}
	clis := []rpc.CLIInfo{
		{CLI: "claude", Usable: true, Models: []string{"sonnet", "opus"}},
		{CLI: "codex", Usable: true},
		{CLI: "opencode", Usable: false},
	}
	return newSettings(base, personas, clis, theme.Default())
}

func TestSettingsCyclingAndDirtyMarker(t *testing.T) {
	s := testSettings()
	if s.dirty() {
		t.Fatal("fresh draft should not be dirty")
	}
	s.cursor = rowRounds
	s.change(1)
	if s.draft.Rounds != 4 || !s.dirty() {
		t.Fatalf("rounds: %+v", s.draft)
	}
	s.change(-1)
	if s.dirty() {
		t.Fatal("undoing an edit should clear the marker")
	}
	s.cursor = rowPause
	s.change(1)
	if s.draft.Pause != "message" {
		t.Fatalf("pause: %s", s.draft.Pause)
	}
	s.cursor = rowProtocol
	s.change(1)
	if s.draft.Protocol != "delphi" {
		t.Fatalf("protocol: %s", s.draft.Protocol)
	}
}

func TestPersonaChangeRenamesAndDedupes(t *testing.T) {
	s := testSettings()
	s.cursor = rowPersona // first member: architect -> pragmatist
	s.change(1)
	if a := s.draft.Agents[0]; a.Persona != "pragmatist" || a.ID != "pragmatist" || a.Role != "pragmatist" {
		t.Fatalf("got %+v", a)
	}
	s.change(1) // pragmatist -> skeptic, which the second member already uses
	if a := s.draft.Agents[0]; a.ID != "skeptic-2" {
		t.Fatalf("duplicate id not resolved: %+v", a)
	}
}

func TestCLICycleSkipsUnusableAndResetsModel(t *testing.T) {
	s := testSettings()
	s.cursor = rowMemberCLI // first member, on claude
	s.draft.Agents[0].Model = "opus"
	s.change(1)
	if a := s.draft.Agents[0]; a.CLI != "codex" || a.Model != "" {
		t.Fatalf("got %+v", a)
	}
	s.change(1)
	if s.draft.Agents[0].CLI != "claude" {
		t.Fatalf("opencode is unusable and must be skipped: %+v", s.draft.Agents[0])
	}
	s.cursor = rowMemberModel
	s.change(1)
	if s.draft.Agents[0].Model != "sonnet" {
		t.Fatalf("model: %+v", s.draft.Agents[0])
	}
}

func TestAddRemoveMembers(t *testing.T) {
	s := testSettings()
	s.addMember()
	if len(s.draft.Agents) != 3 || s.draft.Agents[2].ID == "" {
		t.Fatalf("add: %+v", s.draft.Agents)
	}
	if s.rows()[s.cursor].kind != rowPersona || s.rows()[s.cursor].member != 2 {
		t.Fatalf("cursor should land on the new member: %+v", s.rows()[s.cursor])
	}
	s.removeMember()
	if len(s.draft.Agents) != 2 {
		t.Fatalf("remove: %+v", s.draft.Agents)
	}
	s.cursor = rowProtocol
	s.removeMember()
	if s.err == "" || len(s.draft.Agents) != 2 {
		t.Fatal("removing from a non-member row should explain itself")
	}
	s.draft.Agents = s.draft.Agents[:1]
	s.cursor = rowPersona
	s.removeMember()
	if len(s.draft.Agents) != 1 || s.err == "" {
		t.Fatal("the last member must stay")
	}
	for len(s.draft.Agents) < maxMembers {
		s.addMember()
	}
	s.addMember()
	if len(s.draft.Agents) != maxMembers || s.err == "" {
		t.Fatal("member cap")
	}
}

func TestWireShapeMatchesEngine(t *testing.T) {
	s := testSettings()
	w := s.wire("mine")
	for _, k := range []string{"name", "protocol", "rounds", "pause", "readOnly", "requireEvidence", "chair", "agents"} {
		if _, ok := w[k]; !ok {
			t.Errorf("wire config lacks %q", k)
		}
	}
	ag := w["agents"].([]map[string]any)
	if len(ag) != 2 || ag[0]["id"] != "architect" || ag[1]["cli"] != "codex" {
		t.Fatalf("agents: %+v", ag)
	}
}

func TestDrawerJourneyEditsStartsAndSaves(t *testing.T) {
	h := newHarness(t, 140, 44)
	h.press("down") // trio
	h.press("ctrl+a")
	contains(t, h.screen(), "SETTINGS · TRIO")
	h.press("down", "right") // rounds 3 -> 4 (trio ships with 2; just check it moved)
	contains(t, h.screen(), "EDITED")
	h.press("esc")
	contains(t, h.screen(), "CHOOSE A COUNCIL")
	contains(t, h.screen(), "✎")

	h.press("tab")
	h.typ("topic")
	h.press("enter")
	st := h.fc.last()
	cfg, ok := st.params["config"].(map[string]any)
	if st.method != "session.start" || !ok || st.params["preset"] != nil || cfg["name"] != "trio" {
		t.Fatalf("edited councils must travel as a full config: %+v", st)
	}
}

func TestDrawerSavePromptsForName(t *testing.T) {
	h := newHarness(t, 140, 44)
	h.press("ctrl+a")
	h.press("down", "right")
	h.press("s")
	contains(t, h.screen(), "save as")
	h.press("enter")
	contains(t, h.screen(), "Give the council a name")
	h.typ("my-council")
	h.press("enter")
	c := h.fc.last()
	if c.method != "presets.save" || c.params["name"] != "my-council" {
		t.Fatalf("bad save: %+v", c)
	}
	h.send(engineMsg{rpc.Response{ID: c.id, Result: []byte(`{"name":"my-council","file":"/x/my-council.toml"}`)}})
	if h.app.start.drawer != nil {
		t.Fatal("drawer should close after saving")
	}
	if h.fc.last().method != "personas.list" {
		t.Fatalf("saving should refresh the lists, got %s", h.fc.last().method)
	}
	contains(t, h.screen(), "Saved")
}

func TestDrawerFitsSmallScreens(t *testing.T) {
	for _, size := range [][2]int{{80, 24}, {60, 20}, {140, 44}} {
		h := newHarness(t, size[0], size[1])
		h.press("down", "ctrl+a")
		for i := 0; i < 20; i++ {
			h.press("down")
		}
		lines := strings.Split(h.app.View().Content, "\n")
		if len(lines) > size[1] {
			t.Errorf("%v: drawer has %d lines", size, len(lines))
		}
	}
}
