package rpc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
)

// Client talks NDJSON to an engine process. Responses and events arrive on one ordered channel so
// the UI sees them in the order the engine produced them.
type Client struct {
	in     io.WriteCloser
	msgs   chan Message
	mu     sync.Mutex
	nextID int
	cmd    *exec.Cmd
	// drained closes once the engine's stdout is fully read.
	drained chan struct{}
}

// ExitMsg is delivered once when the engine's output closes.
type ExitMsg struct{ Err error }

func (ExitMsg) isMessage() {}

// Spawn starts the engine process and begins reading its output.
// Engine stderr goes to stderr (nil discards it) so diagnostics never corrupt the terminal UI.
func Spawn(stderr io.Writer, name string, args ...string) (*Client, error) {
	cmd := exec.Command(name, args...)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting engine: %w", err)
	}
	c := NewClient(in, out)
	c.cmd = cmd
	go func() {
		// Wait after the reader drains so the exit status is reported once.
		<-c.drained
		_ = cmd.Wait()
	}()
	return c, nil
}

// NewClient wires a client to any reader/writer pair (used directly by tests).
func NewClient(in io.WriteCloser, out io.Reader) *Client {
	c := &Client{in: in, msgs: make(chan Message, 256), drained: make(chan struct{})}
	go func() {
		defer close(c.drained)
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			m, err := Decode(append([]byte(nil), line...))
			if err != nil {
				m = Event{Name: "error", Data: EngineError{Message: err.Error()}}
			}
			c.msgs <- m
		}
		c.msgs <- ExitMsg{Err: sc.Err()}
	}()
	return c
}

// Messages is the ordered stream of responses, events and finally an ExitMsg.
func (c *Client) Messages() <-chan Message { return c.msgs }

// Call sends a request and returns its id; the Response arrives on Messages.
func (c *Client) Call(method string, params any) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	b, err := json.Marshal(map[string]any{"id": c.nextID, "method": method, "params": params})
	if err != nil {
		return 0, err
	}
	if _, err := c.in.Write(append(b, '\n')); err != nil {
		return 0, fmt.Errorf("engine is not running: %w", err)
	}
	return c.nextID, nil
}

// Close stops the engine.
func (c *Client) Close() {
	_ = c.in.Close()
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
}
