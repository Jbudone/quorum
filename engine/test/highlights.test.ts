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

describe("highlights for an older channel", () => {
  it("reads back over messages without a gist, once, when the channel opens", async () => {
    const { rig } = await import("./roomRig.js");
    let answer = "";
    const r = rig({ floor: () => [], floorModel: () => answer });
    try {
      const room = r.create({});
      for (const [from, text] of [["arch", "Resize silently deletes content outside the new bounds."], ["skeptic", "Agreed."], ["arch", "Seams appear where two seeds meet."], ["skeptic", "Fine."]] as const)
        room.store.append({ type: "message", from, to: "room", text });
      const seqs = room.store.events().filter((e) => e.type === "message" && e.from === "arch").map((e) => e.seq);
      answer = (`{"highlights": [{"msg": ${seqs[0]}, "kind": "critique", "gist": "found that resizing deletes content."}, {"msg": 999, "gist": "not a message"}]}`);
      await room.backfillHighlights();
      const gists = room.store.events().filter((e) => e.type === "gists");
      expect(gists).toHaveLength(1);
      expect(gists[0].type === "gists" && gists[0].items).toEqual([{ seq: seqs[0], from: "arch", kind: "critique", headline: "", gist: "found that resizing deletes content" }]);
      // Once only.
      await room.backfillHighlights();
      expect(room.store.events().filter((e) => e.type === "gists")).toHaveLength(1);
    } finally {
      await r.closeAll();
    }
  });
});
