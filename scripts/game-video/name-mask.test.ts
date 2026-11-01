import { describe, expect, test } from "bun:test";
import { shownNames } from "./name-mask.mjs";
import { dailySeatNames } from "./edl.mjs";

/** A member's real-looking username, and a guest's generated name. */
const MEMBER = "maria_k92";
const GUEST = "Guest Tapir";
const NAMES = [MEMBER, GUEST];

describe("the name mask (Nil, 2026-11-01: ALL games, no names)", () => {
  test("a seat's name anywhere in a frame's state is found, in any case", () => {
    expect(shownNames({ top: { name: MEMBER } }, NAMES)).toEqual([MEMBER]);
    expect(shownNames({ overlay: { text: `gg MARIA_K92 😭` } }, NAMES)).toEqual(
      [MEMBER],
    );
    expect(
      shownNames({ caption: "guest tapir runs", vsOverlay: { a: {} } }, NAMES),
    ).toEqual([GUEST]);
  });

  test("only as a whole word; a name under 3 characters is not looked for", () => {
    expect(shownNames({ caption: "xmaria_k92x" }, NAMES)).toEqual([]);
    expect(shownNames({ caption: "go bo go" }, ["bo"])).toEqual([]);
  });

  test("a daily frame of a member's game carries the username nowhere", () => {
    // The seats as the replay page gives them: a member against a bot.
    const names = dailySeatNames({
      red: { configType: "human", displayName: MEMBER },
      blue: { configType: "bot", displayName: "Normal Bot" },
    });
    expect(names).toEqual({ red: "Human", blue: "Bot" });
    // Every surface a daily frame names a seat on: the head row, the VS
    // card, the strip, an overlay's {red}, the GG card's winner and loser.
    const side = (name: string) => ({ name, hex: "#e33", portrait: "p1.png" });
    const state = {
      top: side(names.red),
      bottom: side(names.blue),
      vsOverlay: { a: { ...side(names.red), word: names.red } },
      strip: { left: side(names.red), right: side(names.blue) },
      overlay: { text: "{red} blinked".replace("{red}", names.red) },
      ending: { winner: side(names.red), loser: side(names.blue) },
      caption: "bro hunts the bot 😈",
    };
    expect(shownNames(state, NAMES)).toEqual([]);
    // The same frame with the account's name in any one place is caught.
    expect(shownNames({ ...state, top: side(MEMBER) }, NAMES)).toEqual([
      MEMBER,
    ]);
  });
});
