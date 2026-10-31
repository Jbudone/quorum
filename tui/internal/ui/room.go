package ui

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// roomPane is which half of the room screen has the keyboard.
type roomPane int

const (
	paneRoom roomPane = iota
	paneAssistant
)

// liveTurn is a member mid-turn: what it has said so far and the side action it is taking.
type liveTurn struct {
	agent  string
	thread int
	text   string
	tool   string
}

// liveKey keys a turn by member and conversation, as the engine does.
func liveKey(agent string, thread int) string {
	if thread == 0 {
		return agent
	}
	return fmt.Sprintf("%s#%d", agent, thread)
}

// threadInfo is a side thread hanging off a channel message.
type threadInfo struct {
	root    int
	title   string
	replies int
	last    int    // seq of its latest message
	summary string // the outcome posted back to the channel, once it settled
}

// feedItem is one log entry shown in the room feed, cached per width.
type feedItem struct {
	ev     rpc.RoomEvent
	cache  string
	cacheW int
}

// noteItem is one block in the assistant pane.
type noteItem struct {
	kind string // you | answer | note | system | error
	text string
}

// docOverlay shows a document, the documents list, or the saved rooms over the room.
type docOverlay struct {
	title string
	text  string
	list  []docRef // non-nil for a list view
	cur   int
	rooms bool // the list is the channel switcher: enter switches
}

type docRef struct {
	name  string
	label string
	kind  string // switcher entries: channel | thread | new
}

// roomModel is the client-side view of a room, rebuilt from the snapshot and kept current by events.
type roomModel struct {
	id, dir, topic string
	workspace      string   // the project's folder name, for the header
	name           string   // the channel's short name
	reading        []string // the channel's reading list
	clis           []string // CLIs members can run on here
	state, reason  string
	agents, left   []rpc.PresetAgent
	support        rpc.RoomSupport
	tuning         rpc.RoomTuning
	focus          string
	topics         []rpc.RoomTopic
	docs           []rpc.RoomDoc
	notes          []string // shared notes the scribe has written
	digest         string   // the assistant's pinned summary of where the room stands
	lastPause      string   // why the room last paused, from the log

	feed    []*feedItem
	authors map[int]string // message seq → who wrote it, for reply references
	texts   map[int]string // message seq → its text, for thread titles
	tags    []rpc.MessageTag
	threads map[int]*threadInfo
	view    int             // 0 shows the channel; otherwise the root seq of the thread on screen
	busy    map[string]bool // support roles at work: assistant, watch, chair, scribe, floor
	review  bool            // the human is going through the suggestions (keys answer them)
	flash   string          // a short-lived status ("Resumed"), shown until flashTo
	flashTo int             // the animation frame the flash lasts until
	live    map[string]*liveTurn
	colors  map[string]int
	pending []rpc.RoomEvent
	sugCur  int
	asides  []noteItem
	asking  bool
	answer  string // the assistant's answer as it streams
	quota   map[string]float64
	pane    roomPane
	overlay *docOverlay
	frame   int
	calm    bool
}

func newRoom(s rpc.RoomSnapshot, calm bool) *roomModel {
	r := &roomModel{
		id: s.ID, dir: s.Dir, name: s.Name, reading: s.Reading, clis: s.CLIs, topic: s.Topic, state: s.State, support: s.Support, tuning: s.Tuning,
		agents: s.Agents, left: s.Left, focus: s.Focus, topics: s.Topics, docs: s.Docs, pending: s.Pending, digest: s.Digest,
		authors: map[int]string{}, texts: map[int]string{}, threads: map[int]*threadInfo{}, busy: map[string]bool{},
		live: map[string]*liveTurn{}, colors: map[string]int{}, quota: map[string]float64{}, calm: calm,
	}
	for _, a := range append(append([]rpc.PresetAgent{}, s.Agents...), s.Left...) {
		r.color(a.ID)
	}
	for _, e := range s.Events {
		r.record(e)
	}
	return r
}

