package ui

import (
	"encoding/json"
	"testing"

	"github.com/jbud/quorum/tui/internal/rpc"
)

const reviewV2 = "# Plan\n\n## Cache\nUse an LRU.\n\n## Rollout\nShip it."
const reviewV3 = "# Plan\n\n## Cache\nUse an LRU with a 30 s TTL.\n\n## Rollout\nShip it."

// replyID answers the app's request id with a result.
func (h *roomHarness) replyID(id int, result any) {
	h.t.Helper()
	b, err := json.Marshal(result)
	if err != nil {
		h.t.Fatal(err)
	}
	h.send(engineMsg{rpc.Response{ID: id, Result: b}})
}

// openReview puts plan v3 up for review, as the engine does live, and answers the app's room.doc.
func openReview(t *testing.T) *roomHarness {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.event(rpc.RoomEvent{Type: "doc.revised", Seq: 950, Slug: "plan", Version: 3, Kind: "plan", By: "perf-researcher"})
	h.send(engineMsg{rpc.Event{Name: "room.state", Data: rpc.RoomStateEvent{State: "paused", Reason: "ready for review: plan v3"}}})
	h.event(rpc.RoomEvent{Type: "doc.ready", Seq: 951, Slug: "plan", Version: 3, By: "chair"})
	c := h.expectCall("room.doc") // it opens by itself the first time
	if c.params["name"] != "plan" {
		t.Fatalf("room.doc params: %v", c.params)
	}
	h.replyID(c.id, rpc.RoomDocText{Name: "plan", Text: reviewV3, Version: 3, Latest: 3, Ready: 3, Base: 2, BaseText: reviewV2})
	return h
}

func TestReviewOpensBesideTheAssistant(t *testing.T) {
	h := openReview(t)
	s := h.screen()
	contains(t, s, "REVIEW plan v3 · ready for your review · 1 section changed since v2")
	contains(t, s, "Use an LRU with a 30 s TTL.")
	contains(t, s, "a approve")
	contains(t, s, "NOW reviewing plan v3 · Cache") // opens on the first section that changed, after the title
	lacks(t, s, "◆ READY FOR REVIEW")               // the banner is for when the review isn't open

	// The diff shows what changed since the version you last reviewed.
	h.press("d")
	contains(t, h.screen(), "- Use an LRU.")
	contains(t, h.screen(), "+ Use an LRU with a 30 s TTL.")
	h.press("d")

	// Closing it leaves the banner, and ctrl+r opens it again.
	h.press("esc")
	contains(t, h.screen(), "◆ READY FOR REVIEW · plan v3")
	h.press("ctrl+r")
	if c := h.expectCall("room.doc"); c.params["name"] != "plan" {
		t.Fatalf("ctrl+r should open plan, got %v", c.params)
	}
}

func TestReviewQuestionsAndChangesNameTheSection(t *testing.T) {
	h := openReview(t)
	h.press("]") // Cache → Rollout
	contains(t, h.screen(), "reviewing plan v3 · Rollout")
	h.press("r")
	contains(t, h.screen(), "What should change · about Rollout")
	h.typ("stage it per tenant")
	h.press("enter")
	c := h.expectCall("room.review")
	if c.params["action"] != "revise" || c.params["section"] != "Rollout" || c.params["text"] != "stage it per tenant" || c.params["version"] != 3 {
		t.Fatalf("revise params: %v", c.params)
	}
	h.replyID(c.id, rpc.ReviewResult{Version: 3})
	if h.app.rm.room.rev != nil {
		t.Fatal("sending changes should close the review; the room works on them")
	}
	contains(t, h.screen(), "Sent. The room is working on it")

	// Esc backs out of a question without sending it.
	h = openReview(t)
	h.press("c")
	h.typ("why?")
	h.press("esc")
	if h.app.rm.room.rev.mode != reviewReading {
		t.Fatal("esc should cancel the question")
	}
	if c := h.fc.last(); c.method == "room.review" {
		t.Fatalf("nothing should be sent, got %v", c.params)
	}
}

func TestReviewAssistantAnswersAboutTheOpenDoc(t *testing.T) {
	h := openReview(t)
	h.press("tab")
	h.typ("is the TTL enough?")
	h.press("enter")
	c := h.expectCall("room.ask")
	doc, _ := c.params["doc"].(map[string]any)
	if c.params["text"] != "is the TTL enough?" || doc["slug"] != "plan" || doc["version"] != 3 || doc["section"] != "Cache" {
		t.Fatalf("ask params: %v", c.params)
	}
	// Tab goes back to the document, whose keys work again.
	h.press("tab")
	h.press("]")
	contains(t, h.screen(), "reviewing plan v3 · Rollout")
}

