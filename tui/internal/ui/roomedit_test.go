package ui

import (
	"fmt"
	"testing"

	"github.com/jbud/quorum/tui/internal/rpc"
)

func TestEditSuggestionBeforeApproving(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.app.rm.room.clis = []string{"claude", "codex", "kimi", "opencode"}
	h.event(rpc.RoomEvent{Type: "suggestion", Seq: 90, ID: 9, From: "assistant", Action: "hire", Args: []string{"edge-case-hunter", "claude", "", "edge-case hunter", "Finds what breaks."}, Why: "nobody covers abuse"})
	h.review(9)
	contains(t, h.screen(), "e edit")
	h.press("e")
	s := h.screen()
	contains(t, s, "EDIT SUGGESTION 9")
	contains(t, s, "why: nobody covers abuse")
	contains(t, s, "claude (its default model)")

	// Rename them, then pick a model: the search opens on enter in the model row.
	h.press("ctrl+u")
	h.typ("abuse-hunter")
	h.press("tab")
	h.press("enter")
	h.expectCall("catalog.list")
	h.reply("catalog.list", testCatalog)
	h.typ("kimi")
	contains(t, h.screen(), "Kimi K3")
	h.press("enter")
	h.expectCall("catalog.used")
	contains(t, h.screen(), "kimi or/kimi-k3")

	// The persona is the last field; enter there approves the edited version.
	h.press("tab", "tab")
	h.typ(" Especially abuse.")
	h.press("enter")
	c := h.expectCall("room.resolve")
	args, _ := c.params["args"].([]string)
	want := []string{"abuse-hunter", "kimi", "or/kimi-k3", "edge-case hunter", "Finds what breaks. Especially abuse."}
	if c.params["id"] != 9 || c.params["accept"] != true || fmt.Sprint(args) != fmt.Sprint(want) {
		t.Fatalf("resolve params %v, want args %v", c.params, want)
	}
	// A refused edit keeps the form open with the reason; a good one closes it.
	h.send(engineMsg{rpcResponseErr(c.id, "the hire needs its role")})
	contains(t, h.screen(), "✗ the hire needs its role")
	h.press("alt+y")
	c = h.expectCall("room.resolve")
	h.reply("room.resolve", `{}`)
	lacks(t, h.screen(), "EDIT SUGGESTION")
}

func TestSwapCommandMovesAMemberToAnotherModel(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.app.rm.room.clis = []string{"claude", "codex"}
	h.event(rpc.RoomEvent{Type: "agent.joined", Seq: 80, Agent: "skeptic", Persona: "skeptic", CLI: "claude", Model: "claude-opus-5-5"})
	h.typ("/swap nobody")
	h.press("enter")
	contains(t, h.screen(), `nobody called "nobody" here`)
	h.press("ctrl+u") // a refused command stays in the box to fix
	h.typ("/swap skeptic")
	h.press("enter")
	h.reply("catalog.list", testCatalog)
	s := h.screen()
	contains(t, s, "MOVE SKEPTIC TO ANOTHER MODEL")
	contains(t, s, "❯ ★ Claude Opus 5.5") // the cursor starts on the model it runs on now
	h.typ("astra")
	h.press("enter")
	c := h.expectCall("room.swap")
	if c.params["id"] != "skeptic" || c.params["cli"] != "codex" || c.params["model"] != "gpt-6-astra" {
		t.Fatalf("swap params %v", c.params)
	}
	h.reply("room.swap", `{}`)
	h.event(rpc.RoomEvent{Type: "agent.swapped", Seq: 81, Agent: "skeptic", CLI: "codex", Model: "gpt-6-astra"})
	contains(t, h.screen(), "skeptic now runs on codex gpt-6-astra")
}