// color gives each member a stable palette slot in order of first appearance.
func (r *roomModel) color(id string) int {
	if c, ok := r.colors[id]; ok {
		return c
	}
	r.colors[id] = len(r.colors)
	return r.colors[id]
}

func (r *roomModel) isMember(id string) bool {
	for _, a := range r.agents {
		if a.ID == id {
			return true
		}
	}
	return false
}

func (r *roomModel) memberIDs() []string {
	ids := make([]string, len(r.agents))
	for i, a := range r.agents {
		ids[i] = a.ID
	}
	return ids
}

// apply folds one engine event into the room.
func (r *roomModel) apply(ev rpc.Event) {
	switch v := ev.Data.(type) {
	case rpc.RoomEvent:
		r.record(v)
	case rpc.RoomStateEvent:
		// Coming back from a pause says so, unless something more specific is already showing
		// (a brand-new channel was never paused, and a reopened one says it picked up where it left off).
		if r.state == "paused" && v.State != "paused" && r.lastPause != "" && !(r.flash != "" && r.frame < r.flashTo) {
			r.flash, r.flashTo = "▶ Resumed. The channel is live again.", r.frame+flashFrames
		}
		r.state, r.reason = v.State, v.Reason
		if v.State == "paused" {
			r.live = map[string]*liveTurn{}
			r.busy = map[string]bool{}
			r.flash = ""
		}
	case rpc.RoomTurn:
		if ev.Name == "room.turn.start" {
			r.live[liveKey(v.Agent, v.Thread)] = &liveTurn{agent: v.Agent, thread: v.Thread}
		} else {
			delete(r.live, liveKey(v.Agent, v.Thread))
		}
	case rpc.RoomTurnDelta:
		if t := r.live[liveKey(v.Agent, v.Thread)]; t != nil {
			t.text += v.Delta
			t.tool = ""
		}
	case rpc.RoomTurnTool:
		// What a member wrote before a tool call was thinking aloud; the engine drops it too.
		if t := r.live[liveKey(v.Agent, v.Thread)]; t != nil {
			t.text, t.tool = "", strings.TrimPrefix(v.Name, "mcp__quorum__")
		}
	case rpc.RoomSupportEvent:
		r.busy[v.Role] = v.Busy
	case rpc.RoomUsage:
		if v.QuotaUtilization != nil {
			r.quota[v.CLI] = *v.QuotaUtilization
		}
	case rpc.AssistantDelta:
		r.answer += v.Delta
	case rpc.EngineError:
		r.asides = append(r.asides, noteItem{kind: "error", text: v.Message})
		r.asking = false
	}
}

