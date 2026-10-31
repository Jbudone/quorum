package ui

import (
	"encoding/json"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// A catalog.list answer in the engine's shape: a favourite, a recent pick, a model two harnesses
// run, and one that needs a key.
const testCatalog = `{
  "models": [
    {"key":"anthropic/claude-opus-5-5","provider":"anthropic","providerName":"Anthropic","model":"claude-opus-5-5","name":"Claude Opus 5.5","context":1000000,"cost":{"input":5,"output":25},"reasoning":true,"tools":true,
     "routes":[{"harness":"claude","id":"claude-opus-5-5","ready":true},{"harness":"opencode","id":"anthropic/claude-opus-5-5","ready":false,"needs":"set ANTHROPIC_API_KEY"}],"runnable":true,"favourite":true},
    {"key":"openai/gpt-6-astra","provider":"openai","providerName":"OpenAI","model":"gpt-6-astra","name":"GPT-6 Astra","context":400000,"cost":{"input":2,"output":12},
     "routes":[{"harness":"codex","id":"gpt-6-astra","ready":true}],"runnable":true},
    {"key":"openrouter/moonshotai/kimi-k3","provider":"openrouter","providerName":"OpenRouter","model":"moonshotai/kimi-k3","name":"Kimi K3","context":256000,"cost":{"input":0.6,"output":2.5},"openWeights":true,
     "routes":[{"harness":"kimi","id":"or/kimi-k3","ready":true},{"harness":"opencode","id":"openrouter/moonshotai/kimi-k3","ready":true}],"runnable":true,"lastUsed":5},
    {"key":"openrouter/qwen/qwen3-free","provider":"openrouter","providerName":"OpenRouter","model":"qwen/qwen3-free","name":"Qwen3 Free","context":128000,"cost":{"input":0,"output":0},
     "routes":[{"harness":"opencode","id":"openrouter/qwen/qwen3-free","ready":true}],"runnable":true},
    {"key":"mistral/mistral-large-3","provider":"mistral","providerName":"Mistral","model":"mistral-large-3","name":"Mistral Large 3","context":256000,
     "routes":[{"harness":"opencode","id":"mistral/mistral-large-3","ready":false,"needs":"set MISTRAL_API_KEY"}],"runnable":false}
  ],
  "harnesses": [
    {"cli":"claude","usable":true,"models":1,"quotaUtilization":0.4},
    {"cli":"codex","usable":true,"models":1},
    {"cli":"kimi","usable":true,"models":1},
    {"cli":"opencode","usable":true,"anyProvider":true,"models":4}
  ],
  "providers": [
    {"id":"openrouter","name":"OpenRouter","env":["OPENROUTER_API_KEY"],"keySet":true,"models":3,"runnable":2},
    {"id":"anthropic","name":"Anthropic","env":["ANTHROPIC_API_KEY"],"keySet":false,"models":1,"runnable":1},
    {"id":"mistral","name":"Mistral","env":["MISTRAL_API_KEY"],"keySet":false,"models":1,"runnable":0}
  ],
  "harnessOrder": ["claude","codex","kimi","opencode"],
  "source": {"from":"mock"}
}`

func loadTestCatalog(t *testing.T) *rpc.Catalog {
	t.Helper()
	var c rpc.Catalog
	if err := json.Unmarshal([]byte(testCatalog), &c); err != nil {
		t.Fatal(err)
	}
	return &c
}

func typeInto(s *modelSearch, text string) {
	for _, r := range text {
		s.key(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
}

func press(s *modelSearch, key string) (modelPick, bool, *modelPick) {
	var k tea.KeyPressMsg
	switch key {
	case "enter":
		k = tea.KeyPressMsg{Code: tea.KeyEnter}
	case "down":
		k = tea.KeyPressMsg{Code: tea.KeyDown}
	case "up":
		k = tea.KeyPressMsg{Code: tea.KeyUp}
	case "tab":
		k = tea.KeyPressMsg{Code: tea.KeyTab}
	case "alt+f":
		k = tea.KeyPressMsg{Code: 'f', Mod: tea.ModAlt}
	case "alt+c":
		k = tea.KeyPressMsg{Code: 'c', Mod: tea.ModAlt}
	}
	p, done, fav, _ := s.key(k)
	return p, done, fav
}

func TestParseQuery(t *testing.T) {
	q := parseQuery("Kimi via:opencode p:openrouter free ctx>200k $<3 reasoning fav")
	if strings.Join(q.words, ",") != "kimi" || q.via != "opencode" || q.provider != "openrouter" || !q.free || q.minCtx != 200_000 || q.maxCost != 3 || !q.reasoning || !q.fav {
		t.Fatalf("%+v", q)
	}
	if parseTokens("1m") != 1_000_000 || parseTokens("128000") != 128000 || parseTokens("x") != 0 {
		t.Fatal("token sizes")
	}
}

func TestFuzzyScore(t *testing.T) {
	// "opus5" finds claude-opus-5-5 though the dashes differ; a word-start match beats one inside a word.
	if fuzzyScore("opus5", "claude-opus-5-5") == 0 {
		t.Fatal("squashed match")
	}
	if fuzzyScore("cop5", "claude-opus-5-5") == 0 {
		t.Fatal("letters in order")
	}
	if fuzzyScore("zzz", "claude-opus-5-5") != 0 {
		t.Fatal("no match")
	}
	if !(fuzzyScore("opus", "claude-opus") > fuzzyScore("pus", "claude-opus")) {
		t.Fatal("word start ranks higher")
	}
}

func TestModelSearchEmptyShowsFavouritesRecentAndGroups(t *testing.T) {
	c := loadTestCatalog(t)
	s := newModelSearch(theme.Default(), func() *rpc.Catalog { return c }, nil, "", "")
	var headers []string
	for _, r := range s.build() {
		if r.header != "" {
			headers = append(headers, r.header)
		}
	}
	want := "★ Favourites,Recent,Harness defaults,Anthropic,OpenAI,OpenRouter,Mistral"
	if strings.Join(headers, ",") != want {
		t.Fatalf("headers %v, want %s", headers, want)
	}
	// Providers you can't run yet start folded.
	for _, r := range s.build() {
		if r.m != nil && r.m.Provider == "mistral" {
			t.Fatal("mistral should be folded")
		}
	}
	out := ansi.Strip(s.view(theme.Default(), 120, ""))
	for _, w := range []string{"★ Claude Opus 5.5", "1M", "$5/$25", "runs on", "claude ✓"} {
		if !strings.Contains(out, w) {
			t.Fatalf("view lacks %q:\n%s", w, out)
		}
	}
}

func TestModelSearchFindsPicksAndSwitchesHarness(t *testing.T) {
	c := loadTestCatalog(t)
	s := newModelSearch(theme.Default(), func() *rpc.Catalog { return c }, nil, "", "")
	typeInto(s, "kimi")
	rows := s.build()
	if s.cur != 1 || rows[1].m == nil || rows[1].m.Key != "openrouter/moonshotai/kimi-k3" {
		t.Fatalf("best match not selected: cur %d rows %+v", s.cur, rows)
	}
	press(s, "tab") // the second way to run it
	p, done, _ := press(s, "enter")
	if !done || p.harness != "opencode" || p.model != "openrouter/moonshotai/kimi-k3" || p.key != "openrouter/moonshotai/kimi-k3" {
		t.Fatalf("pick %+v %v", p, done)
	}
}

func TestModelSearchFiltersAndNeedsAKey(t *testing.T) {
	c := loadTestCatalog(t)
	s := newModelSearch(theme.Default(), func() *rpc.Catalog { return c }, nil, "", "")
	typeInto(s, "via:opencode free")
	var keys []string
	for _, r := range s.build() {
		if r.m != nil {
			keys = append(keys, r.m.Key)
		}
	}
	if strings.Join(keys, ",") != "openrouter/qwen/qwen3-free" {
		t.Fatalf("filtered to %v", keys)
	}
	s = newModelSearch(theme.Default(), func() *rpc.Catalog { return c }, nil, "", "")
	typeInto(s, "mistral")
	if _, done, _ := press(s, "enter"); done {
		t.Fatal("picked a model that needs a key")
	}
	if !strings.Contains(s.note, "MISTRAL_API_KEY") {
		t.Fatalf("note %q", s.note)
	}
}

func TestModelSearchStarsFoldsAndRespectsTheChannel(t *testing.T) {
	c := loadTestCatalog(t)
	s := newModelSearch(theme.Default(), func() *rpc.Catalog { return c }, nil, "", "")
	typeInto(s, "astra")
	if _, _, fav := press(s, "alt+f"); fav == nil || fav.key != "openai/gpt-6-astra" {
		t.Fatalf("star %+v", fav)
	}
	if _, _, fav := press(s, "alt+f"); fav == nil || fav.key != "-openai/gpt-6-astra" {
		t.Fatalf("unstar %+v", fav)
	}
	// A channel on codex only: other harnesses' routes are hidden; typed ids run on codex.
	s = newModelSearch(theme.Default(), func() *rpc.Catalog { return c }, []string{"codex"}, "codex", "gpt-6-astra")
	s.placeStart()
	if r := s.build()[s.cur]; r.m == nil || r.m.Key != "openai/gpt-6-astra" {
		t.Fatalf("cursor not on the current model: %+v", r)
	}
	for _, r := range s.build() {
		if r.m != nil && r.m.Key != "openai/gpt-6-astra" {
			t.Fatalf("%s shown in a codex-only channel", r.m.Key)
		}
	}
	typeInto(s, "my-model")
	press(s, "down")
	p, done, _ := press(s, "enter")
	if !done || p.harness != "codex" || p.model != "my-model" {
		t.Fatalf("typed pick %+v", p)
	}
	// Folding a group with alt+c.
	s = newModelSearch(theme.Default(), func() *rpc.Catalog { return c }, nil, "", "")
	before := len(s.build())
	press(s, "up") // from the first favourite to its header
	press(s, "alt+c")
	if len(s.build()) >= before {
		t.Fatal("alt+c didn't fold")
	}
}