func TestProvidersScreen(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.press("alt+o")
	h.expectCall("providers.get")
	h.reply("catalog.list", testCatalog)
	h.reply("providers.get", `{"harnesses":["claude","codex","kimi","opencode"],"favourites":["anthropic/claude-opus-5-5"],"providers":{}}`)
	s := h.screen()
	contains(t, s, "PROVIDERS & MODELS")
	// In a channel it asks who first: members, support roles, someone new, or just the catalog.
	contains(t, s, "Who are you changing?")
	contains(t, s, "support role")
	contains(t, s, "Bring in someone new")
	h.press("up") // the last row: just browse
	h.press("enter")
	s = h.screen()
	contains(t, s, "Star the models you reach for")
	contains(t, s, "quota") // a subscription harness's models show quota, not a list price

	// Models: alt+f stars.
	h.typ("astra")
	h.press("alt+f")
	if c := h.expectCall("catalog.favourite"); c.params["key"] != "openai/gpt-6-astra" || c.params["on"] != true {
		t.Fatalf("favourite params %v", c.params)
	}

	// Harnesses: move codex to the top.
	h.press("alt+2")
	contains(t, h.screen(), "quota 40% used")
	h.press("down")
	h.press("K")
	if c := h.expectCall("harnesses.order"); fmt.Sprint(c.params["order"]) != "[codex claude kimi opencode]" {
		t.Fatalf("order %v", c.params)
	}

	// Providers: set the env var a key lives in, and add a custom endpoint.
	h.press("alt+3")
	s = h.screen()
	contains(t, s, "✓ key set")
	contains(t, s, "needs MISTRAL_API_KEY")
	h.typ("mistral")
	h.press("enter")
	contains(t, h.screen(), "default MISTRAL_API_KEY")
	h.typ("MY_MISTRAL")
	h.press("enter", "enter") // on to the last row, then save
	if c := h.expectCall("providers.set"); c.params["id"] != "mistral" || c.params["env"] != "MY_MISTRAL" {
		t.Fatalf("set params %v", c.params)
	}
	h.press("alt+n")
	h.typ("lmstudio")
	h.press("tab", "tab", "tab")
	h.typ("http://localhost:1234/v1")
	h.press("tab")
	h.typ("qwen3-coder")
	h.press("tab", "enter")
	c := h.expectCall("providers.set")
	if c.params["id"] != "lmstudio" || c.params["baseUrl"] != "http://localhost:1234/v1" || c.params["models"] != "qwen3-coder" {
		t.Fatalf("custom provider params %v", c.params)
	}
	h.reply("providers.set", `{"harnesses":[],"favourites":[],"providers":{"lmstudio":{"baseUrl":"http://localhost:1234/v1"}}}`)
	h.expectCall("catalog.list") // what runs where changed
	h.press("esc")
	lacks(t, h.screen(), "PROVIDERS & MODELS")

	// Moving a member: pick who, then the model; esc on the models goes back to who.
	who := h.app.rm.room.agents[1].ID
	h.press("alt+o")
	h.press("down", "enter")
	contains(t, h.screen(), "New model for "+who)
	h.press("esc")
	contains(t, h.screen(), "Who are you changing?")
	h.press("enter") // the cursor is back on the first row
	h.press("esc")
	h.press("down", "enter")
	h.typ("astra")
	h.press("enter")
	c = h.expectCall("room.swap")
	if c.params["id"] != who || c.params["cli"] != "codex" || c.params["model"] != "gpt-6-astra" {
		t.Fatalf("swap params %v", c.params)
	}
	lacks(t, h.screen(), "PROVIDERS & MODELS")
}

func TestSuggestionLabelNamesTheModel(t *testing.T) {
	for _, c := range []struct {
		s    rpc.RoomEvent
		want string
	}{
		{rpc.RoomEvent{Action: "hire", Args: []string{"pcg-researcher", "agy", "", "procedural generation scientist"}}, "bring in pcg-researcher (procedural generation scientist) on agy (its default model)"},
		{rpc.RoomEvent{Action: "hire", Args: []string{"pcg-researcher", "agy", "gemini-3.5-pro", "procedural generation scientist"}}, "bring in pcg-researcher (procedural generation scientist) on agy gemini-3.5-pro"},
		{rpc.RoomEvent{Action: "add", Args: []string{"skeptic", "codex"}}, "bring back skeptic on codex (its default model)"},
		{rpc.RoomEvent{Action: "swap", Args: []string{"skeptic", "kimi", "or/kimi-k3"}}, "move skeptic to kimi or/kimi-k3"},
	} {
		if got := suggestionLabel(c.s); got != c.want {
			t.Errorf("got %q, want %q", got, c.want)
		}
	}
}

func TestBlankModelsShowTheHarnessDefault(t *testing.T) {
	clis := []rpc.CLIInfo{{CLI: "opencode", DefaultModel: "openrouter/nvidia/nemotron-3-ultra"}, {CLI: "gemini", DefaultModel: "gemini-2.5-pro"}}
	if modelOr(clis, "opencode", "") != "openrouter/nvidia/nemotron-3-ultra" || modelOr(clis, "gemini", "") != "gemini-2.5-pro" || modelOr(clis, "opencode", "x") != "x" || modelOr(clis, "kimi", "") != "" {
		t.Fatal("modelOr")
	}
	m := &joinModal{clis: clis, members: []rpc.WorkspaceMember{{ID: "innovator", Role: "boundary-pusher", CLI: "opencode"}}}
	if got := m.whoOptions()[1]; got != "innovator  boundary-pusher · opencode openrouter/nvidia/nemotron-3-ultra" {
		t.Fatalf("join list %q", got)
	}
}

func TestReadGrantsAFolderOutsideTheProject(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.typ("/read ~/work/loom")
	h.press("enter")
	if c := h.expectCall("room.read"); fmt.Sprint(c.params["paths"]) != "[~/work/loom]" {
		t.Fatalf("read params %v", c.params)
	}
	h.reply("room.read", `{"reading":[],"dirs":["/home/me/work/loom"]}`)
	contains(t, h.screen(), "Everyone can now read /home/me/work/loom")
	h.event(rpc.RoomEvent{Type: "suggestion", Seq: 95, ID: 4, From: "assistant", Action: "read", Args: []string{"/home/me/work/other"}, Why: "the transcript is there"})
	contains(t, h.screen(), "let everyone read /home/me/work/other")
	h.event(rpc.RoomEvent{Type: "access.granted", Seq: 96, Path: "/home/me/work/other", By: "human"})
	contains(t, h.screen(), "everyone can now read /home/me/work/other")
}

func TestRouteCostTellsQuotaCreditsAndBilled(t *testing.T) {
	for rt, want := range map[rpc.Route]string{
		{Harness: "claude", ID: "claude-opus-5-5"}:                      "quota",
		{Harness: "claude", ID: "claude-fable-5-1", Billing: "credits"}: "credits",
		{Harness: "opencode", ID: "anthropic/claude-fable-5-1"}:         "billed",
	} {
		if got := routeCost(rt); got != want {
			t.Errorf("%v: %s, want %s", rt, got, want)
		}
	}
}