// record folds one log entry into the room's derived state, and the feed or assistant pane.
func (r *roomModel) record(e rpc.RoomEvent) {
	switch e.Type {
	case "aside":
		switch {
		case e.From == "human":
			r.asides = append(r.asides, noteItem{kind: "you", text: e.Text})
		case e.Kind == "digest":
			r.digest = e.Text
		case e.Kind == "answer":
			r.asides = append(r.asides, noteItem{kind: "answer", text: e.Text})
			r.asking, r.answer = false, ""
		default:
			// A note can land while an answer is still streaming; that answer keeps going.
			r.asides = append(r.asides, noteItem{kind: "note", text: e.Text})
		}
		return
	case "suggestion":
		// A reopened room lists open suggestions and also replays them in its history.
		for _, p := range r.pending {
			if p.ID == e.ID {
				return
			}
		}
		r.pending = append(r.pending, e)
		return
	case "suggestion.resolved":
		for i, p := range r.pending {
			if p.ID == e.ID {
				verdict := "declined"
				if e.Accepted {
					verdict = "approved"
				}
				r.asides = append(r.asides, noteItem{kind: "system", text: fmt.Sprintf("You %s: %s", verdict, suggestionLabel(p))})
				r.pending = append(r.pending[:i], r.pending[i+1:]...)
				break
			}
		}
		r.sugCur = min(r.sugCur, max(len(r.pending)-1, 0))
		if len(r.pending) == 0 {
			r.review = false
		}
		return
	case "tags":
		r.tags = append(r.tags, e.Items...)
		return
	case "workstream":
		r.thread(e.Thread).title = "Workstream: " + e.Title
		return
	case "thread.summary":
		r.thread(e.Thread).summary = e.Text
	case "budget":
		r.asides = append(r.asides, noteItem{kind: "system", text: "Budget " + e.Level + ": " + e.Detail})
	case "message":
		r.authors[e.Seq] = e.From
		r.texts[e.Seq] = e.Text
		if e.From == "human" && e.To == "room" && r.topic == "" && e.Thread == 0 {
			r.topic = e.Text
		}
		if e.Thread != 0 {
			t := r.thread(e.Thread)
			if e.Seq != e.Thread {
				t.replies++
			}
			t.last = e.Seq
		}
	case "topic.raised":
		r.setTopic(rpc.RoomTopic{Slug: e.Slug, Title: e.Title})
	case "topic.focus":
		r.focus = e.Slug
	case "topic.closed":
		for i := range r.topics {
			if r.topics[i].Slug == e.Slug {
				r.topics[i].Closed = true
			}
		}
	case "doc.revised":
		found := false
		for i := range r.docs {
			if r.docs[i].Slug == e.Slug {
				r.docs[i].Version, r.docs[i].Kind, found = e.Version, e.Kind, true
			}
		}
		if !found {
			r.docs = append(r.docs, rpc.RoomDoc{Slug: e.Slug, Version: e.Version, Kind: e.Kind})
		}
	case "doc.accepted":
		for i := range r.docs {
			if r.docs[i].Slug == e.Slug {
				r.docs[i].Accepted = e.Version
			}
		}
	case "docs.updated":
		for _, f := range e.Files {
			name := strings.TrimSuffix(f, ".md")
			if !slices.Contains(r.notes, name) {
				r.notes = append(r.notes, name)
			}
		}
		return
	case "agent.joined":
		r.color(e.Agent)
		r.left = without(r.left, e.Agent)
		if !r.isMember(e.Agent) {
			r.agents = append(r.agents, rpc.PresetAgent{ID: e.Agent, Persona: e.Persona, CLI: e.CLI, Model: e.Model})
		}
	case "agent.left":
		for _, a := range r.agents {
			if a.ID == e.Agent {
				r.left = append(r.left, a)
			}
		}
		r.agents = without(r.agents, e.Agent)
		delete(r.live, e.Agent)
	case "paused":
		r.lastPause = e.Reason
	case "pass", "floor":
		return // bookkeeping; the feed reads as a conversation
	}
	r.feed = append(r.feed, &feedItem{ev: e})
}

// thread returns the thread hanging off `root`, creating it on first sight.
func (r *roomModel) thread(root int) *threadInfo {
	if t, ok := r.threads[root]; ok {
		return t
	}
	title := firstLine(r.texts[root])
	if title == "" {
		title = fmt.Sprintf("message #%d", root)
	}
	t := &threadInfo{root: root, title: title, last: root}
	r.threads[root] = t
	return t
}

// threadList is the channel's threads, most recently active first.
func (r *roomModel) threadList() []*threadInfo {
	ts := make([]*threadInfo, 0, len(r.threads))
	for _, t := range r.threads {
		ts = append(ts, t)
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i].last > ts[j].last })
	return ts
}

func (r *roomModel) setTopic(t rpc.RoomTopic) {
	for _, x := range r.topics {
		if x.Slug == t.Slug {
			return
		}
	}
	r.topics = append(r.topics, t)
}

func without(xs []rpc.PresetAgent, id string) []rpc.PresetAgent {
	out := xs[:0:0]
	for _, x := range xs {
		if x.ID != id {
			out = append(out, x)
		}
	}
	return out
}

// speaking lists the turns under way in the conversation on screen, in a stable order.
func (r *roomModel) speaking() []*liveTurn {
	ts := make([]*liveTurn, 0, len(r.live))
	for _, t := range r.live {
		if t.thread == r.view {
			ts = append(ts, t)
		}
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i].agent < ts[j].agent })
	return ts
}

