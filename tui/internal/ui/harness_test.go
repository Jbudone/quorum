package ui

import (
	"bufio"
	"os"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
)

type call struct {
	id     int
	method string
	params map[string]any
}

type fakeCaller struct {
	calls  []call
	next   int
	closed bool
}

func (f *fakeCaller) Call(method string, params any) (int, error) {
	f.next++
	p, _ := params.(map[string]any)
	f.calls = append(f.calls, call{f.next, method, p})
	return f.next, nil
}
func (f *fakeCaller) Close() { f.closed = true }

func (f *fakeCaller) last() call { return f.calls[len(f.calls)-1] }

// harness drives the app with a recording of the real engine: events are replayed in order, and a
// response is delivered only once the app has actually made the request it answers.
type harness struct {
	t         *testing.T
	app       *App
	fc        *fakeCaller
	events    []rpc.Event
	responses map[int]rpc.Response
	pos       int
}

func newHarness(t *testing.T, w, h int) *harness {
	t.Helper()
	f, err := os.Open("../rpc/testdata/session.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	hs := &harness{t: t, fc: &fakeCaller{}, responses: map[int]rpc.Response{}}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for sc.Scan() {
		m, err := rpc.Decode(sc.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		switch v := m.(type) {
		case rpc.Event:
			hs.events = append(hs.events, v)
		case rpc.Response:
			hs.responses[v.ID] = v
		}
	}
	hs.app = New(Options{Client: hs.fc, Repo: "/work/proj", Mock: true})
	hs.send(tea.WindowSizeMsg{Width: w, Height: h})
	hs.app.Init()
	for _, c := range hs.fc.calls { // presets.list, personas.list, clis.list
		hs.reply(c.id)
	}
	return hs
}

func (h *harness) send(m tea.Msg) {
	h.t.Helper()
	_, _ = h.app.Update(m)
}

// reply delivers the recorded response for a request id.
func (h *harness) reply(id int) {
	h.t.Helper()
	r, ok := h.responses[id]
	if !ok { // a request the recording never made (the app asked something extra): answer it plainly
		r = rpc.Response{ID: id, Result: []byte("{}")}
	}
	h.send(engineMsg{r})
}

// feedThrough replays events up to and including the next one with this name.
func (h *harness) feedThrough(name string) {
	h.t.Helper()
	for h.pos < len(h.events) {
		ev := h.events[h.pos]
		h.pos++
		h.send(engineMsg{ev})
		if ev.Name == name {
			return
		}
	}
	h.t.Fatalf("recording ended before a %q event", name)
}

func (h *harness) press(keys ...string) {
	for _, k := range keys {
		h.send(keyMsg(k))
	}
}

func (h *harness) typ(s string) {
	for _, r := range s {
		h.send(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
}

func (h *harness) screen() string { return ansi.Strip(h.app.View().Content) }

func keyMsg(s string) tea.KeyPressMsg {
	switch s {
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "tab":
		return tea.KeyPressMsg{Code: tea.KeyTab}
	case "down":
		return tea.KeyPressMsg{Code: tea.KeyDown}
	case "up":
		return tea.KeyPressMsg{Code: tea.KeyUp}
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "right":
		return tea.KeyPressMsg{Code: tea.KeyRight}
	case "left":
		return tea.KeyPressMsg{Code: tea.KeyLeft}
	case "pgup":
		return tea.KeyPressMsg{Code: tea.KeyPgUp}
	case "pgdown":
		return tea.KeyPressMsg{Code: tea.KeyPgDown}
	}
	if strings.HasPrefix(s, "ctrl+") && len(s) == 6 {
		return tea.KeyPressMsg{Code: rune(s[5]), Mod: tea.ModCtrl}
	}
	if len([]rune(s)) == 1 {
		r := []rune(s)[0]
		return tea.KeyPressMsg{Code: r, Text: s}
	}
	panic("unknown key " + s)
}

func contains(t *testing.T, screen, want string) {
	t.Helper()
	if !strings.Contains(screen, want) {
		t.Fatalf("screen is missing %q:\n%s", want, screen)
	}
}

func lacks(t *testing.T, screen, bad string) {
	t.Helper()
	if strings.Contains(screen, bad) {
		t.Fatalf("screen should not contain %q:\n%s", bad, screen)
	}
}

func rpcResponseErr(id int, msg string) rpc.Response { return rpc.Response{ID: id, Err: msg} }
