package rpc

import (
	"bufio"
	"os"
	"strings"
	"testing"
)

// The recording was produced by the real engine (scripts/record-session.ts). Every line must decode
// strictly; an engine field the Go types lack, or an unknown event, fails here.
func TestRecordedSessionDecodesStrictly(t *testing.T) {
	f, err := os.Open("testdata/session.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	counts := map[string]int{}
	n := 0
	for sc.Scan() {
		n++
		m, err := Decode(sc.Bytes())
		if err != nil {
			t.Fatalf("line %d: %v\n%.200s", n, err, sc.Text())
		}
		switch v := m.(type) {
		case Event:
			counts[v.Name]++
		case Response:
			counts["response"]++
			if v.Err != "" {
				t.Fatalf("line %d: engine error %q", n, v.Err)
			}
			switch v.ID {
			case 1:
				var ps []Preset
				if err := DecodeResult(v.Result, &ps); err != nil {
					t.Fatalf("presets: %v", err)
				}
				if len(ps) != 5 || ps[0].Name != "solo" || len(ps[1].Agents) != 3 {
					t.Fatalf("unexpected presets: %+v", ps)
				}
			case 2:
				var ps []Persona
				if err := DecodeResult(v.Result, &ps); err != nil || len(ps) < 3 {
					t.Fatalf("personas: %v %+v", err, ps)
				}
			case 3:
				var cs []CLIInfo
				if err := DecodeResult(v.Result, &cs); err != nil || len(cs) == 0 {
					t.Fatalf("clis: %v %+v", err, cs)
				}
			case 4:
				var s StartResult
				if err := DecodeResult(v.Result, &s); err != nil {
					t.Fatalf("start result: %v", err)
				}
				if s.SessionID == "" || len(s.Agents) != 3 {
					t.Fatalf("unexpected start result: %+v", s)
				}
			}
		}
	}
	for _, name := range []string{"config.changed", "turn.diagram", "round.start", "turn.start", "turn.delta", "turn.done", "plan.updated", "chair.summary", "round.done", "awaiting_human", "idle", "session.done", "response"} {
		if counts[name] == 0 {
			t.Errorf("recording has no %q messages (counts: %v)", name, counts)
		}
	}
}

func TestChairSummaryCarriesDissentAndQuestions(t *testing.T) {
	m, err := Decode([]byte(`{"event":"chair.summary","data":{"round":1,"summary":"s","converged":false,"dissent":"- a","questions":"- q"}}`))
	if err != nil {
		t.Fatal(err)
	}
	cs := m.(Event).Data.(ChairSummary)
	if cs.Dissent != "- a" || cs.Questions != "- q" || cs.Converged {
		t.Fatalf("got %+v", cs)
	}
}

func TestDecodeRejectsUnknownEventsAndFields(t *testing.T) {
	if _, err := Decode([]byte(`{"event":"nope","data":{}}`)); err == nil {
		t.Error("unknown event should fail")
	}
	if _, err := Decode([]byte(`{"event":"round.start","data":{"round":1,"extra":true}}`)); err == nil {
		t.Error("unknown field should fail")
	}
	if _, err := Decode([]byte(`not json`)); err == nil {
		t.Error("garbage should fail")
	}
}

func TestResponseErrors(t *testing.T) {
	m, err := Decode([]byte(`{"id":7,"error":{"message":"no session"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if r := m.(Response); r.ID != 7 || r.Err != "no session" {
		t.Fatalf("got %+v", r)
	}
}

func TestClientRoundTripOverPipes(t *testing.T) {
	outR, outW := pipe()
	inR, inW := pipe()
	c := NewClient(inW, outR)
	go func() {
		line, _ := bufio.NewReader(inR).ReadString('\n')
		if !strings.Contains(line, `"method":"presets.list"`) {
			t.Errorf("unexpected request %q", line)
		}
		_, _ = outW.Write([]byte(`{"id":1,"result":[]}` + "\n" + `{"event":"idle","data":{}}` + "\n"))
		_ = outW.Close()
	}()
	id, err := c.Call("presets.list", map[string]any{})
	if err != nil || id != 1 {
		t.Fatalf("call: %d %v", id, err)
	}
	var got []string
	for m := range c.Messages() {
		switch v := m.(type) {
		case Response:
			got = append(got, "response")
		case Event:
			got = append(got, v.Name)
		case ExitMsg:
			got = append(got, "exit")
		}
		if len(got) == 3 {
			break
		}
	}
	if strings.Join(got, ",") != "response,idle,exit" {
		t.Fatalf("got %v", got)
	}
}

// The settings recording covers saving, validation errors and live configuration.
func TestRecordedSettingsDecodesStrictly(t *testing.T) {
	f, err := os.Open("testdata/settings.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	var errs, oks int
	for sc.Scan() {
		m, err := Decode(sc.Bytes())
		if err != nil {
			t.Fatalf("%v\n%.200s", err, sc.Text())
		}
		if r, ok := m.(Response); ok {
			if r.Err != "" {
				errs++
			} else {
				oks++
			}
		}
	}
	if errs < 4 || oks < 5 {
		t.Fatalf("expected a mix of successes and errors, got %d ok / %d errors", oks, errs)
	}
}

// The room recording covers every room event and result shape the TUI reads.
func TestRecordedRoomDecodesStrictly(t *testing.T) {
	f, err := os.Open("testdata/room.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	types := map[string]int{}
	n := 0
	for sc.Scan() {
		n++
		m, err := Decode(sc.Bytes())
		if err != nil {
			t.Fatalf("line %d: %v\n%.200s", n, err, sc.Text())
		}
		switch v := m.(type) {
		case Event:
			types[v.Name]++
			if e, ok := v.Data.(RoomEvent); ok {
				types[e.Type]++
			}
		case Response:
			switch v.ID {
			case 1: // first launch: no channels yet
				var w Workspace
				if err := DecodeResult(v.Result, &w); err != nil || len(w.Channels) != 0 {
					t.Fatalf("workspace: %v %+v", err, w)
				}
			case 5, 13:
				var s RoomSnapshot
				if err := DecodeResult(v.Result, &s); err != nil {
					t.Fatalf("snapshot %d: %v", v.ID, err)
				}
				if s.ID == "" || s.Name != "product-cache" || len(s.Agents) != 3 || s.Support.Floor.CLI != "mock" || len(s.Events) < 3 {
					t.Fatalf("unexpected channel %d: %+v", v.ID, s)
				}
				if v.ID == 5 && (len(s.Skipped) != 1 || s.Skipped[0] != "docs") {
					t.Fatalf("missing reading-list entries should be reported: %+v", s.Skipped)
				}
				if v.ID == 13 && s.Digest == "" {
					t.Fatal("a reopened channel should carry the assistant's digest")
				}
			case 8:
				var d RoomDocText
				if err := DecodeResult(v.Result, &d); err != nil || !strings.Contains(d.Text, "# Plan") {
					t.Fatalf("doc: %v %+v", err, d)
				}
			case 12:
				var w Workspace
				if err := DecodeResult(v.Result, &w); err != nil || len(w.Channels) != 1 || len(w.Members) != 3 {
					t.Fatalf("workspace: %v %+v", err, w)
				}
			case 14:
				if v.Err == "" {
					t.Fatal("focusing an unknown topic should fail")
				}
			}
		}
	}
	for _, want := range []string{"room.state", "room.turn.start", "room.turn.delta", "room.turn.tool", "room.turn.end", "room.assistant.delta", "message", "aside", "suggestion", "doc.revised", "doc.accepted", "floor", "tags", "thread.summary", "room.support", "setup.delta", "setup.reply", "paused", "resumed"} {
		if types[want] == 0 {
			t.Errorf("recording has no %s", want)
		}
	}
}