// talking reports whether a member is mid-turn anywhere, and what it's doing.
func (r *roomModel) talking(agent string) (*liveTurn, bool) {
	var found *liveTurn
	for _, t := range r.live {
		if t.agent == agent && (found == nil || t.thread == r.view) {
			found = t
		}
	}
	return found, found != nil
}

// flashFrames is how long a status flash stays up, in animation frames (about three seconds).
const flashFrames = 150

// animating reports whether the room screen needs the clock running.
func (r *roomModel) animating() bool {
	return r.state == "running" || len(r.live) > 0 || r.asking || r.flash != "" && r.frame < r.flashTo
}

// pauseReason says why the channel is paused, in words for the status bar.
func (r *roomModel) pauseReason() string {
	why := r.reason
	if why == "" {
		why = r.lastPause
	}
	switch why {
	case "", "paused by the human":
		return "you paused it"
	case "closed", "switched away":
		return "it was closed"
	}
	return why
}

// empty is a room nobody has spoken in yet.
func (r *roomModel) empty() bool { return len(r.authors) == 0 && len(r.agents) == 0 }

func (r *roomModel) focusTitle() string {
	for _, t := range r.topics {
		if t.Slug == r.focus {
			return t.Title
		}
	}
	return r.focus
}

// resumesOnOpen reports whether a reopened room should carry on by itself: it was paused only
// because the interface closed, not by the human, the assistant, a milestone or the budget.
func (r *roomModel) resumesOnOpen() bool {
	return len(r.agents) > 0 && (r.lastPause == "closed" || r.lastPause == "interrupted" || r.lastPause == "switched away")
}

var reAction = regexp.MustCompile(`(?m)^\s*>>.*$\n?`)

// streamingAnswer hides the action lines the assistant writes at the end; they arrive as suggestions.
func (r *roomModel) streamingAnswer() string {
	return strings.TrimSpace(reAction.ReplaceAllString(r.answer, ""))
}

func suggestionLabel(s rpc.RoomEvent) string {
	args := strings.Join(s.Args, " ")
	switch s.Action {
	case "steer":
		return "steer the room: “" + args + "”"
	case "add":
		label := "bring back " + s.Args[0]
		if len(s.Args) > 1 {
			label += " on " + strings.Join(s.Args[1:], " ")
		}
		return label
	case "hire":
		label := "bring in " + s.Args[0]
		if len(s.Args) > 3 && s.Args[3] != "" {
			label += " (" + s.Args[3] + ")"
		}
		if len(s.Args) > 2 {
			label += " on " + strings.TrimSpace(s.Args[1]+" "+s.Args[2])
		}
		return label
	case "remove":
		return "ask " + args + " to leave"
	case "focus":
		return "focus on " + args
	case "close":
		return "close topic " + args
	case "parallel":
		return "let " + args + " speak at once"
	}
	return s.Action + " " + args
}

// roomCommand is what the room input asked for.
type roomCommand struct {
	method string
	params map[string]any
	local  string // handled in the TUI: help | docs | topics | rooms | new
	err    string
	echo   string // a short confirmation for the assistant pane
}

const roomHelp = `Talking (left box):
  text              say it to the channel; whoever has something to add answers
  @member text      ask one member directly, in the open channel
  /dm member text   a private message only that member (and your assistant) sees
  /ask question     ask in a new side thread, so it doesn't fill the channel's context
  /thread N         open the thread on message #N (or start one there); esc goes back

Your assistant (right box):
  ask it anything about the discussion; /catchup for a recap
  alt+n             go through its suggestions: ↑↓ choose, y approve, n decline, a approve all

Channel:
  alt+k             switch channel or thread, or start a new channel
  alt+a             bring someone in: who, role, model, onboarding (or /add)
  alt+g             plan next steps with your assistant: it asks, then proposes
                    members, workstreams and what to consider (or /plan)
  alt+p             pause / resume           ctrl+o   documents and notes
  alt+s             show / hide the stats strip
  pgup / pgdn       scroll (or the mouse wheel)

Typing works as in a terminal: ctrl+a/e start/end, ctrl+u/k delete to start/end,
ctrl+w delete word, alt+b/f by word, alt+enter new line.
  /read <path>…     set the reading list members work through (folders or files)
  /focus <topic>    move the focus           /close <topic>   /raise <title>
  /topics           list topics              /doc <name>      open a document
  /add <member> <cli> [model]   (quick add)   /remove <member>   /rejoin <member>
  /parallel N       most members talking at once      /turns N   turn cap per CLI
  /independent on|off   members picked together draft without seeing each other, then revise
  /export <issue>   file an issue document with gh
  /new              set up a new channel`

