package ui

import "github.com/jbud/quorum/tui/internal/rpc"

// improveResponse opens the prompt behind a message (room.prompt) or the channel's prompt-health
// report (room.improve) in the reading overlay. Errors fall through to the usual handler, which
// shows them in the assistant pane.
func (a *App) improveResponse(method string, res rpc.Response) bool {
	if (method != "room.prompt" && method != "room.improve") || res.Err != "" || a.rm == nil || a.rm.room == nil {
		return false
	}
	var out struct {
		Text string `json:"text"`
	}
	if rpc.DecodeResult(res.Result, &out) != nil {
		return false
	}
	title := "Prompt health"
	if method == "room.prompt" {
		title = "Prompt"
	}
	a.rm.room.terms = nil
	a.rm.room.overlay = &docOverlay{title: title, text: out.Text}
	a.rm.overlayVP.GotoTop()
	return true
}
