// Command quorum is the terminal interface for a council of AI agents.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/term"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/ui"
)

func main() {
	repo := flag.String("repo", "", "project the council should ground itself in (default: current directory)")
	mock := flag.Bool("mock", false, "start with scripted mock agents (no tokens spent)")
	engine := flag.String("engine", os.Getenv("QUORUM_ENGINE"), "engine command (default: auto-detected)")
	flag.Parse()

	if !term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprintln(os.Stderr, "quorum needs an interactive terminal; run it directly in a terminal rather than piping or redirecting.")
		os.Exit(2)
	}

	dir := *repo
	if dir == "" {
		dir, _ = os.Getwd()
	}
	dir, _ = filepath.Abs(dir)

	argv, err := engineCommand(*engine)
	if err != nil {
		fmt.Fprintln(os.Stderr, "quorum:", err)
		os.Exit(1)
	}

	logf, logPath := engineLog()
	// A nil *os.File stored in an io.Writer is not a nil writer, so only pass it when it exists.
	var stderr io.Writer
	if logf != nil {
		stderr = logf
	}
	client, err := rpc.Spawn(stderr, argv[0], argv[1:]...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "quorum: %v\n(engine command: %s)\n", err, strings.Join(argv, " "))
		os.Exit(1)
	}
	defer client.Close()

	if err := ui.Run(ui.Options{Client: client, Messages: client.Messages(), Repo: dir, Mock: *mock}); err != nil {
		fmt.Fprintln(os.Stderr, "quorum:", err)
		fmt.Fprintln(os.Stderr, "engine log:", logPath)
		os.Exit(1)
	}
}

// engineCommand resolves how to launch the TypeScript engine in serve mode.
func engineCommand(override string) ([]string, error) {
	if override != "" {
		return append(strings.Fields(override), "serve"), nil
	}
	starts := []string{}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, d := range starts {
		for {
			tsx := filepath.Join(d, "engine", "node_modules", ".bin", "tsx")
			cli := filepath.Join(d, "engine", "src", "cli.ts")
			if exists(tsx) && exists(cli) {
				return []string{tsx, cli, "serve"}, nil
			}
			parent := filepath.Dir(d)
			if parent == d {
				break
			}
			d = parent
		}
	}
	return nil, fmt.Errorf("could not find the engine; run from inside the quorum checkout (after `pnpm install`) or set QUORUM_ENGINE")
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// engineLog opens a log file for the engine's stderr, falling back to discarding it.
func engineLog() (*os.File, string) {
	base := os.Getenv("XDG_CACHE_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".cache")
	}
	p := filepath.Join(base, "quorum", "engine.log")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, p
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, p
	}
	return f, p
}
