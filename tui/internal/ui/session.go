package ui

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/jbud/quorum/tui/internal/rpc"
)

type phase int

const (
	phaseStarting phase = iota // session.start sent, waiting for the engine
	phaseRunning               // the council is deliberating
	phasePaused                // waiting for the human
	phaseDone                  // session finished
)

type entryKind int

const (
	kindAgent entryKind = iota
	kindSummary
	kindHuman
	kindSystem
	kindError
	kindRound
	kindMap      // the round's debate map
	kindQuestion // an open question awaiting the human's answer
)

// entry is one block in the transcript.
type entry struct {
	kind      entryKind
	speaker   string
	round     int
	total     int
	text      string
	artifact  string // "plan" or "chair-report" when the reply becomes a document
	tools     []string
	debate    *debateData  // kindMap: who said what this round
	diagram   *rpc.Diagram // arrives after the reply, in the background
	diagramAt int          // animation clock value when it arrived or was replayed
	reveal    bool         // the card's text decodes into view
	revealAt  int          // animation clock value the reveal began
	tldr      *rpc.Tldr    // digest shown first; nil for Chair reports and human lines
	streaming bool
	converged bool
	to        string // for human entries: who they were addressed to

	// render cache, valid while cacheW matches and the entry is not streaming
	cache  string
	cacheW int
}

type member struct {
	id     string
	cli    string
	role   string
	status status
	color  int // index into the theme's speaker palette
	tool   string
	stance string // latest declared stance, for the consensus board
	conf   int    // -1 when unknown
}

type status int

const (
	statusIdle status = iota
	statusThinking
	statusDone
	statusFailed
)

// session is the pure state of one council run; it has no rendering or I/O so it is easy to test.
type session struct {
	preset  rpc.Preset
	repo    string
	topic   string
	id      string
	dir     string
	phase   phase
	jobs    int // continue/interject requests the engine has not reported idle for yet
	round   int
	total   int
	members []member
	chair   member

	entries []*entry
	plan    string
	planRev int

	dissent     string
	questions   string
	converged   bool
	quota       *float64
	notes       []string
	pause       string
	frame       int  // animation frame, advanced by the app on every tick
	full        bool // show full replies under their digests
	calm        bool // no animation: show final frames
	qa          qaState
	qaRound     int // the round whose questions were last offered
	convergedAt int // animation clock when the council converged (0 = not yet)
}

func newSession(p rpc.Preset, repo, topic string, rounds int) *session {
	s := &session{preset: p, repo: repo, topic: topic, phase: phaseStarting, total: p.Rounds, pause: p.Pause}
	if rounds > 0 {
		s.total = rounds
	}
	for i, a := range p.Agents {
		s.members = append(s.members, member{id: a.ID, cli: a.CLI, role: a.Role, color: i, conf: -1})
	}
	s.chair = member{id: "chair", cli: "", role: "chair", color: -1}
	return s
}

func (s *session) find(id string) *member {
	if id == "chair" {
		return &s.chair
	}
	for i := range s.members {
		if s.members[i].id == id {
			return &s.members[i]
		}
	}
	return nil
}

func (s *session) add(e *entry) *entry {
	s.entries = append(s.entries, e)
	return e
}

// streamingEntry returns the open entry for an agent, newest first.
func (s *session) streamingEntry(agent string) *entry {
	for i := len(s.entries) - 1; i >= 0; i-- {
		if e := s.entries[i]; e.kind == kindAgent && e.speaker == agent && e.streaming {
			return e
		}
	}
	return nil
}

func (s *session) system(text string) { s.add(&entry{kind: kindSystem, text: text}) }

func (s *session) anyThinking() bool {
	for _, m := range s.members {
		if m.status == statusThinking {
			return true
		}
	}
	return s.chair.status == statusThinking
}

// canType reports whether the human can send something right now.
func (s *session) canType() bool { return s.phase == phasePaused && s.jobs == 0 }

// busy reports whether the engine is working on something we asked for.
func (s *session) busy() bool { return s.jobs > 0 }

func (s *session) startJob() { s.jobs++ }

// endJob records that one request finished; when nothing is left it hands control back to the human.
func (s *session) endJob() {
	if s.jobs > 0 {
		s.jobs--
	}
	if s.jobs > 0 {
		return
	}
	for i := range s.members {
		if s.members[i].status == statusThinking {
			s.members[i].status = statusIdle
		}
	}
	if s.chair.status == statusThinking {
		s.chair.status = statusIdle
	}
	for _, e := range s.entries {
		e.streaming = false
	}
	// Stopped or failed mid-round: hand control back rather than leaving the input dead.
	if s.phase == phaseRunning || s.phase == phaseStarting {
		s.phase = phasePaused
	}
}

