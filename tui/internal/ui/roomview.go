package ui

import (
	"fmt"
	"image/color"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/rpc"
	"github.com/jbud/quorum/tui/internal/theme"
)

func (r *roomModel) colorOf(th theme.Theme, id string) color.Color {
	switch id {
	case "human":
		return th.Accent2
	case "chair":
		return th.Chair
	case "assistant", "scribe":
		return th.Info
	}
	return th.Speaker(r.color(id))
}

// displayName is how the feed names a speaker: the human is "you".
func displayName(id string) string {
	if id == "human" {
		return "you"
	}
	return id
}

func clock(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ""
	}
	return t.Local().Format("15:04")
}

// channelLabel is how the channel is named in the header and switcher.
func (r *roomModel) channelLabel() string {
	switch {
	case r.name != "":
		return "#" + r.name
	case r.focus != "":
		return "#" + r.focus
	}
	return "#new"
}

func renderRoomHeader(r *roomModel, th theme.Theme, width int, spin string) string {
	sep := fg(th.Subtle).Render(" › ")
	left := fg(th.Accent2).Render("▓▒░ ") + theme.GradientShift("QUORUM", r.frame/2, th.Accent2, th.Accent, th.Info, th.Speaker(2)) +
		fg(th.Accent2).Render(" ░▒▓ ")
	if r.workspace != "" {
		left += fg(th.Muted).Render(r.workspace) + sep
	}
	left += fg(th.Text).Bold(true).Render(r.channelLabel())
	if r.view != 0 {
		left += sep + fg(th.Info).Render("thread: "+ansiCut(r.thread(r.view).title, 40))
	} else if t := r.focusTitle(); t != "" && t != r.name {
		left += fg(th.Muted).Render("  " + ansiCut(firstLine(t), 50))
	}
	var chips []string
	for cli, q := range r.quota {
		c := th.Muted
		if q >= r.tuning.QuotaStop {
			c = th.Err
		} else if q >= r.tuning.QuotaWarn {
			c = th.Warn
		}
		chips = append(chips, fg(c).Render(fmt.Sprintf("%s %d%%", strings.ToUpper(cli), int(q*100+0.5))))
	}
	right := strings.Join(chips, fg(th.Subtle).Render("  ·  "))
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		return ansi.Truncate(left, max(width-lipgloss.Width(right)-1, 10), "…") + " " + right
	}
	return left + strings.Repeat(" ", gap) + right
}

// renderStatusBar is the full-width line under the header that always says whether the channel
// is live: a solid bar with the reason while paused, a quiet line while running.
func renderStatusBar(r *roomModel, th theme.Theme, width int, spin string) string {
	k := func(s string) string { return fg(th.Text).Bold(true).Render(s) }
	var line string
	switch {
	case r.state == "paused":
		text := " ❚❚ PAUSED · " + r.pauseReason() + ".  Nobody is talking; what you say waits for you to resume.  alt+p resume "
		bar := lipgloss.NewStyle().Background(th.Warn).Foreground(lipgloss.Color("#201F26")).Bold(true)
		return bar.Render(padRight(ansiCut(text, width), width))
	case r.flash != "" && r.frame < r.flashTo:
		line = fg(th.OK).Bold(true).Render(r.flash)
	case r.state == "running" && len(r.live) > 0:
		n := len(r.live)
		line = fg(th.OK).Bold(true).Render("● LIVE") + fg(th.Muted).Render(fmt.Sprintf(" · %s %d %s", spin, n, map[bool]string{true: "member talking", false: "members talking"}[n == 1]))
	case r.state == "running":
		line = fg(th.OK).Bold(true).Render("● LIVE") + fg(th.Muted).Render(" · "+spin+" deciding who speaks next")
	default:
		line = fg(th.OK).Bold(true).Render("● LIVE") + fg(th.Muted).Render(" · quiet: waiting for something new to respond to")
	}
	hint := fg(th.Subtle).Render("alt+p ") + k("pause")
	gap := width - lipgloss.Width(line) - lipgloss.Width(hint)
	if gap < 2 {
		return ansi.Truncate(line, width, "…")
	}
	return line + strings.Repeat(" ", gap) + hint
}

