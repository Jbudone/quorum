package e2e

import (
	"os/exec"
	"strings"
	"testing"
)

// Without a terminal the app explains itself and exits 0 instead of failing with a TTY error.
func TestNoTerminalIsGraceful(t *testing.T) {
	bin := t.TempDir() + "/quorum"
	if out, err := exec.Command("go", "build", "-o", bin, "../cmd/quorum").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	cmd := exec.Command(bin, "--mock")
	cmd.Stdin = strings.NewReader("")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("expected a clean exit, got %v\n%s", err, out)
	}
	for _, want := range []string{"needs a real terminal", "pnpm tui"} {
		if !strings.Contains(string(out), want) {
			t.Errorf("output is missing %q:\n%s", want, out)
		}
	}
}
