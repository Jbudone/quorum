// Package e2e drives the real quorum binary and the real TypeScript engine through a pseudo-terminal
// and reads the screen back with a terminal emulator. Skipped when the engine is not installed.
//
// Set QUORUM_E2E_OUT to a directory to also get colored HTML snapshots of key screens.
package e2e

import (
	"fmt"
	"html"
	"image/color"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/vt"
	"github.com/creack/pty"
)

type term struct {
	t    *testing.T
	emu  *vt.Emulator
	ptmx *os.File
	cmd  *exec.Cmd
	mu   sync.Mutex
}

func start(t *testing.T, w, h int, args ...string) *term {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "engine", "node_modules", ".bin", "tsx")); err != nil {
		t.Skip("engine is not installed (run pnpm install)")
	}
	bin := filepath.Join(t.TempDir(), "quorum")
	if out, err := exec.Command("go", "build", "-o", bin, "../cmd/quorum").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return launch(t, w, h, filepath.Join(root, "playground", "fixture-repo"), bin, args...)
}

// launch runs a command in a pty of the given size, starting in dir.
func launch(t *testing.T, w, h int, dir, bin string, args ...string) *term {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "XDG_CACHE_HOME="+t.TempDir())
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(h), Cols: uint16(w)})
	if err != nil {
		t.Fatal(err)
	}
	tm := &term{t: t, emu: vt.NewEmulator(w, h), ptmx: ptmx, cmd: cmd}
	// Terminal output -> emulator; the emulator's replies to queries (cursor position, etc.) -> program.
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				tm.mu.Lock()
				_, _ = tm.emu.Write(buf[:n])
				tm.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { _, _ = io.Copy(ptmx, tm.emu) }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = ptmx.Close()
	})
	return tm
}

func (tm *term) send(s string) { _, _ = tm.ptmx.WriteString(s) }

func (tm *term) text() string {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	var b strings.Builder
	for y := 0; y < tm.emu.Height(); y++ {
		line := strings.Builder{}
		for x := 0; x < tm.emu.Width(); x++ {
			c := tm.emu.CellAt(x, y)
			if c == nil || c.Content == "" {
				line.WriteByte(' ')
				continue
			}
			line.WriteString(c.Content)
		}
		b.WriteString(strings.TrimRight(line.String(), " "))
		b.WriteByte('\n')
	}
	return b.String()
}

func (tm *term) waitFor(want string, timeout time.Duration) string {
	tm.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s := tm.text(); strings.Contains(s, want) {
			return s
		}
		time.Sleep(40 * time.Millisecond)
	}
	tm.t.Fatalf("timed out waiting for %q; screen:\n%s", want, tm.text())
	return ""
}

func (tm *term) typ(s string) {
	for _, r := range s {
		tm.send(string(r))
		time.Sleep(4 * time.Millisecond)
	}
}

func hex(c color.Color, def string) string {
	if c == nil {
		return def
	}
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("#%02x%02x%02x", r>>8, g>>8, b>>8)
}

