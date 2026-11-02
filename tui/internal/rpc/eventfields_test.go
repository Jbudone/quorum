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
	for _, m := range regexp.MustCompile(`(\w+)\??:`).FindAllStringSubmatch(body, -1) {
		if !have[m[1]] {
			t.Errorf("the engine logs %q but RoomEvent has no such field", m[1])
		}
	}
}
