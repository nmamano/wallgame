/** @jsxImportSource react */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PastGamePlayerKind } from "../../../shared/contracts/games";
import { PastGamePlayerToken } from "./past-game-player-token";

describe("PastGamePlayerToken", () => {
  for (const [kind, label, color] of [
    ["guest", "Guest", "text-slate-700"],
    ["bot", "Bot", "text-violet-700"],
    ["member", "Member", "text-sky-700"],
  ] as const satisfies readonly (readonly [
    PastGamePlayerKind,
    string,
    string,
  ])[]) {
    it(`gives ${kind} color-only visible styling and an accessible text name`, () => {
      const html = renderToStaticMarkup(
        <PastGamePlayerToken kind={kind}>Player</PastGamePlayerToken>,
      );

      expect(html).toContain(`data-player-kind="${kind}"`);
      expect(html).toContain(color);
      expect(html).toContain(`<span class="sr-only">${label}: </span>`);
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("border");
      expect(html).not.toContain("rounded");
      expect(html).not.toContain("bg-");
    });
  }
});
