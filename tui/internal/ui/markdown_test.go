package ui

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

func TestMarkdownWrapsHeadingsAndNeverOverflows(t *testing.T) {
	src := "# Plan: make `src/auth.ts` **safe** to ship\n\n# A very long plan title that cannot possibly fit on one narrow line of the sidebar\n\n## Goals\n- one **bold** goal that is long enough to wrap around at least once or twice\n- `code` and more\n\n## Design\n1. numbered item that also wraps because it is rather long indeed\n\n> quoted advice\n\n```\ncode line that is long and gets truncated rather than wrapped here\n```\n---\nplain paragraph text"
	for _, w := range []int{20, 34, 60} {
		out := renderMarkdown(src, w, theme.Default())
		for i, l := range strings.Split(out, "\n") {
			if lw := lipgloss.Width(l); lw > w {
				t.Fatalf("width %d: line %d is %d wide: %q", w, i, lw, ansi.Strip(l))
			}
		}
		plain := ansi.Strip(out)
		if strings.Contains(plain, "\n\n\n") {
			t.Errorf("width %d: double blank line in:\n%s", w, plain)
		}
		for _, want := range []string{"Goals", "bold", "numbered", "quoted advice", "plain paragraph"} {
			if !strings.Contains(plain, want) {
				t.Errorf("width %d: missing %q", w, want)
			}
		}
		if strings.Contains(plain, "**") || strings.Contains(plain, "`") || strings.Contains(plain, "## ") {
			t.Errorf("width %d: raw markdown leaked:\n%s", w, plain)
		}
	}
	title := ansi.Strip(renderMarkdown(src, 20, theme.Default()))
	if !strings.Contains(title, "sidebar") {
		t.Errorf("long heading was truncated instead of wrapped:\n%s", title)
	}
}
