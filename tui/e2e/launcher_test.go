package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The ./quorum launcher must work from any directory, including through a symlink on PATH, and
// open the room in the directory it was started from.
func TestLauncherWorksFromAnyDirectory(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "engine", "node_modules", ".bin", "tsx")); err != nil {
		t.Skip("engine is not installed (run pnpm install)")
	}
	project := t.TempDir()
	link := filepath.Join(t.TempDir(), "quorum")
	if err := os.Symlink(filepath.Join(root, "quorum"), link); err != nil {
		t.Fatal(err)
	}
	tm := launch(t, 140, 40, project, link, "--mock")
	// First run may compile the TUI. The workspace is the project it was started from.
	s := tm.waitFor("What should this channel work on", 90*time.Second)
	if !strings.Contains(s, filepath.Base(project)+" › new channel") {
		t.Fatalf("the workspace should be the launch directory %s:\n%s", project, s)
	}
	tm.send("\x03")
	done := make(chan error, 1)
	go func() { done <- tm.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("launcher exited with an error after ctrl+c: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("launcher did not exit after ctrl+c")
	}
}