func TestReviewApproveThenExport(t *testing.T) {
	h := openReview(t)
	h.press("a")
	c := h.expectCall("room.review")
	if c.params["action"] != "approve" || c.params["version"] != 3 {
		t.Fatalf("approve params: %v", c.params)
	}
	h.replyID(c.id, rpc.ReviewResult{Version: 3, ExportPath: "docs/plan.md"})
	contains(t, h.screen(), "Approved v3. Export it to the project? Path")
	contains(t, h.screen(), "docs/plan.md")
	h.press("enter")
	e := h.expectCall("room.exportDoc")
	if e.params["slug"] != "plan" || e.params["path"] != "docs/plan.md" {
		t.Fatalf("export params: %v", e.params)
	}
	h.replyID(e.id, map[string]string{"path": "docs/plan.md"})
	contains(t, h.screen(), "Exported to docs/plan.md.")
	// Then it offers to hand it to the project's agents.
	contains(t, h.screen(), "Hand it to the project's agents to carry out? Mail to")
	h.press("enter")
	m := h.expectCall("room.handoff")
	if m.params["slug"] != "plan" || m.params["to"] != "all" {
		t.Fatalf("handoff params: %v", m.params)
	}
	h.replyID(m.id, rpc.HandoffResult{File: "2026-11-02-carry-out.md", Path: "docs/plan.md"})
	contains(t, h.screen(), "Mailed it to the project's agents")
	if h.app.rm.room.rev != nil {
		t.Fatal("the hand-off closes the review")
	}
	h.event(rpc.RoomEvent{Type: "doc.accepted", Seq: 960, Slug: "plan", Version: 3, By: "human"})
	contains(t, h.screen(), "plan v3 accepted by you")
}

func TestReviewShowsTheBriefFirst(t *testing.T) {
	h := openReview(t)
	contains(t, h.screen(), "The assistant is writing a short brief of this version")
	h.event(rpc.RoomEvent{Type: "doc.brief", Seq: 952, Slug: "plan", Version: 3, Text: "**What it is:** a cache plan; nothing is built yet."})
	s := h.screen()
	contains(t, s, "IN BRIEF")
	contains(t, s, "nothing is built yet")
	lacks(t, s, "writing a short brief")
	// Skipping the export still offers the hand-off.
	h.press("a")
	c := h.expectCall("room.review")
	h.replyID(c.id, rpc.ReviewResult{Version: 3, ExportPath: "docs/plan.md"})
	h.press("esc")
	contains(t, h.screen(), "Hand it to the project's agents")
	h.press("esc")
	if h.app.rm.room.rev != nil {
		t.Fatal("esc on the hand-off closes the review")
	}
}

func TestStatusLineComesFromTheEngine(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.send(engineMsg{rpc.Event{Name: "room.status", Data: rpc.RoomStatus{Line: "pm-lead speaking · 1 queued · #13 open"}}})
	contains(t, h.screen(), "NOW pm-lead speaking · 1 queued · #13 open")
}

func TestReviewHelpers(t *testing.T) {
	secs := docSections("# A\nx\n```\n# not a heading\n```\n## B\ny")
	if len(secs) != 2 || secs[0].title != "A" || secs[1].title != "B" {
		t.Fatalf("sections: %+v", secs)
	}
	if got := changedSections(reviewV2, reviewV3); len(got) != 1 || got[0] != "Cache" {
		t.Fatalf("changed: %v", got)
	}
	d := lineDiff("a\nb", "a\nB")
	if len(d) != 3 || d[1] != (diffLine{'-', "b"}) || d[2] != (diffLine{'+', "B"}) {
		t.Fatalf("diff: %+v", d)
	}
}

func TestApprovedReceiptShowsWhatYouChangedItTo(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.event(rpc.RoomEvent{Type: "suggestion", Seq: 960, ID: 40, From: "assistant", Action: "export", Args: []string{"plan", "README.md"}, Why: "publish"})
	h.event(rpc.RoomEvent{Type: "suggestion.resolved", Seq: 961, ID: 40, Accepted: true, Args: []string{"plan", "README2.md"}})
	s := h.screen()
	contains(t, s, "You approved, changed:")
	contains(t, s, "README2.md")
	contains(t, s, "suggested:")
}

func TestWebIsGrantedPerMember(t *testing.T) {
	h := newRoomHarness(t, 150, 46)
	h.setup()
	h.typ("/web perf-researcher")
	h.press("enter")
	c := h.expectCall("room.web")
	if c.params["id"] != "perf-researcher" || c.params["on"] != true {
		t.Fatalf("web params: %v", c.params)
	}
	h.replyID(c.id, map[string]any{})
	h.event(rpc.RoomEvent{Type: "agent.web", Seq: 970, Agent: "perf-researcher", On: true, By: "human"})
	contains(t, h.screen(), "perf-researcher can now search the web")
	// A suggestion to grant it reads plainly.
	h.event(rpc.RoomEvent{Type: "suggestion", Seq: 971, ID: 41, From: "assistant", Action: "web", Args: []string{"product-engineer"}, Why: "prior art"})
	contains(t, h.screen(), "let product-engineer search the web")
	h.typ("/web nobody")
	h.press("enter")
	contains(t, h.screen(), "/web takes a member")
}
