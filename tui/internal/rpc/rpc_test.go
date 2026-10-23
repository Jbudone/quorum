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
				if len(ps) != 4 || ps[0].Name != "solo" || len(ps[1].Agents) != 3 {
					t.Fatalf("unexpected presets: %+v", ps)
				}
			case 2:
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
	for _, name := range []string{"round.start", "turn.start", "turn.delta", "turn.done", "plan.updated", "chair.summary", "round.done", "awaiting_human", "idle", "session.done", "response"} {
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
