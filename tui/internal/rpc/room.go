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
		// Withdrawn: whoever suggested it took it back.
		Withdrawn bool `json:"withdrawn"`
		// Mail sent to the project's agents: its file name (Path is where it is in the repo).
		File    string `json:"file"`
		Subject string `json:"subject"`
		// access.granted: a folder outside the project everyone may now read; mail.out: the mail's path.
		Path string `json:"path"`

		Slug  string `json:"slug"`
		Title string `json:"title"`
		// doc.reviewed: the part of the document the human's feedback is about.
		Section string   `json:"section"`
		By      string   `json:"by"`
		Version int      `json:"version"`
		Kind    string   `json:"kind"`
		Note    string   `json:"note"`
		Files   []string `json:"files"`

		Persona string `json:"persona"`
		CLI     string `json:"cli"`
		Model   string `json:"model"`
		// highlight.card: the message the card explains.
		About int `json:"about"`
		// agent.swapped: what it ran on before.
		Was  *SwapWas `json:"was"`
		Memo string   `json:"memo"`
		// agent.web: whether the member may now use the web.
		On bool `json:"on"`

		Level  string `json:"level"`
		Detail string `json:"detail"`
		// budget hold: when the held members are back (none: when their model is switched).
		Until string `json:"until"`

		// Floor decisions: who was given the next turn, and why.
		Picks []RoomPick `json:"picks"`
		// Floor tags: what each message did to the discussion.
		Items []MessageTag `json:"items"`
		// Workstreams: what done looks like, and who owns it.
		Done    string   `json:"done"`
		Members []string `json:"members"`
	}
	SwapWas struct {
		CLI   string `json:"cli"`
		Model string `json:"model"`
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
		// Gist: for messages that changed the discussion, what the member did in plain words.
		Gist string `json:"gist"`
	}
	// RoomSupportEvent says a support role (assistant, watch, chair, scribe, floor) started or stopped working.
	// RoomStatus is the engine's one-line status of the room, sent when it changes.
	RoomStatus struct {
		Line string `json:"line"`
	}
	RoomSupportEvent struct {
		Role string `json:"role"`
		Busy bool   `json:"busy"`
	}
	SetupDelta struct {
		Delta string `json:"delta"`
	}
	SetupReply struct {
		Text      string         `json:"text"`
		Questions []PlanQuestion `json:"questions"`
		Proposal  *SetupProposal `json:"proposal"`
	}
	// PlanQuestion is a choice card the assistant asks during planning.
	PlanQuestion struct {
		Header  string       `json:"header"`
		Text    string       `json:"text"`
		Multi   bool         `json:"multi"`
		Options []PlanOption `json:"options"`
	}
	PlanOption struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	}
	SetupProposal struct {
		Name           string        `json:"name,omitempty"`
		Topic          string        `json:"topic,omitempty"`
		Vision         string        `json:"vision,omitempty"`
		Considerations []string      `json:"considerations"`
		Reading        []string      `json:"reading"`
		Members        []SetupMember `json:"members"`
		Topics         []PlanTopic   `json:"topics"`
		Steer          string        `json:"steer,omitempty"`
	}
	PlanTopic struct {
		Title   string   `json:"title"`
		Done    string   `json:"done,omitempty"`
		Members []string `json:"members"`
	}
	// ModelInfo is a model a CLI can run.
	ModelInfo struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	}
	SetupMember struct {
		ID      string `json:"id"`
		CLI     string `json:"cli,omitempty"`
		Model   string `json:"model,omitempty"`
		Role    string `json:"role,omitempty"`
		Persona string `json:"persona,omitempty"`
		Web     bool   `json:"web,omitempty"`
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
	// Tally is usage added up: tokens, what was billed (pay-per-token harnesses) and what it would
	// cost at API list prices (every harness).
	Tally struct {
		Turns     int     `json:"turns"`
		Input     int     `json:"input"`
		Output    int     `json:"output"`
		CacheRead int     `json:"cacheRead"`
		USD       float64 `json:"usd"`
		ListUSD   float64 `json:"listUsd"`
	}
	// UsageLine is one member, support role, model or channel's share.
	UsageLine struct {
		Tally
		ID    string `json:"id"`
		Role  string `json:"role"`
		CLI   string `json:"cli"`
		Model string `json:"model"`
	}
	UsageScope struct {
		Total     Tally       `json:"total"`
		ByAgent   []UsageLine `json:"byAgent"`
		ByModel   []UsageLine `json:"byModel"`
		ByChannel []UsageLine `json:"byChannel"`
		Legacy    *Tally      `json:"legacy"`
	}
	// SittingScope is this visit to the channel: when it started, and the quota windows then.
	SittingScope struct {
		UsageScope
		N     int                      `json:"n"`
		Start string                   `json:"start"`
		Quota map[string][]QuotaWindow `json:"quota"`
		// Engine is the engine build that ran this sitting.
		Engine string `json:"engine"`
	}
	SittingTotal struct {
		N       int     `json:"n"`
		Start   string  `json:"start"`
		USD     float64 `json:"usd"`
		ListUSD float64 `json:"listUsd"`
	}
	UsageReport struct {
		Sitting  SittingScope   `json:"sitting"`
		Channel  UsageScope     `json:"channel"`
		Sittings []SittingTotal `json:"sittings"`
		Project  *UsageScope    `json:"project"`
	}
	RoomSpend struct {
		Agent string      `json:"agent"`
		CLI   string      `json:"cli"`
		Usage UsageReport `json:"usage"`
	}
	// Meters are quota left per harness and money left per provider, from OpenUsage.
	Meters struct {
		Harnesses []HarnessMeter `json:"harnesses"`
		Balances  []Balance      `json:"balances"`
		Source    string         `json:"source"`
		Error     string         `json:"error"`
	}
	HarnessMeter struct {
		CLI     string        `json:"cli"`
		Windows []QuotaWindow `json:"windows"`
	}
	QuotaWindow struct {
		Label    string  `json:"label"`
		Used     float64 `json:"used"`
		ResetsAt string  `json:"resetsAt"`
	}
	Balance struct {
		Provider     string   `json:"provider"`
		Name         string   `json:"name"`
		RemainingUSD float64  `json:"remainingUsd"`
		LimitUSD     *float64 `json:"limitUsd"`
	}
	RoomUsage struct {
		Agent            string   `json:"agent"`
		CLI              string   `json:"cli"`
		QuotaUtilization *float64 `json:"quotaUtilization"`
		RateLimited      bool     `json:"rateLimited"`
		// Windows: every quota window the CLI reported with the turn (5h, 7d), shortest first.
		Windows []QuotaWindow `json:"windows"`
		// Limit: "warning", "window" (a used-up window) or "credits" (a model out of usage credits).
		Limit string `json:"limit"`
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
		// Ready is the version up for the human's review; Reviewed the last one they reviewed; By the latest author.
		Ready    int    `json:"ready"`
		Reviewed int    `json:"reviewed"`
		By       string `json:"by"`
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
		Status        string         `json:"status"`
		Tuning        RoomTuning     `json:"tuning"`
		Focus         string         `json:"focus"`
		Topics        []RoomTopic    `json:"topics"`
		Docs          []RoomDoc      `json:"docs"`
		Pending       []RoomEvent    `json:"pending"`
		Usage         *UsageReport   `json:"usage"`
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
	// RoomDocText is a document's text. For a channel output it also carries the versions the review
	// screen needs; Base and BaseText are the version the human last reviewed, to diff against.
	RoomDocText struct {
		Name     string `json:"name"`
		Text     string `json:"text"`
		Version  int    `json:"version"`
		Latest   int    `json:"latest"`
		Accepted int    `json:"accepted"`
		Ready    int    `json:"ready"`
		Base     int    `json:"base"`
		BaseText string `json:"baseText"`
		// Brief is the assistant's plain-English summary of this version, when it wrote one.
		Brief string `json:"brief"`
		// Briefing: the assistant has started writing one; it arrives as a doc.brief event.
		Briefing bool `json:"briefing"`
	}
	// HandoffResult is the mail room.handoff sent, and the path it points the agents at.
	HandoffResult struct {
		File string `json:"file"`
		Path string `json:"path"`
		// Mail is where the mail landed in the repo (the project's own mail/ folder, or .quorum/mail/).
		Mail string `json:"mail"`
	}
	// ReviewResult is what room.review returns; ExportPath comes back on approval.
	ReviewResult struct {
		Version    int    `json:"version"`
		ExportPath string `json:"exportPath"`
	}
)
