// Package theme holds Quorum's palette. Colors follow the Charm family so the app sits naturally
// next to Crush; everything assumes a dark terminal background.
package theme

import (
	"image/color"

	"charm.land/lipgloss/v2"
)

type Theme struct {
	Text    color.Color // primary copy
	Muted   color.Color // secondary labels
	Subtle  color.Color // hints, rules
	Border  color.Color // idle borders
	Accent  color.Color // brand purple
	Accent2 color.Color // brand pink
	OK      color.Color
	Warn    color.Color
	Err     color.Color
	Info    color.Color
	Chair   color.Color
	// Speakers are handed out to council members in order.
	Speakers []color.Color
}

func Default() Theme {
	c := lipgloss.Color
	return Theme{
		Text:    c("#DFDBDD"), // Ash
		Muted:   c("#858392"), // Squid
		Subtle:  c("#605F6B"), // Oyster
		Border:  c("#4D4C57"), // Iron
		Accent:  c("#7D5CFF"), // Charple, a touch hotter
		Accent2: c("#FF60FF"), // Dolly
		OK:      c("#12C78F"), // Guac
		Warn:    c("#E8FE96"), // Zest
		Err:     c("#FF388B"), // Cherry
		Info:    c("#00B8FF"), // Malibu
		Chair:   c("#9D8BFF"),
		Speakers: []color.Color{
			c("#00A4FF"), // Malibu
			c("#FF60FF"), // Dolly
			c("#00FFB2"), // Julep
			c("#E8FE96"), // Zest
			c("#FF8A5B"),
			c("#B4A0FF"),
		},
	}
}

// Stance colors a declared position: green for agree, red for disagree, yellow for mixed.
func (t Theme) Stance(name string) color.Color {
	switch name {
	case "agree":
		return t.OK
	case "disagree":
		return t.Err
	case "mixed":
		return t.Warn
	}
	return t.Muted
}

// Speaker returns the color for the i-th council member.
func (t Theme) Speaker(i int) color.Color { return t.Speakers[i%len(t.Speakers)] }

// Gradient colors each rune of s along the given stops.
func Gradient(s string, stops ...color.Color) string {
	runes := []rune(s)
	if len(runes) == 0 {
		return ""
	}
	cols := lipgloss.Blend1D(len(runes), stops...)
	out := ""
	for i, r := range runes {
		out += lipgloss.NewStyle().Foreground(cols[i]).Bold(true).Render(string(r))
	}
	return out
}

// GradientShift is Gradient on a loop: the colors rotate by offset cells, which animates when the
// offset advances every frame.
func GradientShift(s string, offset int, stops ...color.Color) string {
	runes := []rune(s)
	n := len(runes)
	if n == 0 || len(stops) == 0 {
		return s
	}
	loop := append(append([]color.Color{}, stops...), stops[0])
	cols := lipgloss.Blend1D(n, loop...)
	out := ""
	for i, r := range runes {
		out += lipgloss.NewStyle().Foreground(cols[((i+offset)%n+n)%n]).Bold(true).Render(string(r))
	}
	return out
}
