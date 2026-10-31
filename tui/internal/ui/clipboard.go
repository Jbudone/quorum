package ui

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// ---- selecting text with the mouse ----
//
// The app captures the mouse (for the wheel), which turns off the terminal's own selection, so it
// selects itself: press and drag inside a pane to highlight, release to copy. The selection stays
// within the pane it started in, so it never grabs both columns.

type selection struct {
	dragging, shown bool
	x0, y0, x1, y1  int
	left, right     int // the pane's columns: [left, right)
}

// paneAt returns the columns of the pane under x on the current screen.
func (a *App) paneAt(x int) (left, right int) {
	if a.screen == screenRoom && a.rm != nil && a.rm.room != nil && a.rm.setup == nil && a.roomSide() {
		if x < a.feedW() {
			return 0, a.feedW()
		}
		return a.feedW() + 1, a.w
	}
	if a.screen == screenRoom && a.rm != nil && a.rm.setup != nil {
		if side, chatW, _ := a.setupLayout(); side {
			if x < chatW {
				return 0, chatW
			}
			return chatW + 3, a.w
		}
	}
	return 0, a.w
}

// mouseSelect handles presses, drags and releases; it reports whether it used the event.
func (a *App) mouseSelect(msg tea.Msg) (bool, tea.Cmd) {
	s := &a.sel
	switch m := msg.(type) {
	case tea.MouseClickMsg:
		if m.Mouse().Button != tea.MouseLeft {
			return false, nil
		}
		x, y := m.Mouse().X, m.Mouse().Y
		s.left, s.right = a.paneAt(x)
		s.dragging, s.shown = true, false
		s.x0, s.y0, s.x1, s.y1 = x, y, x, y
		return true, nil
	case tea.MouseMotionMsg:
		if !s.dragging {
			return false, nil
		}
		s.x1, s.y1 = min(max(m.Mouse().X, s.left), s.right-1), max(m.Mouse().Y, 0)
		s.shown = s.x1 != s.x0 || s.y1 != s.y0
		return true, nil
	case tea.MouseReleaseMsg:
		if !s.dragging {
			return false, nil
		}
		s.dragging = false
		text := a.selectedText()
		if !s.shown || strings.TrimSpace(text) == "" {
			s.shown = false
			return true, nil
		}
		a.notify(fmt.Sprintf("Copied %d characters.", len([]rune(text))))
		return true, tea.Batch(tea.SetClipboard(text), copyToSystem(text))
	}
	return false, nil
}

// span is the selected columns on screen row y, as [from, to).
func (s *selection) span(y int) (int, int, bool) {
	ax, ay, bx, by := s.x0, s.y0, s.x1, s.y1
	if by < ay || by == ay && bx < ax {
		ax, ay, bx, by = bx, by, ax, ay
	}
	if y < ay || y > by {
		return 0, 0, false
	}
	from, to := s.left, s.right
	if y == ay {
		from = ax
	}
	if y == by {
		to = bx + 1
	}
	return from, min(to, s.right), from < to
}

func (a *App) selectedText() string {
	var out []string
	for y, line := range a.lastLines {
		if from, to, ok := a.sel.span(y); ok {
			out = append(out, strings.TrimRight(ansi.Strip(ansi.Cut(line, from, to)), " "))
		}
	}
	return strings.Trim(strings.Join(out, "\n"), "\n")
}

// highlight draws the selection over the rendered screen.
func (a *App) highlight(content string) string {
	lines := strings.Split(content, "\n")
	a.lastLines = lines
	if !a.sel.shown {
		return content
	}
	mark := lipgloss.NewStyle().Reverse(true)
	for y, line := range lines {
		from, to, ok := a.sel.span(y)
		if !ok {
			continue
		}
		w := ansi.StringWidth(line)
		if w < to {
			line += strings.Repeat(" ", to-w)
		}
		lines[y] = ansi.Cut(line, 0, from) + mark.Render(ansi.Strip(ansi.Cut(line, from, to))) + ansi.Cut(line, to, max(w, to))
	}
	return strings.Join(lines, "\n")
}

// copyToSystem also puts the text on the desktop clipboard, for terminals without OSC 52.
func copyToSystem(text string) tea.Cmd {
	return func() tea.Msg {
		for _, c := range [][]string{{"wl-copy"}, {"xclip", "-selection", "clipboard"}} {
			if _, err := exec.LookPath(c[0]); err != nil {
				continue
			}
			cmd := exec.Command(c[0], c[1:]...)
			cmd.Stdin = strings.NewReader(text)
			if cmd.Run() == nil {
				return nil
			}
		}
		return nil
	}
}

// notify flashes a short message at the start of the footer (where it shows even while paused).
func (a *App) notify(msg string) {
	a.toast, a.toastTo = msg, a.frame+flashFrames
}

// withToast puts the current toast, if any, in front of a footer line.
func (a *App) withToast(footer string) string {
	if a.toast == "" || a.frame >= a.toastTo {
		return footer
	}
	return ansi.Truncate(fg(a.th.OK).Bold(true).Render(a.toast)+fg(a.th.Subtle).Render(" · ")+footer, a.w, "")
}

// ---- pasting (ctrl+v): text, or an image from the clipboard ----

// pastedImage is an image read from the clipboard and saved under .quorum/attachments/.
type pastedImage struct {
	path string // relative to the repo
	err  error
}