// applyStart records the engine's answer to session.start.
func (s *session) applyStart(r rpc.StartResult) {
	s.id, s.dir = r.SessionID, r.Dir
	if r.Rounds > 0 {
		s.total = r.Rounds
	}
	if r.Pause != "" {
		s.pause = r.Pause
	}
	if r.Protocol != "" {
		s.preset.Protocol = r.Protocol
	}
	for _, sub := range r.Substitutions {
		if m := s.find(sub.Agent); m != nil {
			m.cli = sub.To
		}
		if sub.Agent == "chair" {
			s.chair.cli = sub.To
		}
		s.system(fmt.Sprintf("%s uses %s instead of %s (%s is unavailable)", sub.Agent, sub.To, sub.From, sub.From))
	}
	if len(s.members) == 0 { // engine knows agents we did not get from the preset list
		for i, id := range r.Agents {
			s.members = append(s.members, member{id: id, color: i})
		}
	}
}

// apply folds one engine event into the session.
func (s *session) apply(ev rpc.Event) {
	switch d := ev.Data.(type) {
	case rpc.RoundStart:
		s.round = d.Round
		s.phase = phaseRunning
		for i := range s.members {
			s.members[i].status = statusIdle
		}
		s.add(&entry{kind: kindRound, round: d.Round, total: s.total})

	case rpc.TurnStart:
		if m := s.find(d.Agent); m != nil {
			m.status, m.tool = statusThinking, ""
		}
		s.add(&entry{kind: kindAgent, speaker: d.Agent, round: d.Round, artifact: d.Artifact, streaming: true})

	case rpc.TurnDelta:
		if e := s.streamingEntry(d.Agent); e != nil {
			e.text += d.Delta
		}

	case rpc.TurnTool:
		if m := s.find(d.Agent); m != nil {
			m.tool = d.Name
		}
		if e := s.streamingEntry(d.Agent); e != nil && (len(e.tools) == 0 || e.tools[len(e.tools)-1] != d.Name) {
			e.tools = append(e.tools, d.Name)
		}

	case rpc.TurnDone:
		if m := s.find(d.Agent); m != nil {
			m.status, m.tool = statusDone, ""
		}
		if e := s.streamingEntry(d.Agent); e != nil {
			e.text, e.streaming, e.cacheW, e.tldr = d.Text, false, 0, d.Tldr
			e.reveal, e.revealAt = true, s.frame
		}
		if m := s.find(d.Agent); m != nil && d.Tldr != nil && d.Agent != "chair" {
			m.stance, m.conf = d.Tldr.Stance, -1
			if d.Tldr.Confidence != nil {
				m.conf = *d.Tldr.Confidence
			}
		}

	case rpc.TurnDiagram:
		for i := len(s.entries) - 1; i >= 0; i-- {
			if e := s.entries[i]; e.kind == kindAgent && e.speaker == d.Agent && e.round == d.Round && !e.streaming && e.diagram == nil {
				dg := d.Diagram
				e.diagram, e.diagramAt, e.cacheW = &dg, s.frame, 0
				break
			}
		}

	case rpc.Usage:
		if d.QuotaUtilization != nil {
			q := *d.QuotaUtilization
			s.quota = &q
		}

	case rpc.PlanUpdated:
		s.plan, s.planRev = d.Text, d.Round

	case rpc.ChairSummary:
		s.dissent, s.questions = d.Dissent, d.Questions
		if d.Converged && !s.converged {
			s.convergedAt = s.frame + 1
		}
		s.converged = d.Converged
		s.add(&entry{kind: kindSummary, speaker: "chair", round: d.Round, text: d.Summary, converged: d.Converged, reveal: true, revealAt: s.frame})
		if db := s.buildDebate(d.Round); db != nil {
			s.add(&entry{kind: kindMap, round: d.Round, debate: db, diagramAt: s.frame})
		}

	case rpc.AwaitingHuman:
		s.phase = phasePaused
		if !d.Finished && s.qaRound != s.round {
			s.qaRound = s.round
			s.startQuestions()
		}
		if d.Finished {
			s.system("The council is finished. Press Enter to wrap up, or ask a last question.")
		}

	case rpc.EngineError:
		msg := d.Message
		if d.Agent != "" {
			msg = d.Agent + ": " + msg
			if m := s.find(d.Agent); m != nil {
				m.status = statusFailed
			}
			if e := s.streamingEntry(d.Agent); e != nil {
				e.streaming = false
			}
		}
		s.add(&entry{kind: kindError, text: msg})

	case rpc.ConfigChanged:
		s.total, s.pause = d.Rounds, d.Pause
		s.system(fmt.Sprintf("Pacing updated: %d rounds, pause after each %s.", d.Rounds, d.Pause))

	case rpc.Idle:
		s.endJob()

	case rpc.SessionDone:
		s.phase, s.jobs = phaseDone, 0
		s.system("Session complete. The plan and decision records are saved in " + s.dir)
	}
}

// Command is what the human's input line means.
type command struct {
	kind   string // continue | stop | steer | ask | plan | help | error
	to     string
	text   string
	error  string
	params map[string]any // for configure
}

