package ui

import (
	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/jbud/quorum/tui/internal/theme"
)

// newInput builds a textarea in Quorum's palette. The stock styles paint a black cursor-line
// background, which shows up as a dark slab inside the rounded input box.
func newInput(th theme.Theme, height int) textarea.Model {
	ta := textarea.New()
	ta.ShowLineNumbers = false
	ta.SetHeight(height)
	ta.SetVirtualCursor(true)
	state := func(text lipgloss.Style) textarea.StyleState {
		plain := lipgloss.NewStyle()
		return textarea.StyleState{
			Base:             plain,
			Text:             text,
			CursorLine:       plain,
			CursorLineNumber: plain,
			LineNumber:       plain,
			EndOfBuffer:      plain,
			Placeholder:      lipgloss.NewStyle().Foreground(th.Subtle),
			Prompt:           lipgloss.NewStyle().Foreground(th.Muted),
			Selection:        lipgloss.NewStyle().Background(th.Accent),
		}
	}
	ta.SetStyles(textarea.Styles{
		Focused: state(lipgloss.NewStyle().Foreground(th.Text)),
		Blurred: state(lipgloss.NewStyle().Foreground(th.Muted)),
		Cursor:  textarea.CursorStyle{Color: th.Accent2, Shape: tea.CursorBlock, Blink: true},
	})
	return ta
}