// messageHead is the line above a message: who, to whom, what it answers, and when.
func messageHead(r *roomModel, th theme.Theme, width int, from, to string, replyTo, seq int, ts string) string {
	head := fg(r.colorOf(th, from)).Bold(true).Render(displayName(from))
	if to != "" && to != "room" {
		head += fg(th.Warn).Render(" → " + displayName(to) + " · private")
	}
	if replyTo > 0 {
		if who, ok := r.authors[replyTo]; ok && who != from {
			head += fg(th.Subtle).Render(" ↩ " + displayName(who))
		}
	}
	var meta string
	if seq > 0 {
		meta = fg(th.Subtle).Render(strings.TrimSpace(clock(ts) + fmt.Sprintf("  #%d", seq)))
	}
	if gap := width - lipgloss.Width(head) - lipgloss.Width(meta); gap > 1 && meta != "" {
		return head + strings.Repeat(" ", gap) + meta
	}
	return head
}

// renderFeedItem draws one log entry as a chat message or a one-line event.
func renderFeedItem(r *roomModel, it *feedItem, th theme.Theme, width int) string {
	if it.cache != "" && it.cacheW == width {
		return it.cache
	}
	e := it.ev
	event := func(glyph string, c color.Color, text string) string {
		return ansi.Truncate(fg(c).Render(glyph+" ")+fg(th.Muted).Render(text), width, "…")
	}
	var out string
	switch e.Type {
	case "thread.summary":
		out = fg(th.Info).Render("↳ ") + fg(th.Muted).Render(ansi.Wrap(fmt.Sprintf("thread on #%d settled: %s", e.Thread, e.Text), max(width-2, 10), ""))
	case "message":
		body := renderMarkdown(e.Text, max(width, 10), th)
		if e.To != "room" {
			body = fg(th.Muted).Italic(true).Render(body)
		}
		out = messageHead(r, th, width, e.From, e.To, e.ReplyTo, e.Seq, e.TS) + "\n" + body
	case "topic.raised":
		if r.opening(e) {
			break // the human's opening question already reads as their first message
		}
		out = event("◆", th.Info, fmt.Sprintf("%s raised a topic: “%s”", displayName(e.By), e.Title))
	case "topic.focus":
		if r.opening(e) {
			break
		}
		t := e.Slug
		for _, x := range r.topics {
			if x.Slug == e.Slug {
				t = x.Title
			}
		}
		out = event("▸", th.Accent2, "focus: "+t)
	case "topic.closed":
		out = event("✓", th.OK, "topic "+e.Slug+" closed"+suffix(": ", e.Why))
	case "doc.revised":
		out = event("✎", th.Accent, fmt.Sprintf("%s wrote %s v%d%s  · ctrl+o to read", e.By, e.Slug, e.Version, suffix(" — ", e.Note)))
	case "doc.accepted":
		out = fg(th.OK).Bold(true).Render(fmt.Sprintf("✓ %s v%d accepted by the %s", e.Slug, e.Version, e.By))
	case "agent.joined":
		out = event("+", th.OK, fmt.Sprintf("%s joined (%s on %s)", e.Agent, e.Persona, e.CLI))
	case "agent.left":
		out = event("−", th.Muted, e.Agent+" left"+suffix(" · memo: ", firstLine(e.Memo)))
	case "budget":
		c := th.Warn
		if e.Level == "stop" {
			c = th.Err
		}
		out = event("$", c, e.Detail)
	case "paused":
		out = fg(th.Warn).Bold(true).Render("❚❚ paused — "+e.Reason) + " " + fg(th.Subtle).Render(clock(e.TS))
	case "resumed":
		out = fg(th.OK).Render("▶ resumed") + " " + fg(th.Subtle).Render(clock(e.TS))
	case "turn.failed":
		out = event("✗", th.Err, e.Agent+" couldn't speak: "+firstLine(e.Message))
	}
	it.cache, it.cacheW = out, width
	return out
}

// opening reports whether a topic event is the room's opening question being set up.
func (r *roomModel) opening(e rpc.RoomEvent) bool {
	return e.By == "human" && len(r.topics) > 0 && e.Slug == r.topics[0].Slug
}