// pastedText is text read from the clipboard (terminal paste arrives as tea.PasteMsg instead).
type pastedText struct{ text string }

// readClipboard checks the desktop clipboard for an image first, then text.
func readClipboard(repo string) tea.Cmd {
	return func() tea.Msg {
		run := func(name string, args ...string) ([]byte, bool) {
			if _, err := exec.LookPath(name); err != nil {
				return nil, false
			}
			out, err := exec.Command(name, args...).Output()
			return out, err == nil
		}
		var types string
		if out, ok := run("wl-paste", "--list-types"); ok {
			types = string(out)
		} else if out, ok := run("xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"); ok {
			types = string(out)
		}
		for _, t := range []string{"image/png", "image/jpeg", "image/webp", "image/gif"} {
			if !strings.Contains(types, t) {
				continue
			}
			data, ok := run("wl-paste", "--type", t)
			if !ok {
				data, ok = run("xclip", "-selection", "clipboard", "-t", t, "-o")
			}
			if !ok || len(data) == 0 {
				break
			}
			ext := strings.TrimPrefix(t, "image/")
			rel := filepath.Join(".quorum", "attachments", time.Now().Format("20060102-150405.000")+"."+ext)
			if err := os.MkdirAll(filepath.Join(repo, filepath.Dir(rel)), 0o755); err != nil {
				return pastedImage{err: err}
			}
			if err := os.WriteFile(filepath.Join(repo, rel), data, 0o644); err != nil {
				return pastedImage{err: err}
			}
			return pastedImage{path: rel}
		}
		if out, ok := run("wl-paste", "--no-newline"); ok {
			return pastedText{string(out)}
		}
		if out, ok := run("xclip", "-selection", "clipboard", "-o"); ok {
			return pastedText{string(bytes.TrimRight(out, "\n"))}
		}
		return pastedText{}
	}
}

// focusedInput is the text box that takes a paste on the current screen.
func (a *App) focusedInput() *textarea.Model {
	if a.screen != screenRoom || a.rm == nil {
		return nil
	}
	if s := a.rm.setup; s != nil {
		if s.form == nil && !s.asking() {
			return &s.in
		}
		return nil
	}
	if a.rm.room == nil || a.rm.join != nil || a.rm.room.overlay != nil {
		return nil
	}
	if a.rm.room.pane == paneAssistant {
		return &a.rm.assistIn
	}
	return &a.rm.roomIn
}

// pasteTarget is the text field a paste goes into: whichever input has focus on the screen or
// overlay in front, or nil when nothing is being typed into.
func (a *App) pasteTarget() *textarea.Model {
	focused := func(ins ...*textarea.Model) *textarea.Model {
		for _, in := range ins {
			if in != nil && in.Focused() {
				return in
			}
		}
		return nil
	}
	search := func(s *modelSearch) *textarea.Model {
		if s == nil {
			return nil
		}
		return &s.search
	}
	if p := a.prov; p != nil {
		var ins []*textarea.Model
		if p.form != nil {
			for i := range p.form.ins {
				ins = append(ins, &p.form.ins[i])
			}
			return focused(ins...)
		}
		switch p.tab {
		case tabModels:
			return search(p.search)
		case tabProviders:
			return &p.filter
		}
		return nil
	}
	switch a.screen {
	case screenStart:
		if a.start.focus == 1 {
			return &a.start.topic
		}
		return nil
	case screenSession:
		if a.sess.canType() {
			return &a.input
		}
		return nil
	case screenRoom:
	default:
		return nil
	}
	u := a.rm
	if u == nil {
		return nil
	}
	if s := u.setup; s != nil {
		switch {
		case s.form != nil && s.form.search != nil:
			return search(s.form.search)
		case s.form != nil:
			return focused(&s.form.vision)
		case s.asking():
			if s.owning {
				return &s.own
			}
			return nil
		}
		return &s.in
	}
	if m := u.join; m != nil {
		if m.search != nil && m.step == stepModelPick {
			return search(m.search)
		}
		return focused(&m.idIn, &m.roleIn, &m.personaIn, &m.describeIn, &m.extraIn, &m.questionIn)
	}
	r := u.room
	if r == nil {
		return nil
	}
	if e := r.edit; e != nil {
		if e.search != nil {
			return search(e.search)
		}
		if e.field() == "model" {
			return nil
		}
		return &e.ins[e.rows()[e.cur]]
	}
	if r.overlay != nil {
		return nil
	}
	return a.focusedInput()
}

// attachImage puts an [image N] chip in the box and remembers which file it stands for.
func (a *App) attachImage(path string) {
	in := a.focusedInput()
	if in == nil || a.pasteTarget() != in {
		a.notify("Images go in a message box; this field takes text only.")
		return
	}
	a.images = append(a.images, path)
	in.InsertString(fmt.Sprintf("[image %d]", len(a.images)))
	a.notify("Image attached: " + path)
}

// takeImages returns the files for the [image N] chips still in a message, and forgets them all.
func (a *App) takeImages(text string) []string {
	var out []string
	for i, p := range a.images {
		if strings.Contains(text, fmt.Sprintf("[image %d]", i+1)) {
			out = append(out, p)
		}
	}
	a.images = nil
	return out
}
