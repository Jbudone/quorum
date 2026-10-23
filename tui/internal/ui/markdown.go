package ui

import (
	"regexp"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

var (
	reBold   = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reCode   = regexp.MustCompile("`([^`]+)`")
	reBullet = regexp.MustCompile(`^(\s*)([-*•])\s+(.*)$`)
	reNum    = regexp.MustCompile(`^(\s*)(\d+)[.)]\s+(.*)$`)
)

// plainInline drops **bold** and `code` markers where per-rune coloring (headings) rules out span styling.
func plainInline(s string) string {
	return reCode.ReplaceAllString(reBold.ReplaceAllString(s, "$1"), "$1")
}

// inline styles **bold** and `code` spans.
func inline(s string, th theme.Theme) string {
	bold := lipgloss.NewStyle().Bold(true).Foreground(th.Text)
	code := lipgloss.NewStyle().Foreground(th.Warn)
	s = reBold.ReplaceAllStringFunc(s, func(m string) string { return bold.Render(reBold.FindStringSubmatch(m)[1]) })
	return reCode.ReplaceAllStringFunc(s, func(m string) string { return code.Render(reCode.FindStringSubmatch(m)[1]) })
}

// renderMarkdown renders the small markdown subset council agents produce (headings, lists,
// bold, inline code, quotes, fences, rules) wrapped to width. It is deliberately not a full
// parser: plans are structured text and need to look good in a narrow pane, not be spec-exact.
func renderMarkdown(src string, width int, th theme.Theme) string {
	if width < 8 {
		width = 8
	}
	text := lipgloss.NewStyle().Foreground(th.Text)
	muted := lipgloss.NewStyle().Foreground(th.Muted)
	var out []string
	inFence := false
	blank := func() {
		if len(out) > 0 && out[len(out)-1] != "" {
			out = append(out, "")
		}
	}
	wrap := func(s, first, rest string) {
		avail := width - lipgloss.Width(first)
		for i, l := range strings.Split(ansi.Wrap(s, avail, ""), "\n") {
			if i == 0 {
				out = append(out, first+l)
			} else {
				out = append(out, rest+l)
			}
		}
	}
	for _, raw := range strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n") {
		line := strings.TrimRight(raw, " \t")
		switch {
		case strings.HasPrefix(strings.TrimSpace(line), "```"):
			inFence = !inFence
		case inFence:
			out = append(out, muted.Render("  "+ansi.Truncate(line, width-2, "…")))
		case strings.TrimSpace(line) == "":
			blank()
		case strings.HasPrefix(line, "# "):
			blank()
			out = append(out, strings.Split(ansi.Wrap(theme.Gradient(plainInline(strings.TrimPrefix(line, "# ")), th.Accent2, th.Accent), width, ""), "\n")...)
		case strings.HasPrefix(line, "## "):
			blank()
			out = append(out, strings.Split(ansi.Wrap(lipgloss.NewStyle().Bold(true).Foreground(th.Info).Render(plainInline(strings.TrimPrefix(line, "## "))), width, ""), "\n")...)
		case strings.HasPrefix(line, "### "), strings.HasPrefix(line, "#### "):
			t := strings.TrimLeft(line, "# ")
			out = append(out, lipgloss.NewStyle().Bold(true).Foreground(th.Muted).Render(plainInline(t)))
		case strings.HasPrefix(strings.TrimSpace(line), "---"):
			out = append(out, muted.Render(strings.Repeat("─", width)))
		case strings.HasPrefix(line, ">"):
			wrap(inline(strings.TrimSpace(strings.TrimPrefix(line, ">")), th), muted.Render("│ "), muted.Render("│ "))
		case reBullet.MatchString(line):
			m := reBullet.FindStringSubmatch(line)
			ind := strings.Repeat(" ", len(m[1]))
			wrap(inline(m[3], th), ind+lipgloss.NewStyle().Foreground(th.Accent2).Render("• "), ind+"  ")
		case reNum.MatchString(line):
			m := reNum.FindStringSubmatch(line)
			ind := strings.Repeat(" ", len(m[1]))
			num := lipgloss.NewStyle().Foreground(th.Accent2).Render(m[2] + ". ")
			wrap(inline(m[3], th), ind+num, ind+strings.Repeat(" ", len(m[2])+2))
		default:
			wrap(text.Render(inline(line, th)), "", "")
		}
	}
	return strings.Trim(strings.Join(out, "\n"), "\n")
}

// wrapPlain wraps plain agent chat text (light inline styling only) to width.
func wrapPlain(s string, width int, th theme.Theme) string {
	if width < 8 {
		width = 8
	}
	var lines []string
	for _, l := range strings.Split(s, "\n") {
		lines = append(lines, strings.Split(ansi.Wrap(inline(l, th), width, ""), "\n")...)
	}
	return strings.Join(lines, "\n")
}
