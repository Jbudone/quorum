package ui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// The edit form (e on a suggestion under review): change anything the assistant proposed, its
// model and harness included, then approve your version. Mirrors the engine's SUGGESTION_FIELDS.

var suggestionFields = map[string][]string{
	"steer":    {"text"},
	"add":      {"member", "harness", "model"},
	"hire":     {"name", "harness", "model", "role", "persona"},
	"swap":     {"member", "harness", "model"},
	"remove":   {"member"},
	"focus":    {"topic"},
	"close":    {"topic"},
	"parallel": {"how many"},
	"export":   {"document", "path"},
	"mail":     {"to", "subject", "body"},
	"pointer":  {"file"},
}

// Fields long enough to need a few lines.
var longFields = map[string]bool{"text": true, "persona": true, "body": true}

type sugEdit struct {
	s       rpc.RoomEvent
	fields  []string
	ins     []textarea.Model // one per field; the harness and model fields share the model row
	harness string
	model   string
	cur     int // index into rows()
	search  *modelSearch
	sending bool
	err     string
	direct  bool // /swap: not a suggestion, sent as room.swap
}

func (a *App) openEdit(s rpc.RoomEvent) {
	fields := suggestionFields[s.Action]
	if len(fields) == 0 {
		return
	}
	e := &sugEdit{s: s, fields: fields}
	for i, f := range fields {
		h := 1
		if longFields[f] {
			h = 5
		}
		in := newInput(a.th, h)
		if i < len(s.Args) {
			in.SetValue(s.Args[i])
		}
		e.ins = append(e.ins, in)
		switch f {
		case "harness":
			e.harness = arg(s.Args, i)
		case "model":
			e.model = arg(s.Args, i)
		}
	}
	a.rm.room.edit, a.rm.room.review = e, false
	e.focus()
	if e.hasModel() {
		a.ensureCatalog()
	}
}

func arg(args []string, i int) string {
	if i < len(args) {
		return args[i]
	}
	return ""
}

func (e *sugEdit) hasModel() bool {
	for _, f := range e.fields {
		if f == "model" {
			return true
		}
	}
	return false
}

// rows are the form's rows: each text field, with harness and model folded into one "model" row.
func (e *sugEdit) rows() []int {
	var out []int
	for i, f := range e.fields {
		if f != "harness" {
			out = append(out, i)
		}
	}
	return out
}

func (e *sugEdit) field() string { return e.fields[e.rows()[e.cur]] }

func (e *sugEdit) focus() tea.Cmd {
	var cmd tea.Cmd
	for i := range e.ins {
		e.ins[i].Blur()
	}
	if f := e.rows()[e.cur]; e.fields[f] != "model" {
		cmd = e.ins[f].Focus()
	}
	return cmd
}

// args is the suggestion as edited, in the engine's order.
func (e *sugEdit) args() []string {
	out := make([]string, len(e.fields))
	for i, f := range e.fields {
		switch f {
		case "harness":
			out[i] = e.harness
		case "model":
			out[i] = e.model
		default:
			out[i] = strings.TrimSpace(e.ins[i].Value())
		}
	}
	return out
}

func (a *App) submitEdit() {
	e := a.rm.room.edit
	e.sending, e.err = true, ""
	if e.model == "" {
		// Pin the harness's default, so what's approved is what was shown.
		e.model, _ = harnessDefault(a.getCatalog(), e.harness)
	}
	if e.direct {
		args := e.args()
		a.call("room.swap", map[string]any{"id": args[0], "cli": args[1], "model": args[2]})
		return
	}
	a.call("room.resolve", map[string]any{"id": e.s.ID, "accept": true, "args": e.args()})
}

