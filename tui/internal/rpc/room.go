package rpc

// Room wire types. A room's log entries (room.event) share one struct: the engine's union of event
// shapes, with every field optional. Type says which fields are set.
type (
	RoomEvent struct {
		Type string `json:"type"`
		Seq  int    `json:"seq"`
		TS   string `json:"ts"`

		From    string `json:"from"`
		To      string `json:"to"`
		Text    string `json:"text"`
		ReplyTo int    `json:"replyTo"`
		Topic   string `json:"topic"`

		Agent   string `json:"agent"`
		Message string `json:"message"`
		Reason  string `json:"reason"`

		// Suggestions: ID is the suggestion number, Action one of steer|add|remove|focus|close|parallel.
		ID       int      `json:"id"`
		Action   string   `json:"action"`
		Args     []string `json:"args"`
		Why      string   `json:"why"`
		Accepted bool     `json:"accepted"`

		Slug    string   `json:"slug"`
		Title   string   `json:"title"`
		By      string   `json:"by"`
		Version int      `json:"version"`
		Kind    string   `json:"kind"`
		Note    string   `json:"note"`
		Files   []string `json:"files"`

		Persona string `json:"persona"`
		CLI     string `json:"cli"`
		Model   string `json:"model"`
		Memo    string `json:"memo"`

		Level  string `json:"level"`
		Detail string `json:"detail"`
	}
	RoomStateEvent struct {
		State  string `json:"state"` // paused | running | idle
		Reason string `json:"reason"`
	}
	RoomTurn struct {
		Agent string `json:"agent"`
	}
	RoomTurnDelta struct {
		Agent string `json:"agent"`
		Delta string `json:"delta"`
	}
	RoomTurnTool struct {
		Agent string `json:"agent"`
		Name  string `json:"name"`
	}
	RoomUsage struct {
		Agent            string   `json:"agent"`
		CLI              string   `json:"cli"`
		QuotaUtilization *float64 `json:"quotaUtilization"`
		RateLimited      bool     `json:"rateLimited"`
	}
	AssistantDelta struct {
		Delta string `json:"delta"`
	}
)

// Room request results.
type (
	RoomTopic struct {
		Slug   string `json:"slug"`
		Title  string `json:"title"`
		Closed bool   `json:"closed"`
	}
	RoomDoc struct {
		Slug     string `json:"slug"`
		Version  int    `json:"version"`
		Kind     string `json:"kind"`
		Accepted int    `json:"accepted"`
	}
	RoomTuning struct {
		Parallel  int     `json:"parallel"`
		TurnCap   int     `json:"turnCap"`
		QuotaWarn float64 `json:"quotaWarn"`
		QuotaStop float64 `json:"quotaStop"`
	}
	RoomSupport struct {
		Assistant ChairSpec `json:"assistant"`
		Chair     ChairSpec `json:"chair"`
		Scribe    ChairSpec `json:"scribe"`
	}
	// RoomSnapshot is what room.start and room.open return: the room as it stands, with recent history.
	RoomSnapshot struct {
		ID            string         `json:"id"`
		Dir           string         `json:"dir"`
		Topic         string         `json:"topic"`
		State         string         `json:"state"`
		Agents        []PresetAgent  `json:"agents"`
		Left          []PresetAgent  `json:"left"`
		Support       RoomSupport    `json:"support"`
		Tuning        RoomTuning     `json:"tuning"`
		Focus         string         `json:"focus"`
		Topics        []RoomTopic    `json:"topics"`
		Docs          []RoomDoc      `json:"docs"`
		Pending       []RoomEvent    `json:"pending"`
		Events        []RoomEvent    `json:"events"`
		Substitutions []Substitution `json:"substitutions"`
	}
	RoomListItem struct {
		ID      string `json:"id"`
		Topic   string `json:"topic"`
		Events  int    `json:"events"`
		Updated string `json:"updated"`
	}
	RoomDocText struct {
		Name string `json:"name"`
		Text string `json:"text"`
	}
)
