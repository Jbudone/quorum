package rpc

import (
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// Decoding is strict, so a field the engine logs that RoomEvent lacks breaks the app on that
// event ("unknown field"). Every field of the engine's event union must be here.
func TestRoomEventHasEveryEngineField(t *testing.T) {
	src, err := os.ReadFile("../../../engine/src/room/store.ts")
	if err != nil {
		t.Skip("engine source not alongside:", err)
	}
	s := string(src)
	body := s[strings.Index(s, "export type RoomEventBody"):strings.Index(s, "export type TagKind")]
	// Only the type shapes, not the comments between them.
	body = regexp.MustCompile(`(?s)/\*.*?\*/|//[^\n]*`).ReplaceAllString(body, "")
	have := map[string]bool{}
	rt := reflect.TypeOf(RoomEvent{})
	for i := 0; i < rt.NumField(); i++ {
		have[strings.Split(rt.Field(i).Tag.Get("json"), ",")[0]] = true
	}
	// Only each event shape's own fields: text inside nested object types (an array of
	// { term, brief }, say) belongs to a struct of its own.
	var top strings.Builder
	depth := 0
	for _, c := range body {
		switch c {
		case '{':
			depth++
			top.WriteRune(' ')
			continue
		case '}':
			depth--
			top.WriteRune(' ')
			continue
		}
		if depth <= 1 {
			top.WriteRune(c)
		} else {
			top.WriteRune(' ')
		}
	}
	body = top.String()
	for _, m := range regexp.MustCompile(`(\w+)\??:`).FindAllStringSubmatch(body, -1) {
		if !have[m[1]] {
			t.Errorf("the engine logs %q but RoomEvent has no such field", m[1])
		}
	}
}