func suffix(sep, s string) string {
	if strings.TrimSpace(s) == "" {
		return ""
	}
	return sep + s
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " …"
	}
	return s
}

// toolDoing says in words what a member is doing while it uses a tool.
func toolDoing(tool string) string {
	switch tool {
	case "":
		return "thinking"
	case "doc_draft":
		return "drafting a document"
	case "read_doc":
		return "reading the notes"
	case "raise_topic":
		return "raising a topic"
	case "dm":
		return "writing privately"
	case "notebook_read", "notebook_write":
		return "taking notes"
	case "read_room":
		return "rereading the room"
	}
	return "looking at the code (" + tool + ")"
}

const emptyRoom = `This room is empty.

Describe the problem you want worked out in the box below. Your assistant, on the right, will suggest who to bring in. Approve each one with y and they'll get started.`

// shown reports whether a log entry belongs in the conversation on screen.
func (r *roomModel) shown(e rpc.RoomEvent) bool {
	if r.view == 0 {
		// The channel: everything but replies inside threads (a message that starts one stays, marked).
		return e.Type != "message" || e.Thread == 0 || e.Thread == e.Seq
	}
	return e.Type == "message" && (e.Seq == r.view || e.Thread == r.view) || e.Type == "thread.summary" && e.Thread == r.view
}

func renderFeed(r *roomModel, th theme.Theme, width int, spin string) string {
	if r.empty() {
		return fg(th.Muted).Render(ansi.Wrap(emptyRoom, min(width, 72), ""))
	}
	var blocks []string
	if r.view != 0 {
		blocks = append(blocks, fg(th.Info).Render(fmt.Sprintf("side thread on #%d", r.view))+fg(th.Subtle).Render(" · esc back to the channel"))
	}
	for _, it := range r.feed {
		if !r.shown(it.ev) {
			continue
		}
		b := renderFeedItem(r, it, th, width)
		if b == "" {
			continue
		}
		// A message with a thread under it says so, in the channel.
		if t, ok := r.threads[it.ev.Seq]; ok && r.view == 0 && it.ev.Type == "message" {
			state := fmt.Sprintf("%d %s", t.replies, map[bool]string{true: "reply", false: "replies"}[t.replies == 1])
			if t.summary != "" {
				state += " · settled"
			}
			b += "\n" + fg(th.Info).Render("↳ thread: "+state) + fg(th.Subtle).Render(fmt.Sprintf(" · /thread %d", t.root))
		}
		blocks = append(blocks, b)
	}
	// Members talking right now: their words stream in as they write them.
	for _, t := range r.speaking() {
		id := t.agent
		text := strings.TrimSpace(t.text)
		if text == "" || text == "PASS" {
			blocks = append(blocks, fg(r.colorOf(th, id)).Bold(true).Render(id)+" "+fg(th.Muted).Italic(true).Render(spin+" "+toolDoing(t.tool)+"…"))
			continue
		}
		head := fg(r.colorOf(th, id)).Bold(true).Render(id) + " " + fg(th.Subtle).Render(spin+" typing")
		// Styled line by line: a multi-line Render pads every line, which would push the cursor away.
		lines := strings.Split(ansi.Wrap(text, max(width-1, 10), ""), "\n")
		for i, l := range lines {
			lines[i] = fg(th.Text).Render(l)
		}
		blocks = append(blocks, head+"\n"+strings.Join(lines, "\n")+fg(r.colorOf(th, id)).Render("▌"))
	}
	if r.view != 0 && len(r.speaking()) == 0 && r.state != "paused" {
		blocks = append(blocks, fg(th.Subtle).Italic(true).Render("Replies here stay in the thread; its outcome goes back to the channel."))
	}
	return strings.Join(blocks, "\n\n")
}

// renderDigest is the assistant's pinned "where we are", kept to a few lines.
func renderDigest(r *roomModel, th theme.Theme, width, maxLines int) string {
	if r.digest == "" {
		return ""
	}
	lines := strings.Split(renderMarkdown(r.digest, width, th), "\n")
	if len(lines) > maxLines {
		lines = append(lines[:max(maxLines-1, 1)], fg(th.Subtle).Render("… ask me for more"))
	}
	return fg(th.Info).Bold(true).Render("WHERE WE ARE") + "\n" + strings.Join(lines, "\n")
}