func (a *App) handleEditKey(k tea.KeyPressMsg) tea.Cmd {
	r := a.rm.room
	e := r.edit
	key := k.String()
	if e.search != nil {
		if key == "esc" {
			e.search = nil
			return nil
		}
		pick, done, fav, cmd := e.search.key(k)
		a.starred(fav)
		if done {
			a.picked(pick)
			e.harness, e.model, e.search = pick.harness, pick.model, nil
			if e.direct {
				a.submitEdit() // /swap: choosing the model is the whole action
			}
		}
		return cmd
	}
	if e.sending {
		return nil
	}
	last := len(e.rows()) - 1
	switch key {
	case "esc":
		r.edit, r.review = nil, !e.direct && len(r.pending) > 0
		return nil
	case "alt+y":
		a.submitEdit()
		return nil
	case "tab", "down":
		if key == "down" && longFields[e.field()] && e.ins[e.rows()[e.cur]].Line() < e.ins[e.rows()[e.cur]].LineCount()-1 {
			break // moving inside a long field
		}
		e.cur = min(e.cur+1, last)
		return e.focus()
	case "shift+tab", "up":
		if key == "up" && longFields[e.field()] && e.ins[e.rows()[e.cur]].Line() > 0 {
			break
		}
		e.cur = max(e.cur-1, 0)
		return e.focus()
	case "enter":
		if e.field() == "model" {
			allowed := []string{}
			if a.rm.room != nil {
				allowed = a.rm.room.clis
			}
			e.search = a.openSearch(allowed, e.harness, e.model)
			return nil
		}
		if e.cur == last {
			a.submitEdit()
			return nil
		}
		e.cur++
		return e.focus()
	case "alt+enter":
		if longFields[e.field()] {
			e.ins[e.rows()[e.cur]].InsertString("\n")
		}
		return nil
	}
	if e.field() == "model" {
		return nil
	}
	f := e.rows()[e.cur]
	var cmd tea.Cmd
	e.ins[f], cmd = e.ins[f].Update(k)
	return cmd
}

// editResponse takes the answer to an edited approval. It reports whether it took it.
func (a *App) editResponse(method string, res rpc.Response) bool {
	u := a.rm
	if method != "room.resolve" && method != "room.swap" || u == nil || u.room == nil || u.room.edit == nil || !u.room.edit.sending {
		return false
	}
	e := u.room.edit
	e.sending = false
	if res.Err != "" {
		e.err = res.Err
		return true
	}
	u.room.edit = nil
	return true
}

func (a *App) editBox(height int) string {
	e := a.rm.room.edit
	th := a.th
	w := min(a.w-4, 96)
	if e.search != nil {
		w = min(a.w-4, 140)
	}
	inner := w - 4
	title := "edit suggestion " + fmt.Sprint(e.s.ID)
	if e.direct {
		title = "move " + arg(e.s.Args, 0) + " to another model"
	}
	lines := []string{sectionTitle(title, inner, th, true)}
	if e.s.Why != "" {
		lines = append(lines, fg(th.Muted).Render(wrapText("why: "+e.s.Why, inner)))
	}
	lines = append(lines, "")
	keys := "tab next field · enter next · alt+enter new line · alt+y approve · esc back"
	if e.search != nil {
		lines = append(lines, fg(th.Muted).Render("Pick the model; the harness that runs it is chosen with it."), "", e.search.view(th, inner, a.spin.View()))
		keys = "type to search · ↑↓ choose · tab harness · enter use it · alt+f star · esc back"
	} else {
		for ri, f := range e.rows() {
			name := e.fields[f]
			on := ri == e.cur
			label := fg(th.Muted).Render(name)
			if on {
				label = fg(th.Accent2).Bold(true).Render(name)
			}
			if name == "model" {
				val := strings.TrimSpace(e.harness + " " + e.model)
				if e.model == "" {
					val = e.harness + " (its default model)"
					if id, _ := harnessDefault(a.getCatalog(), e.harness); id != "" {
						val = e.harness + " " + id + " (its default)"
					}
				}
				st := fg(th.Text)
				if on {
					st = fg(th.Accent2)
				}
				lines = append(lines, label, st.Render(ansi.Truncate("  "+val, inner, "…"))+fg(th.Subtle).Render("  enter to search models"), "")
				continue
			}
			e.ins[f].SetWidth(inner)
			lines = append(lines, label, e.ins[f].View(), "")
		}
		if e.cur == len(e.rows())-1 {
			keys = "enter approve · alt+enter new line · shift+tab back · esc back"
		}
	}
	if e.sending {
		lines = append(lines, fg(th.Muted).Italic(true).Render(a.spin.View()+" approving…"))
	}
	if e.err != "" {
		lines = append(lines, fg(th.Err).Render(wrapText("✗ "+e.err, inner)))
	}
	lines = append(lines, fg(th.Subtle).Render(ansi.Truncate(keys, inner, "…")))
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(th.Accent).Padding(0, 1).Width(w).MaxHeight(height).Render(strings.Join(lines, "\n"))
	return lipgloss.Place(a.w, height, lipgloss.Center, lipgloss.Center, box)
}
