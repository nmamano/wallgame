import { describe, expect, it } from "bun:test";
import { moveNotationDisplayParts } from "../frontend/src/lib/move-notation-display";

describe("move notation display", () => {
  it("uses each Animal Cycle icon without changing destinations", () => {
    expect(moveNotationDisplayParts("Ca8.Db7.Ec6.Md5", true)).toEqual([
      { icon: "cat", text: "a8" },
      { text: "." },
      { icon: "dog", text: "b7" },
      { text: "." },
      { icon: "elephant", text: "c6" },
      { text: "." },
      { icon: "mouse", text: "d5" },
    ]);
  });

  it("leaves walls and passes as text", () => {
    expect(moveNotationDisplayParts(">a4.^b3", true)).toEqual([
      { text: ">a4" },
      { text: "." },
      { text: "^b3" },
    ]);
    expect(moveNotationDisplayParts("---", true)).toEqual([{ text: "---" }]);
  });

  it("keeps standard and classic notation unchanged", () => {
    expect(moveNotationDisplayParts("Ca8.Mb7", false)).toEqual([
      { text: "Ca8.Mb7" },
    ]);
  });
});