// parseInput interprets the input line at a pause.
func (s *session) parseInput(in string) command {
	in = strings.TrimSpace(in)
	switch {
	case in == "" || in == "/continue":
		return command{kind: "continue"}
	case in == "/stop":
		return command{kind: "stop"}
	case in == "/plan":
		return command{kind: "plan"}
	case in == "/help" || in == "?":
		return command{kind: "help"}
	case strings.HasPrefix(in, "/pause"):
		mode := strings.TrimSpace(strings.TrimPrefix(in, "/pause"))
		switch mode {
		case "round", "message", "auto":
			return command{kind: "configure", params: map[string]any{"pause": mode}}
		}
		return command{kind: "error", error: "/pause takes round, message or auto"}
	case strings.HasPrefix(in, "/rounds"):
		n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(in, "/rounds")))
		if err != nil || n < 1 || n > 12 {
			return command{kind: "error", error: "/rounds takes a number from 1 to 12, e.g. /rounds 5"}
		}
		return command{kind: "configure", params: map[string]any{"rounds": n}}
	case strings.HasPrefix(in, "/steer"):
		t := strings.TrimSpace(strings.TrimPrefix(in, "/steer"))
		if t == "" {
			return command{kind: "error", error: "/steer needs a directive, e.g. /steer drop SSO from scope"}
		}
		return command{kind: "steer", text: t}
	case strings.HasPrefix(in, "/"):
		return command{kind: "error", error: "unknown command " + strings.Fields(in)[0] + " (try /help)"}
	case strings.HasPrefix(in, "@"):
		parts := strings.SplitN(in[1:], " ", 2)
		name := strings.ToLower(parts[0])
		if s.find(name) == nil {
			return command{kind: "error", error: fmt.Sprintf("nobody called %q here (members: %s)", name, s.names())}
		}
		if len(parts) < 2 || strings.TrimSpace(parts[1]) == "" {
			return command{kind: "error", error: fmt.Sprintf("say something to @%s after their name", name)}
		}
		return command{kind: "ask", to: name, text: strings.TrimSpace(parts[1])}
	default:
		return command{kind: "ask", to: "chair", text: in}
	}
}

func (s *session) names() string {
	ids := []string{"chair"}
	for _, m := range s.members {
		ids = append(ids, m.id)
	}
	return strings.Join(ids, ", ")
}

// qaState walks the human through the Chair's open questions at a pause.
type qaState struct {
	active bool
	items  []string
	idx    int
}

// questionItems splits the Chair's OPEN QUESTIONS section into individual questions.
func questionItems(text string) []string {
	var out []string
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), "-*• "))
		l = strings.TrimSpace(strings.TrimLeft(l, "0123456789.) "))
		if l != "" && !strings.EqualFold(strings.TrimRight(l, "."), "none") {
			out = append(out, l)
		}
	}
	return out
}

func (s *session) startQuestions() {
	items := questionItems(s.questions)
	if len(items) == 0 {
		return
	}
	s.qa = qaState{active: true, items: items}
	s.showQuestion()
}

func (s *session) showQuestion() {
	q := s.qa
	s.add(&entry{kind: kindQuestion, speaker: fmt.Sprintf("Q%d/%d", q.idx+1, len(q.items)), text: q.items[q.idx]})
}

// currentQuestion returns the open question being asked, if the walkthrough is active.
func (s *session) currentQuestion() (string, bool) {
	if !s.qa.active || s.qa.idx >= len(s.qa.items) {
		return "", false
	}
	return s.qa.items[s.qa.idx], true
}

// nextQuestion moves on after an answer or a skip; it reports whether any questions remain.
func (s *session) nextQuestion() bool {
	s.qa.idx++
	if s.qa.idx >= len(s.qa.items) {
		s.qa.active = false
		return false
	}
	s.showQuestion()
	return true
}

const convergeTicks = 20 // how long the header celebrates convergence

// animating reports whether anything is still playing.
func (s *session) animating() bool {
	if !s.calm && s.convergedAt > 0 && s.frame-s.convergedAt < convergeTicks {
		return true
	}
	for _, e := range s.entries {
		if e.playing(s) {
			return true
		}
	}
	return false
}

func (e *entry) playing(s *session) bool {
	if s.calm {
		return false
	}
	if e.reveal && s.frame-e.revealAt < fxTicks(e.revealChars()) {
		return true
	}
	if e.debate != nil {
		return s.frame-e.diagramAt < debateTicks(e.debate)
	}
	return e.diagram != nil && s.frame-e.diagramAt < diagramTicks(e.diagram)
}

// revealChars is how much text decodes into view on this card.
func (e *entry) revealChars() int {
	if e.tldr != nil {
		n := len([]rune(e.tldr.Headline))
		for _, b := range e.tldr.Bullets {
			n += len([]rune(b))
		}
		return n
	}
	return len([]rune(e.text))
}

// replay restarts the newest diagram's animation.
func (s *session) replay() bool {
	for i := len(s.entries) - 1; i >= 0; i-- {
		if e := s.entries[i]; e.diagram != nil || e.debate != nil {
			e.diagramAt, e.cacheW = s.frame, 0
			return true
		}
	}
	return false
}