// snapshot writes a colored HTML rendering of the screen when QUORUM_E2E_OUT is set.
func (tm *term) snapshot(name string) {
	dir := os.Getenv("QUORUM_E2E_OUT")
	if dir == "" {
		return
	}
	tm.mu.Lock()
	defer tm.mu.Unlock()
	var b strings.Builder
	b.WriteString(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#201F26"><pre style="margin:0;padding:12px;background:#201F26;color:#DFDBDD;font:14px/1.25 'JetBrains Mono','DejaVu Sans Mono',monospace">`)
	for y := 0; y < tm.emu.Height(); y++ {
		for x := 0; x < tm.emu.Width(); x++ {
			c := tm.emu.CellAt(x, y)
			ch := " "
			var st uv.Style
			if c != nil {
				if c.Content != "" {
					ch = c.Content
				}
				st = c.Style
			}
			css := "color:" + hex(st.Fg, "#DFDBDD")
			if st.Bg != nil {
				css += ";background:" + hex(st.Bg, "")
			}
			if st.Attrs&uv.AttrBold != 0 {
				css += ";font-weight:bold"
			}
			if st.Attrs&uv.AttrItalic != 0 {
				css += ";font-style:italic"
			}
			if st.Attrs&uv.AttrFaint != 0 {
				css += ";opacity:.6"
			}
			fmt.Fprintf(&b, `<span style="%s">%s</span>`, css, html.EscapeString(ch))
		}
		b.WriteByte('\n')
	}
	b.WriteString("</pre>")
	_ = os.WriteFile(filepath.Join(dir, name+".html"), []byte(b.String()), 0o644)
}

func TestRealBinaryMockSession(t *testing.T) {
	tm := start(t, 140, 42, "--mock", "--council")

	tm.waitFor("draft → critique → revise", 20*time.Second) // presets have loaded
	tm.snapshot("1-start")

	tm.send("\x1b[B") // down: solo -> trio
	tm.send("\t")
	tm.typ("Replace session cookies with short-lived JWTs")
	tm.snapshot("2-start-filled")
	tm.send("\r")

	s := tm.waitFor("YOUR TURN", 60*time.Second)
	if !strings.Contains(s, "RND ●○○") || !strings.Contains(s, "CHAIR //") {
		t.Fatalf("round 1 incomplete:\n%s", s)
	}
	tm.snapshot("3-round1-paused")

	tm.send("\x1b") // skip the open-question walkthrough to talk to the Chair instead
	tm.waitFor("Skipped the open questions", 10*time.Second)
	tm.typ("Why do they disagree?")
	tm.send("\r")
	tm.waitFor("scope, not direction", 30*time.Second)
	tm.waitFor("YOUR TURN", 30*time.Second)
	tm.snapshot("4-asked-chair")

	tm.send("\x1b")                    // skip any open questions
	time.Sleep(300 * time.Millisecond) // a lone Esc must not fuse with the next key into Alt+key
	tm.send("\r")                      // continue
	tm.waitFor("RND ●●○", 60*time.Second)
	tm.waitFor("YOUR TURN", 60*time.Second)
	tm.send("\x1b")
	time.Sleep(300 * time.Millisecond)
	tm.send("\r") // round 3
	tm.waitFor("RND ●●●", 60*time.Second)
	s = tm.waitFor("CONVERGED", 60*time.Second)
	tm.waitFor("YOUR TURN", 30*time.Second)
	tm.snapshot("5-converged")
	_ = s

	tm.send("\x1b")
	time.Sleep(300 * time.Millisecond)
	tm.send("\r") // finish
	tm.waitFor("new session", 30*time.Second)
	s = tm.text()
	if !strings.Contains(s, "COMPLETE") {
		t.Fatalf("expected a complete session:\n%s", s)
	}
	tm.snapshot("6-done")
	tm.send("q")
	done := make(chan error, 1)
	go func() { done <- tm.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("quorum did not exit after q")
	}
}

// TestRealBinaryLiveClaude runs one real round on the solo preset (spends a little Claude quota).
// Opt in with QUORUM_E2E_LIVE=1.
func TestRealBinaryLiveClaude(t *testing.T) {
	if os.Getenv("QUORUM_E2E_LIVE") == "" {
		t.Skip("set QUORUM_E2E_LIVE=1 to spend real quota")
	}
	tm := start(t, 140, 42, "--council")
	tm.waitFor("draft → critique → revise", 30*time.Second)
	tm.send("\t")
	tm.typ("Plan how to make src/auth.ts safe to ship: credential checking and session ids. Keep every reply under 100 words.")
	tm.send("\r")

	s := tm.waitFor("YOUR TURN", 5*time.Minute)
	for _, want := range []string{"architect", "skeptic", "pragmatist", "CHAIR // round 1 briefing", "PLAN · REVISION"} {
		if !strings.Contains(s, want) {
			t.Fatalf("live round is missing %q:\n%s", want, s)
		}
	}
	tm.snapshot("live-round1")

	tm.typ("/stop")
	tm.send("\r")
	tm.waitFor("new session", 30*time.Second)
	tm.snapshot("live-done")
}

// A mock workspace end to end, the way `quorum` opens: the setup chat, the channel the human
// approves, the scripted cast talking through the real floor and room tools, a side thread, the
// assistant's suggestions, and reopening the channel on the next launch.
func TestRealBinaryMockRoom(t *testing.T) {
	repo := t.TempDir()
	tm := start(t, 150, 46, "--mock", "--repo", repo)
	tm.waitFor("What should this channel work on", 30*time.Second)
	tm.snapshot("room-0-setup")
	tm.typ("Should we add a cache to the product API?")
	tm.send("\r")
	tm.waitFor("starting fresh?", 20*time.Second)
	tm.typ("No docs yet")
	tm.send("\r")
	tm.waitFor("ctrl+s open the channel", 20*time.Second)
	tm.snapshot("room-1-lineup")
	tm.send("\x13") // ctrl+s
	tm.waitFor("TALKING", 20*time.Second)
	tm.snapshot("room-2-talking")
	tm.waitFor("accepted by the chair", 60*time.Second)
	tm.waitFor("PAUSED", 10*time.Second)
	s := tm.waitFor("Plan v2 answers every objection", 10*time.Second) // the Chair speaks just after the milestone pause
	for _, want := range []string{"↩ ", "RECENT", "DISCUSSIONS", "MEMBERS"} {
		if !strings.Contains(s, want) {
			t.Fatalf("settled channel is missing %q:\n%s", want, s)
		}
	}
	tm.waitFor("WHERE WE ARE", 10*time.Second)
	tm.snapshot("room-3-milestone")

	tm.send("\x10") // ctrl+p: carry on
	time.Sleep(200 * time.Millisecond)
	tm.typ("/ask How long can a price be stale?")
	tm.send("\r")
	tm.waitFor("nobody pays a stale price", 30*time.Second)
	tm.waitFor("settled", 30*time.Second)
	tm.snapshot("room-4-thread")
	tm.send("\x1b") // back to the channel
	tm.waitFor("NEEDS YOU", 30*time.Second)
	tm.send("\x0e") // ctrl+n: review
	tm.waitFor("y approve", 5*time.Second)
	tm.snapshot("room-5-review")
	tm.send("\x03")
	time.Sleep(300 * time.Millisecond)

	again := start(t, 150, 46, "--mock", "--repo", repo)
	again.waitFor("#product-cache", 30*time.Second)
	again.waitFor("Picked up where you left off", 10*time.Second)
	again.send("\x03")
}