func (r *roomModel) parseRoomInput(in string) roomCommand {
	in = strings.TrimSpace(in)
	word := func(prefix string) string { return strings.TrimSpace(strings.TrimPrefix(in, prefix)) }
	num := func(prefix, name string) roomCommand {
		n, err := strconv.Atoi(word(prefix))
		if err != nil || n < 1 {
			return roomCommand{err: fmt.Sprintf("%s takes a whole number, e.g. %s 3", prefix, prefix)}
		}
		return roomCommand{method: "room.configure", params: map[string]any{name: n}, echo: fmt.Sprintf("%s set to %d", name, n)}
	}
	needs := func(prefix string) (string, bool) {
		v := word(prefix)
		return v, v != ""
	}
	member := func(name string) (string, string) {
		name = strings.ToLower(strings.TrimPrefix(name, "@"))
		if !r.isMember(name) {
			if len(r.agents) == 0 {
				return "", fmt.Sprintf("nobody called %q here; the room has no members yet", name)
			}
			return "", fmt.Sprintf("nobody called %q here (members: %s)", name, strings.Join(r.memberIDs(), ", "))
		}
		return name, ""
	}
	switch {
	case in == "":
		return roomCommand{}
	case in == "/help" || in == "?":
		return roomCommand{local: "help"}
	case in == "/docs":
		return roomCommand{local: "docs"}
	case in == "/topics":
		return roomCommand{local: "topics"}
	case in == "/rooms" || in == "/channels":
		return roomCommand{local: "switch"}
	case in == "/new":
		return roomCommand{local: "new"}
	case in == "/plan":
		return roomCommand{local: "plan"}
	case in == "/resume":
		return roomCommand{method: "room.resume", params: map[string]any{}}
	case strings.HasPrefix(in, "/pause"):
		p := map[string]any{}
		if reason := word("/pause"); reason != "" {
			p["reason"] = reason
		}
		return roomCommand{method: "room.pause", params: p}
	case strings.HasPrefix(in, "/parallel"):
		return num("/parallel", "parallel")
	case strings.HasPrefix(in, "/independent"):
		switch word("/independent") {
		case "on":
			return roomCommand{method: "room.configure", params: map[string]any{"independent": true}, echo: "Independent takes on: members picked together draft without seeing each other, then revise."}
		case "off":
			return roomCommand{method: "room.configure", params: map[string]any{"independent": false}, echo: "Independent takes off."}
		}
		return roomCommand{err: "/independent takes on or off"}
	case strings.HasPrefix(in, "/read"):
		paths := strings.Fields(word("/read"))
		if len(paths) == 0 {
			if len(r.reading) == 0 {
				return roomCommand{err: "/read takes the folders or files members should read, e.g. /read docs/design"}
			}
			return roomCommand{local: "reading"}
		}
		return roomCommand{method: "room.read", params: map[string]any{"paths": paths}}
	case strings.HasPrefix(in, "/ask"):
		if v, ok := needs("/ask"); ok {
			return roomCommand{method: "room.post", params: map[string]any{"text": v, "thread": "new"}, local: "open-thread"}
		}
		return roomCommand{err: "/ask takes a question; it starts a side thread"}
	case strings.HasPrefix(in, "/thread"):
		n, err := strconv.Atoi(strings.TrimPrefix(word("/thread"), "#"))
		if err != nil || n < 1 {
			return roomCommand{err: "/thread takes a message number, e.g. /thread 12"}
		}
		if _, ok := r.authors[n]; !ok {
			return roomCommand{err: fmt.Sprintf("no message #%d here", n)}
		}
		return roomCommand{local: "thread", params: map[string]any{"seq": n}}
	case strings.HasPrefix(in, "/turns"):
		return num("/turns", "turnCap")
	case strings.HasPrefix(in, "/focus"):
		if v, ok := needs("/focus"); ok {
			return roomCommand{method: "room.focus", params: map[string]any{"slug": v}}
		}
		return roomCommand{err: "/focus takes a topic (see /topics)"}
	case strings.HasPrefix(in, "/close"):
		if v, ok := needs("/close"); ok {
			return roomCommand{method: "room.closeTopic", params: map[string]any{"slug": v}}
		}
		return roomCommand{err: "/close takes a topic"}
	case strings.HasPrefix(in, "/raise"):
		if v, ok := needs("/raise"); ok {
			return roomCommand{method: "room.raise", params: map[string]any{"title": v}, echo: "Raised “" + v + "”"}
		}
		return roomCommand{err: "/raise takes a title for the new topic"}
	case strings.HasPrefix(in, "/doc "):
		return roomCommand{method: "room.doc", params: map[string]any{"name": word("/doc")}}
	case strings.HasPrefix(in, "/export"):
		if v, ok := needs("/export"); ok {
			return roomCommand{method: "room.export", params: map[string]any{"slug": v}}
		}
		return roomCommand{err: "/export takes an issue document's name"}
	case strings.HasPrefix(in, "/add"):
		f := strings.Fields(word("/add"))
		if len(f) == 0 {
			return roomCommand{local: "join"}
		}
		if len(f) < 2 {
			return roomCommand{err: "/add takes a persona and a CLI, e.g. /add security claude"}
		}
		p := map[string]any{"persona": f[0], "cli": f[1]}
		if len(f) > 2 {
			p["model"] = f[2]
		}
		return roomCommand{method: "room.add", params: p}
	case strings.HasPrefix(in, "/remove"):
		if v, ok := needs("/remove"); ok {
			return roomCommand{method: "room.remove", params: map[string]any{"id": v}, echo: v + " is writing an exit memo before leaving…"}
		}
		return roomCommand{err: "/remove takes a member"}
	case strings.HasPrefix(in, "/rejoin"):
		if v, ok := needs("/rejoin"); ok {
			return roomCommand{method: "room.rejoin", params: map[string]any{"id": v}}
		}
		return roomCommand{err: "/rejoin takes a member who left"}
	case strings.HasPrefix(in, "/dm"):
		parts := strings.SplitN(word("/dm"), " ", 2)
		name, err := member(parts[0])
		if err != "" {
			return roomCommand{err: err}
		}
		if len(parts) < 2 || strings.TrimSpace(parts[1]) == "" {
			return roomCommand{err: "/dm takes a member and a message, e.g. /dm " + name + " what worries you?"}
		}
		return roomCommand{method: "room.post", params: map[string]any{"text": strings.TrimSpace(parts[1]), "to": name}}
	case strings.HasPrefix(in, "/"):
		return roomCommand{err: "unknown command " + strings.Fields(in)[0] + " (try /help)"}
	case strings.HasPrefix(in, "@"):
		// An @mention is said in the open room; the engine gives that member the floor.
		parts := strings.SplitN(in, " ", 2)
		if _, err := member(parts[0]); err != "" {
			return roomCommand{err: err}
		}
		if len(parts) < 2 || strings.TrimSpace(parts[1]) == "" {
			return roomCommand{err: fmt.Sprintf("say something to %s after their name", parts[0])}
		}
	}
	return roomCommand{method: "room.post", params: map[string]any{"text": in}}
}

// catchUp is what /catchup asks the assistant.
const catchUp = "Catch me up: what has happened since I last talked to you? What moved, what's stuck, and does anything need my decision? Cite message numbers."
