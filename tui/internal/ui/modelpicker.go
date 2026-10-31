package ui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

// modelPicker searches the models a CLI offers (opencode lists hundreds, OpenRouter's included).
// Typing filters; any name typed can be used as-is, for models the CLI doesn't list.
type modelPicker struct {
	cli     string
	all     []rpc.ModelInfo
	loading bool
	search  textarea.Model
	cur     int
}

const pickerRows = 10

func newModelPicker(th theme.Theme, cli, current string) *modelPicker {
	in := newInput(th, 1)
	in.Placeholder = "type to search, or a model name to use as-is"
	in.Focus()
	p := &modelPicker{cli: cli, search: in, loading: true}
	if current != "" {
		p.search.SetValue(current)
	}
	return p
}

// choice is one row of the picker: a model, the CLI's default, or what was typed.
type choice struct {
	id, label string
}

func (p *modelPicker) choices() []choice {
	q := strings.ToLower(strings.TrimSpace(p.search.Value()))
	var out []choice
	if q == "" {
		out = append(out, choice{"", "its default model"})
	}
	exact := false
	words := strings.Fields(q)
	for _, m := range p.all {
		hay := strings.ToLower(m.ID + " " + m.Label)
		ok := true
		for _, w := range words {
			if !strings.Contains(hay, w) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, choice{m.ID, m.Label})
			exact = exact || strings.ToLower(m.ID) == q
		}
	}
	if q != "" && !exact && !strings.Contains(q, " ") {
		out = append(out, choice{strings.TrimSpace(p.search.Value()), "use exactly this name"})
	}
	return out
}

// key handles a key press; it returns the model picked (possibly "" for the default) once Enter is pressed.
func (p *modelPicker) key(k tea.KeyPressMsg) (picked string, done bool, cmd tea.Cmd) {
	cs := p.choices()
	switch k.String() {
	case "up":
		p.cur = max(p.cur-1, 0)
		return "", false, nil
	case "down":
		p.cur = min(p.cur+1, max(len(cs)-1, 0))
		return "", false, nil
	case "enter":
		if p.cur < len(cs) {
			return cs[p.cur].id, true, nil
		}
		return "", false, nil
	}
	before := p.search.Value()
	p.search, cmd = p.search.Update(k)
	if p.search.Value() != before {
		p.cur = 0
	}
	return "", false, cmd
}

func (p *modelPicker) view(th theme.Theme, width int, spin string) string {
	p.search.SetWidth(width - 4)
	lines := []string{fg(th.Text).Bold(true).Render(p.cli) + fg(th.Muted).Render(" models"), p.search.View()}
	cs := p.choices()
	if p.loading && len(p.all) == 0 {
		lines = append(lines, fg(th.Muted).Italic(true).Render(spin+" asking "+p.cli+" for its models…"))
	}
	start := 0
	if p.cur >= pickerRows {
		start = p.cur - pickerRows + 1
	}
	for i := start; i < len(cs) && i < start+pickerRows; i++ {
		c := cs[i]
		text := c.id
		if text == "" {
			text = "(default)"
		}
		row := text + fg(th.Subtle).Render("  "+c.label)
		if i == p.cur {
			lines = append(lines, fg(th.Accent2).Bold(true).Render(ansi.Truncate("❯ "+text, width, "…"))+fg(th.Subtle).Render(ansi.Truncate("  "+c.label, max(width-lipglossWidth(text)-4, 0), "…")))
		} else {
			lines = append(lines, ansi.Truncate("  "+row, width, "…"))
		}
	}
	if n := len(cs); n > pickerRows {
		lines = append(lines, fg(th.Subtle).Render(fmt.Sprintf("  %d of %d · keep typing to narrow", min(pickerRows, n), n)))
	}
	return strings.Join(lines, "\n")
}

func lipglossWidth(s string) int { return ansi.StringWidth(s) }
