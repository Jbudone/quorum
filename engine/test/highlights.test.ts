import { describe, expect, it } from "vitest";
import { parseFloor } from "../src/room/floor.js";
import type { RoomEvent } from "../src/room/store.js";

describe("highlights", () => {
  it("keeps the floor's plain-words gist for messages that changed the discussion", () => {
    const fresh = [
      { seq: 5, ts: "", type: "message", from: "kimi", to: "room", text: "Resizing to 128 deletes everything outside it." },
      { seq: 6, ts: "", type: "message", from: "nemo", to: "room", text: "Agreed." },
    ] as RoomEvent[];
    const reply = JSON.stringify({
      speak: [],
      tags: [
        { msg: 5, kind: "critique", headline: "resize deletes content", gist: "  found that shrinking the map silently deletes content. " },
        { msg: 6, kind: "agreement", headline: "agrees" },
      ],
    });
    const { tags } = parseFloor(reply, ["kimi", "nemo"], 2, fresh);
    expect(tags[0]).toMatchObject({ seq: 5, gist: "found that shrinking the map silently deletes content" });
    expect(tags[1].gist).toBeUndefined();
  });
});
