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
		// Thread is the seq of the message a side thread hangs off (its own seq when it starts one).
		Thread int `json:"thread"`

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

		// Floor decisions: who was given the next turn, and why.
		Picks []RoomPick `json:"picks"`
		// Floor tags: what each message did to the discussion.
		Items []MessageTag `json:"items"`
	}
	RoomPick struct {
		Agent    string `json:"agent"`
		Why      string `json:"why"`
		ReplyTo  int    `json:"replyTo"`
		To       string `json:"to"`
		Thread   int    `json:"thread"`
		Snapshot int    `json:"snapshot"`
	}
	MessageTag struct {
		Seq      int    `json:"seq"`
		From     string `json:"from"`
		Kind     string `json:"kind"` // idea | critique | agreement | concession | question | evidence | decision
		Headline string `json:"headline"`
		Against  string `json:"against"`
		Topic    string `json:"topic"`
		Thread   int    `json:"thread"`
	}
	// RoomSupportEvent says a support role (assistant, watch, chair, scribe, floor) started or stopped working.
	RoomSupportEvent struct {
		Role string `json:"role"`
		Busy bool   `json:"busy"`
	}
	SetupDelta struct {
		Delta string `json:"delta"`
	}
	SetupReply struct {
		Text     string         `json:"text"`
		Proposal *SetupProposal `json:"proposal"`
	}
	SetupProposal struct {
		Name    string        `json:"name,omitempty"`
		Topic   string        `json:"topic,omitempty"`
		Reading []string      `json:"reading"`
		Members []SetupMember `json:"members"`
	}
	SetupMember struct {
		ID      string `json:"id"`
		CLI     string `json:"cli,omitempty"`
		Model   string `json:"model,omitempty"`
		Role    string `json:"role,omitempty"`
		Persona string `json:"persona,omitempty"`
	}
	RoomStateEvent struct {
		State  string `json:"state"` // paused | running | idle
		Reason string `json:"reason"`
	}
	RoomTurn struct {
		Agent  string `json:"agent"`
		Thread int    `json:"thread"`
	}
	RoomTurnDelta struct {
		Agent  string `json:"agent"`
		Delta  string `json:"delta"`
		Thread int    `json:"thread"`
	}
	RoomTurnTool struct {
		Agent  string `json:"agent"`
		Name   string `json:"name"`
		Thread int    `json:"thread"`
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
		Parallel    int     `json:"parallel"`
		TurnCap     int     `json:"turnCap"`
		QuotaWarn   float64 `json:"quotaWarn"`
		QuotaStop   float64 `json:"quotaStop"`
		Independent bool    `json:"independent"`
	}
	RoomSupport struct {
		Assistant ChairSpec `json:"assistant"`
		Chair     ChairSpec `json:"chair"`
		Scribe    ChairSpec `json:"scribe"`
		Floor     ChairSpec `json:"floor"`
	}
	// RoomSnapshot is what room.start and room.open return: the room as it stands, with recent history.
	RoomSnapshot struct {
		ID            string         `json:"id"`
		Dir           string         `json:"dir"`
		Name          string         `json:"name"`
		Topic         string         `json:"topic"`
		Reading       []string       `json:"reading"`
		Skipped       []string       `json:"skipped"`
		State         string         `json:"state"`
		Agents        []PresetAgent  `json:"agents"`
		Left          []PresetAgent  `json:"left"`
		Support       RoomSupport    `json:"support"`
		CLIs          []string       `json:"clis"`
		Digest        string         `json:"digest"`
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
		Name    string `json:"name"`
		Topic   string `json:"topic"`
		Events  int    `json:"events"`
		Updated string `json:"updated"`
		Digest  string `json:"digest"`
	}
	WorkspaceMember struct {
		ID      string `json:"id"`
		CLI     string `json:"cli"`
		Model   string `json:"model"`
		Persona string `json:"persona"`
		Role    string `json:"role"`
	}
	Workspace struct {
		Channels []RoomListItem    `json:"channels"`
		Members  []WorkspaceMember `json:"members"`
	}
	RoomDocText struct {
		Name string `json:"name"`
		Text string `json:"text"`
	}
)
