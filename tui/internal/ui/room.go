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

// liveTurn is a member mid-turn: what it has streamed so far and the tool it last called.
type liveTurn struct {
	text string
	tool string
}

// feedItem is one rendered log entry in the room feed, cached per width.
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

// docOverlay shows a document or the documents list over the room.
type docOverlay struct {
	title string
	text  string
	list  []docRef // non-nil for the list view
	cur   int
}

type docRef struct {
	name  string
	label string
}

// roomModel is the client-side view of a running room, rebuilt from the snapshot and kept current by events.
type roomModel struct {
	id, dir, topic string
	state, reason  string
	agents, left   []rpc.PresetAgent
	support        rpc.RoomSupport
	tuning         rpc.RoomTuning
	focus          string
	topics         []rpc.RoomTopic
	docs           []rpc.RoomDoc
	notes          []string // shared notes the scribe has written

	feed    []*feedItem
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
		id: s.ID, dir: s.Dir, topic: s.Topic, state: s.State, support: s.Support, tuning: s.Tuning,
		agents: s.Agents, left: s.Left, focus: s.Focus, topics: s.Topics, docs: s.Docs, pending: s.Pending,
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
		r.state, r.reason = v.State, v.Reason
		if v.State == "paused" {
			r.live = map[string]*liveTurn{}
		}
	case rpc.RoomTurn:
		if ev.Name == "room.turn.start" {
			r.live[v.Agent] = &liveTurn{}
		} else {
			delete(r.live, v.Agent)
		}
	case rpc.RoomTurnDelta:
		if t := r.live[v.Agent]; t != nil {
			t.text += v.Delta
		}
	case rpc.RoomTurnTool:
		if t := r.live[v.Agent]; t != nil {
			t.tool = strings.TrimPrefix(v.Name, "mcp__quorum__")
		}
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

// record folds one log entry into the room's derived state and the feed or assistant pane.
func (r *roomModel) record(e rpc.RoomEvent) {
	switch e.Type {
	case "aside":
		if e.From == "human" {
			r.asides = append(r.asides, noteItem{kind: "you", text: e.Text})
			return
		}
		if e.Kind == "answer" {
			r.asides = append(r.asides, noteItem{kind: "answer", text: e.Text})
			r.asking, r.answer = false, ""
		} else {
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
		return
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
	case "budget":
		r.asides = append(r.asides, noteItem{kind: "system", text: "Budget " + e.Level + ": " + e.Detail})
	}
	r.feed = append(r.feed, &feedItem{ev: e})
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

// speaking lists members mid-turn in a stable order.
func (r *roomModel) speaking() []string {
	ids := make([]string, 0, len(r.live))
	for id := range r.live {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// animating reports whether the room screen needs the clock running.
func (r *roomModel) animating() bool {
	return r.state == "running" || len(r.live) > 0 || r.asking
}

func (r *roomModel) focusTitle() string {
	for _, t := range r.topics {
		if t.Slug == r.focus {
			return t.Title
		}
	}
	return r.focus
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
		return "add a member: " + args
	case "remove":
		return "remove " + args
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
	local  string // handled in the TUI: help | docs | topics | leave | catchup
	err    string
	echo   string // a short confirmation for the assistant pane
}

const roomHelp = `Room commands (left box):
  text              say it to the whole room
  @member text      a private message to one member
  /pause [reason]   pause the room (ctrl+p toggles)   /resume
  /focus <topic>    move the focus   /close <topic>   /raise <title>
  /topics           list topics      /docs            browse documents and notes
  /doc <name>       open a document  /export <issue>  file an issue doc with gh
  /add <persona> <cli> [model]   /remove <member>   /rejoin <member>
  /parallel N       members speaking at once   /turns N   turn cap per CLI
  /leave            pause and go back to the start screen
Assistant (right box): ask anything; /catchup for a recap. With the box empty,
↑↓ picks a suggestion, y approves it, n declines it.`

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
	needs := func(prefix, what string) (string, bool) {
		v := word(prefix)
		return v, v != ""
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
	case in == "/leave":
		return roomCommand{local: "leave"}
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
	case strings.HasPrefix(in, "/turns"):
		return num("/turns", "turnCap")
	case strings.HasPrefix(in, "/focus"):
		if v, ok := needs("/focus", "topic"); ok {
			return roomCommand{method: "room.focus", params: map[string]any{"slug": v}}
		}
		return roomCommand{err: "/focus takes a topic, e.g. /focus " + r.focus}
	case strings.HasPrefix(in, "/close"):
		if v, ok := needs("/close", "topic"); ok {
			return roomCommand{method: "room.closeTopic", params: map[string]any{"slug": v}}
		}
		return roomCommand{err: "/close takes a topic"}
	case strings.HasPrefix(in, "/raise"):
		if v, ok := needs("/raise", "title"); ok {
			return roomCommand{method: "room.raise", params: map[string]any{"title": v}, echo: "Raised “" + v + "”"}
		}
		return roomCommand{err: "/raise takes a title for the new topic"}
	case strings.HasPrefix(in, "/doc "):
		return roomCommand{method: "room.doc", params: map[string]any{"name": word("/doc")}}
	case strings.HasPrefix(in, "/export"):
		if v, ok := needs("/export", "doc"); ok {
			return roomCommand{method: "room.export", params: map[string]any{"slug": v}}
		}
		return roomCommand{err: "/export takes an issue document's name"}
	case strings.HasPrefix(in, "/add"):
		f := strings.Fields(word("/add"))
		if len(f) < 2 {
			return roomCommand{err: "/add takes a persona and a CLI, e.g. /add security claude"}
		}
		p := map[string]any{"persona": f[0], "cli": f[1]}
		if len(f) > 2 {
			p["model"] = f[2]
		}
		return roomCommand{method: "room.add", params: p}
	case strings.HasPrefix(in, "/remove"):
		if v, ok := needs("/remove", "member"); ok {
			return roomCommand{method: "room.remove", params: map[string]any{"id": v}, echo: v + " is writing an exit memo before leaving…"}
		}
		return roomCommand{err: "/remove takes a member"}
	case strings.HasPrefix(in, "/rejoin"):
		if v, ok := needs("/rejoin", "member"); ok {
			return roomCommand{method: "room.rejoin", params: map[string]any{"id": v}}
		}
		return roomCommand{err: "/rejoin takes a member who left"}
	case strings.HasPrefix(in, "/"):
		return roomCommand{err: "unknown command " + strings.Fields(in)[0] + " (try /help)"}
	case strings.HasPrefix(in, "@"):
		parts := strings.SplitN(in[1:], " ", 2)
		name := strings.ToLower(parts[0])
		if !r.isMember(name) {
			return roomCommand{err: fmt.Sprintf("nobody called %q here (members: %s)", name, strings.Join(r.memberIDs(), ", "))}
		}
		if len(parts) < 2 || strings.TrimSpace(parts[1]) == "" {
			return roomCommand{err: fmt.Sprintf("say something to @%s after their name", name)}
		}
		return roomCommand{method: "room.post", params: map[string]any{"text": strings.TrimSpace(parts[1]), "to": name}}
	}
	return roomCommand{method: "room.post", params: map[string]any{"text": in}}
}

// catchUp is what /catchup asks the assistant.
const catchUp = "Catch me up: what has happened since I last talked to you? What moved, what's stuck, and does anything need my decision? Cite message numbers."
