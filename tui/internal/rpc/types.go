// Package rpc is the Go side of the NDJSON JSON-RPC link to the TypeScript engine.
// The wire format is defined by engine/src/rpc/server.ts; testdata/session.ndjson is a recording
// of it that the tests decode strictly, so any drift between the two fails loudly.
package rpc

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Message is anything the engine can send: a typed event or a Response.
type Message interface{ isMessage() }

// Response answers one request, matched by ID.
type Response struct {
	ID     int
	Result json.RawMessage
	Err    string
}

func (Response) isMessage() {}

// Decode turns an engine event, with its Data decoded into the matching struct.
type Event struct {
	Name string
	Data any
}

func (Event) isMessage() {}

// Event payloads. Field names mirror the engine's JSON exactly.
type (
	RoundStart struct {
		Round int `json:"round"`
	}
	TurnStart struct {
		Round int    `json:"round"`
		Agent string `json:"agent"`
		// Artifact is "plan" or "chair-report" when the reply becomes a document rather than chat.
		Artifact string `json:"artifact"`
	}
	TurnDelta struct {
		Agent string `json:"agent"`
		Delta string `json:"delta"`
	}
	TurnTool struct {
		Agent string `json:"agent"`
		Name  string `json:"name"`
	}
	TurnDone struct {
		Round int    `json:"round"`
		Agent string `json:"agent"`
		Text  string `json:"text"`
	}
	Usage struct {
		Agent            string   `json:"agent"`
		QuotaUtilization *float64 `json:"quotaUtilization"`
		RateLimited      bool     `json:"rateLimited"`
	}
	PlanUpdated struct {
		Round int    `json:"round"`
		Text  string `json:"text"`
	}
	ChairSummary struct {
		Round     int    `json:"round"`
		Summary   string `json:"summary"`
		Converged bool   `json:"converged"`
		Dissent   string `json:"dissent"`
		Questions string `json:"questions"`
	}
	RoundDone struct {
		Round int `json:"round"`
	}
	AwaitingHuman struct {
		Round    int  `json:"round"`
		Finished bool `json:"finished"`
	}
	EngineError struct {
		Agent   string `json:"agent"`
		Message string `json:"message"`
	}
	// Idle means the engine finished a background job and can take the next request.
	Idle        struct{}
	SessionDone struct{}
)

// Result payloads for requests.
type (
	PresetAgent struct {
		ID      string `json:"id"`
		CLI     string `json:"cli"`
		Persona string `json:"persona"`
		Role    string `json:"role"`
	}
	Preset struct {
		Name        string        `json:"name"`
		Description string        `json:"description"`
		Protocol    string        `json:"protocol"`
		Rounds      int           `json:"rounds"`
		Agents      []PresetAgent `json:"agents"`
	}
	Substitution struct {
		Agent string `json:"agent"`
		From  string `json:"from"`
		To    string `json:"to"`
	}
	StartResult struct {
		SessionID     string         `json:"sessionId"`
		Dir           string         `json:"dir"`
		Agents        []string       `json:"agents"`
		Substitutions []Substitution `json:"substitutions"`
		// Rounds, Protocol and Pause are what the engine will actually use after overrides.
		Rounds   int    `json:"rounds"`
		Protocol string `json:"protocol"`
		Pause    string `json:"pause"`
	}
)

// strict decodes JSON and rejects fields the Go types do not know about.
func strict(raw json.RawMessage, into any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(into)
}

// DecodeResult strictly decodes a response's result into `into`.
func DecodeResult(raw json.RawMessage, into any) error { return strict(raw, into) }

// Decode parses one line from the engine.
func Decode(line []byte) (Message, error) {
	var env struct {
		Event string          `json:"event"`
		Data  json.RawMessage `json:"data"`
		ID    *int            `json:"id"`
		Res   json.RawMessage `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &env); err != nil {
		return nil, fmt.Errorf("bad line from engine: %w", err)
	}
	if env.Event == "" {
		if env.ID == nil {
			if env.Error != nil {
				return Event{Name: "error", Data: EngineError{Message: env.Error.Message}}, nil
			}
			return nil, fmt.Errorf("line is neither event nor response: %.80s", line)
		}
		r := Response{ID: *env.ID, Result: env.Res}
		if env.Error != nil {
			r.Err = env.Error.Message
		}
		return r, nil
	}
	var data any
	switch env.Event {
	case "round.start":
		data = new(RoundStart)
	case "turn.start":
		data = new(TurnStart)
	case "turn.delta":
		data = new(TurnDelta)
	case "turn.tool":
		data = new(TurnTool)
	case "turn.done":
		data = new(TurnDone)
	case "usage":
		data = new(Usage)
	case "plan.updated":
		data = new(PlanUpdated)
	case "chair.summary":
		data = new(ChairSummary)
	case "round.done":
		data = new(RoundDone)
	case "awaiting_human":
		data = new(AwaitingHuman)
	case "error":
		data = new(EngineError)
	case "idle":
		data = new(Idle)
	case "session.done":
		data = new(SessionDone)
	default:
		return nil, fmt.Errorf("unknown engine event %q", env.Event)
	}
	if err := strict(env.Data, data); err != nil {
		return nil, fmt.Errorf("event %s: %w", env.Event, err)
	}
	return Event{Name: env.Event, Data: derefs(data)}, nil
}

// derefs converts the decoded pointer to a value so consumers can type-switch on plain structs.
func derefs(p any) any {
	switch v := p.(type) {
	case *RoundStart:
		return *v
	case *TurnStart:
		return *v
	case *TurnDelta:
		return *v
	case *TurnTool:
		return *v
	case *TurnDone:
		return *v
	case *Usage:
		return *v
	case *PlanUpdated:
		return *v
	case *ChairSummary:
		return *v
	case *RoundDone:
		return *v
	case *AwaitingHuman:
		return *v
	case *EngineError:
		return *v
	case *Idle:
		return *v
	case *SessionDone:
		return *v
	}
	return p
}