// renderAssistant draws the assistant's conversation with the human.
func renderAssistant(r *roomModel, th theme.Theme, width int, spin string) string {
	var b []string
	if len(r.asides) == 0 && !r.asking {
		intro := "I'm your assistant. I read everything in the room, including private messages, and keep a summary pinned above. Ask me what anyone meant, what to do next, or /catchup for a recap."
		if r.empty() {
			intro = "I'm your assistant. Tell the room what you want worked out (left box) and I'll suggest who to bring in. You can also talk it through with me here first."
		}
		b = append(b, fg(th.Muted).Italic(true).Render(ansi.Wrap(intro, width, "")))
	}
	for _, n := range r.asides {
		switch n.kind {
		case "you":
			b = append(b, fg(th.Accent2).Bold(true).Render("you")+"\n"+renderMarkdown(n.text, width, th))
		case "answer":
			b = append(b, fg(th.Info).Bold(true).Render("assistant")+"\n"+renderMarkdown(n.text, width, th))
		case "note":
			b = append(b, fg(th.Info).Render("◆ assistant")+"\n"+renderMarkdown(n.text, width, th))
		case "system":
			b = append(b, fg(th.Muted).Render(ansi.Wrap(n.text, width, "")))
		case "error":
			b = append(b, fg(th.Err).Render(ansi.Wrap("✗ "+n.text, width, "")))
		}
	}
	switch {
	case r.asking:
		head := fg(th.Info).Bold(true).Render("assistant") + " " + fg(th.Muted).Italic(true).Render(spin+" typing…")
		if a := r.streamingAnswer(); a != "" {
			head = fg(th.Info).Bold(true).Render("assistant") + "\n" + renderMarkdown(a, width, th)
		}
		b = append(b, head)
	case r.busy["watch"] || r.busy["assistant"]:
		b = append(b, fg(th.Muted).Italic(true).Render(spin+" assistant is catching up on the channel…"))
	}
	return strings.Join(b, "\n\n")
}

// renderSuggestions is the "needs you" card at the top of the assistant column. Nothing is selected
// until the human presses alt+n to review, so typing and Enter always go to the chat box.
func renderSuggestions(r *roomModel, th theme.Theme, width int, compact bool) string {
	if len(r.pending) == 0 {
		return ""
	}
	title := fg(th.Warn).Bold(true).Render(fmt.Sprintf("NEEDS YOU · %d", len(r.pending)))
	lines := []string{title}
	for i, s := range r.pending {
		mark := fg(th.Subtle).Render(fmt.Sprintf("%d ", i+1))
		label := fg(th.Text).Render(suggestionLabel(s))
		if r.review && i == r.sugCur {
			mark = fg(th.Accent2).Render("❯ ")
			label = fg(th.Accent2).Bold(true).Render(suggestionLabel(s))
		}
		lines = append(lines, ansi.Truncate(mark+label, width, "…"))
		if s.Why != "" && (!compact || r.review && i == r.sugCur) {
			lines = append(lines, fg(th.Muted).Render(ansi.Truncate("  "+s.Why, width, "…")))
		}
	}
	if r.review {
		lines = append(lines, fg(th.Subtle).Render("y approve · n decline · a all · esc done"))
	} else {
		lines = append(lines, fg(th.Subtle).Render("alt+n to review"))
	}
	return strings.Join(lines, "\n")
}

// renderRoomRoster is the member strip above the inputs: who's here and who's talking.
func renderRoomRoster(r *roomModel, th theme.Theme, width int, spin string) string {
	if len(r.agents) == 0 {
		return fg(th.Subtle).Render("nobody in the room yet")
	}
	var parts []string
	for _, a := range r.agents {
		name := fg(r.colorOf(th, a.ID)).Render(a.ID)
		if t, ok := r.talking(a.ID); ok {
			doing := "typing"
			if t.text == "" {
				doing = toolDoing(t.tool)
			}
			if t.thread != 0 && t.thread != r.view {
				doing += fmt.Sprintf(" in thread #%d", t.thread)
			}
			parts = append(parts, fg(th.Accent2).Render(spin)+" "+name+fg(th.Muted).Italic(true).Render(" "+doing))
		} else {
			parts = append(parts, fg(th.Subtle).Render("○ ")+name)
		}
	}
	// Support roles at work, so a quiet moment never looks stuck.
	for _, w := range []struct{ role, doing string }{{"floor", "deciding who speaks"}, {"chair", "chair is writing"}, {"scribe", "scribe is taking notes"}} {
		if r.busy[w.role] {
			parts = append(parts, fg(th.Muted).Italic(true).Render(spin+" "+w.doing))
		}
	}
	return ansi.Truncate(strings.Join(parts, "   "), width, "…")
}

