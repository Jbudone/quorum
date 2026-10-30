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
	// Tldr is the short digest every council reply carries; the TUI shows it ahead of the full text.
	Tldr struct {
		Headline   string   `json:"headline"`
		Bullets    []string `json:"bullets"`
		Stance     string   `json:"stance"` // agree | disagree | mixed | neutral
		Confidence *int     `json:"confidence"`
	}
	DiagramActor struct {
		ID    string `json:"id"`
		Label string `json:"label"`
		Icon  string `json:"icon"`
	}
	DiagramStep struct {
		From   string `json:"from"`
		To     string `json:"to"`
		Text   string `json:"text"`
		Danger bool   `json:"danger"`
	}
	DiagramOption struct {
		Name   string `json:"name"`
		Rating string `json:"rating"` // bad | mixed | good
		Note   string `json:"note"`
	}
	// Diagram is a validated sequence, attack chain or verdict the TUI animates.
	Diagram struct {
		Kind    string          `json:"kind"` // sequence | attack | verdict
		Title   string          `json:"title"`
		Actors  []DiagramActor  `json:"actors"`
		Steps   []DiagramStep   `json:"steps"`
		Options []DiagramOption `json:"options"`
		Winner  *int            `json:"winner"` // index into Options, or nil
	}
	// TurnDiagram arrives some time after the turn it illustrates; the card gains it then.
	TurnDiagram struct {
		Round   int     `json:"round"`
		Agent   string  `json:"agent"`
		Diagram Diagram `json:"diagram"`
	}
	TurnDone struct {
		Round int    `json:"round"`
		Agent string `json:"agent"`
		Text  string `json:"text"`
		Tldr  *Tldr  `json:"tldr"`
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
		// OpenQuestions is the same list with suggested answers, for the interactive form.
		OpenQuestions []OpenQuestion `json:"openQuestions"`
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
	// OpenQuestion is something the Chair needs the human to decide, with suggested answers.
	OpenQuestion struct {
		Text    string   `json:"text"`
		Options []string `json:"options"`
		Multi   bool     `json:"multi"`
	}
	// ConfigChanged confirms a live change of pacing (see session.configure).
	ConfigChanged struct {
		Pause  string `json:"pause"`
		Rounds int    `json:"rounds"`
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
		Model   string `json:"model"`
		Persona string `json:"persona"`
		Role    string `json:"role"`
	}
	// ChairSpec is which agent CLI (and optionally model) plays the Chair.
	ChairSpec struct {
		CLI   string `json:"cli"`
		Model string `json:"model"`
	}
	// Preset carries the full settings so the settings drawer can edit a copy.
	Preset struct {
		Name            string        `json:"name"`
		Description     string        `json:"description"`
		Protocol        string        `json:"protocol"`
		Rounds          int           `json:"rounds"`
		Pause           string        `json:"pause"`
		ReadOnly        bool          `json:"readOnly"`
		RequireEvidence bool          `json:"requireEvidence"`
		Chair           ChairSpec     `json:"chair"`
		Custom          bool          `json:"custom"`
		Auto            bool          `json:"auto"` // a model designs the council once the topic is known
		Agents          []PresetAgent `json:"agents"`
	}
	Persona struct {
		Key    string `json:"key"`
		Name   string `json:"name"`
		Role   string `json:"role"`
		Custom bool   `json:"custom"`
	}
	// CLIInfo describes an installed agent CLI, from the engine's cached health checks.
	CLIInfo struct {
		CLI              string   `json:"cli"`
		Usable           bool     `json:"usable"`
		Error            string   `json:"error"`
		QuotaUtilization *float64 `json:"quotaUtilization"`
		Models           []string `json:"models"`
	}
	// DesignResult is the council a model proposed for a topic, with its reasoning.
	DesignResult struct {
		Config    Preset `json:"config"`
		Rationale string `json:"rationale"`
		Source    string `json:"source"` // model | fallback
		Designer  string `json:"designer"`
	}
	SaveResult struct {
		Name string `json:"name"`
		File string `json:"file"`
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
	case "config.changed":
		data = new(ConfigChanged)
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
	case "turn.diagram":
		data = new(TurnDiagram)
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
	case "room.event":
		data = new(RoomEvent)
	case "room.state":
		data = new(RoomStateEvent)
	case "room.turn.start", "room.turn.end":
		data = new(RoomTurn)
	case "room.turn.delta":
		data = new(RoomTurnDelta)
	case "room.turn.tool":
		data = new(RoomTurnTool)
	case "room.usage":
		data = new(RoomUsage)
	case "room.assistant.delta":
		data = new(AssistantDelta)
	case "room.support":
		data = new(RoomSupportEvent)
	case "setup.delta":
		data = new(SetupDelta)
	case "setup.reply":
		data = new(SetupReply)
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
	case *ConfigChanged:
		return *v
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
	case *TurnDiagram:
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
	case *RoomEvent:
		return *v
	case *RoomStateEvent:
		return *v
	case *RoomTurn:
		return *v
	case *RoomTurnDelta:
		return *v
	case *RoomTurnTool:
		return *v
	case *RoomUsage:
		return *v
	case *AssistantDelta:
		return *v
	case *RoomSupportEvent:
		return *v
	case *SetupDelta:
		return *v
	case *SetupReply:
		return *v
	}
	return p
}