func renderTopics(r *roomModel) string {
	var b strings.Builder
	b.WriteString("Topics:\n")
	for _, t := range r.topics {
		mark := "  "
		state := ""
		switch {
		case t.Slug == r.focus:
			mark, state = "▶ ", " (in focus)"
		case t.Closed:
			state = " (closed)"
		default:
			state = " (parked)"
		}
		b.WriteString(mark + t.Slug + " — " + t.Title + state + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// docList builds the documents overlay: the room's outputs, then the scribe's notes.
func (r *roomModel) docList() []docRef {
	refs := []docRef{}
	for _, d := range r.docs {
		label := fmt.Sprintf("%s  %s v%d", d.Slug, d.Kind, d.Version)
		if d.Accepted > 0 {
			label += fmt.Sprintf("  ✓ v%d accepted", d.Accepted)
		}
		refs = append(refs, docRef{name: d.Slug, label: label})
	}
	for _, n := range r.notes {
		refs = append(refs, docRef{name: n, label: n + "  (scribe's notes)"})
	}
	return refs
}

func renderOverlay(o *docOverlay, th theme.Theme, width int) string {
	if o.list != nil {
		lines := []string{sectionTitle(o.title, width, th, true), ""}
		if len(o.list) == 0 {
			empty := "Nothing yet. Members write documents as the discussion needs them, and the scribe keeps notes as the room talks."
			if o.rooms {
				empty = "No other rooms in this project yet. /new starts one."
			}
			lines = append(lines, fg(th.Muted).Italic(true).Render(ansi.Wrap(empty, width, "")))
		}
		for i, d := range o.list {
			if i == o.cur {
				lines = append(lines, fg(th.Accent2).Bold(true).Render("❯ "+d.label))
			} else {
				lines = append(lines, fg(th.Text).Render("  "+d.label))
			}
		}
		lines = append(lines, "", fg(th.Subtle).Render("↑↓ choose · enter open · esc close"))
		return strings.Join(lines, "\n")
	}
	return sectionTitle(o.title, width, th, true) + "\n\n" + renderMarkdown(o.text, width, th) + "\n\n" + fg(th.Subtle).Render("esc close · pgup/pgdn scroll")
}

func roomFooter(r *roomModel, th theme.Theme, width int) string {
	k := func(key, what string) string { return fg(th.Text).Render(key) + " " + fg(th.Muted).Render(what) }
	sep := fg(th.Subtle).Render(" · ")
	pause := k("alt+p", "pause")
	if r.state == "paused" {
		pause = k("alt+p", "resume")
	}
	box := k("tab", "talk to your assistant")
	if r.pane == paneAssistant {
		box = k("tab", "talk to the channel")
	}
	parts := []string{box, k("alt+g", "plan"), k("alt+k", "switch"), k("alt+a", "add someone"), pause, k("ctrl+o", "docs"), k("alt+s", "stats"), k("/help", "commands"), k("ctrl+c", "quit")}
	if r.view != 0 {
		parts = append([]string{k("esc", "back to channel")}, parts...)
	}
	if r.review {
		parts = []string{k("↑↓", "choose"), k("y", "approve"), k("n", "decline"), k("a", "approve all"), k("esc", "done")}
	}
	if r.overlay != nil {
		parts = []string{k("esc", "close"), k("↑↓", "move"), k("enter", "open")}
	}
	for len(parts) > 1 && lipgloss.Width(strings.Join(parts, sep)) > width {
		parts = parts[:len(parts)-1]
	}
	return ansi.Truncate(strings.Join(parts, sep), width, "")
}
