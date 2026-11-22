import { describe, expect, test } from "bun:test";
import { puzzleLinkProblem } from "./puzzle-gate.mjs";
import {
  videoPuzzleTarget,
  type VideoPuzzle,
} from "../../../shared/domain/video-puzzles";

const ITEM = {
  id: "v-2026-11-29-1",
  edl: { doc: { gameId: "Lndfn42U", puzzle: { ply: 24, n: 3 } } },
};

/** A site that answers every request with `status` and `location`. */
const site = (status: number, location: string | null) => {
  const asked: { url: string; method: string; redirect: string }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    asked.push({
      url,
      method: String(init.method),
      redirect: String(init.redirect),
    });
    return Promise.resolve(
      new Response(null, {
        status,
        headers: location ? { location } : {},
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
};

/** The server's own answer for a deployed table (server/app.ts /go/<n>). */
const served = (puzzles: VideoPuzzle[]) => videoPuzzleTarget(3, puzzles);

describe("puzzleLinkProblem", () => {
  test("a video with no puzzle asks nothing", async () => {
    const s = site(500, null);
    expect(
      await puzzleLinkProblem(
        { id: "v-1", edl: { doc: { gameId: "Lndfn42U" } } },
        s,
      ),
    ).toBeNull();
    expect(s.asked).toEqual([]);
  });

  test("passes when /go/<n> opens the item's position, with one HEAD that follows no redirect", async () => {
    const s = site(
      302,
      served([{ n: 3, itemId: ITEM.id, gameId: "Lndfn42U", ply: 24 }]),
    );
    expect(await puzzleLinkProblem(ITEM, s)).toBeNull();
    expect(s.asked).toEqual([
      { url: "https://wallgame.io/go/3", method: "HEAD", redirect: "manual" },
    ]);
    // An absolute Location on the same site passes too.
    const absolute = site(
      302,
      `https://wallgame.io${served([{ n: 3, itemId: ITEM.id, gameId: "Lndfn42U", ply: 24 }])}`,
    );
    expect(await puzzleLinkProblem(ITEM, absolute)).toBeNull();
  });

  test("an entry not deployed yet (the tagged home page) names the entry to deploy", async () => {
    const problem = await puzzleLinkProblem(ITEM, site(302, served([])));
    expect(problem).toContain("sends to /, not to /puzzle/game/Lndfn42U/24");
    expect(problem).toContain(
      'deploy the entry { n: 3, itemId: "v-2026-11-29-1", gameId: "Lndfn42U", ply: 24 }',
    );
  });

  test("another ply, another item, another site or no redirect is refused", async () => {
    const other = (p: Partial<VideoPuzzle>) =>
      served([{ n: 3, itemId: ITEM.id, gameId: "Lndfn42U", ply: 24, ...p }]);
    expect(
      await puzzleLinkProblem(ITEM, site(302, other({ ply: 23 }))),
    ).toContain(
      "sends to /puzzle/game/Lndfn42U/23, not to /puzzle/game/Lndfn42U/24",
    );
    expect(
      await puzzleLinkProblem(
        ITEM,
        site(302, other({ itemId: "v-2026-11-28-1" })),
      ),
    ).toContain("for the item v-2026-11-28-1, not v-2026-11-29-1");
    expect(
      await puzzleLinkProblem(
        ITEM,
        site(302, `https://evil.example${other({})}`),
      ),
    ).toContain("sends to https://evil.example/puzzle/game/Lndfn42U/24");
    expect(await puzzleLinkProblem(ITEM, site(200, null))).toContain(
      "answers 200 with no Location, not a 302",
    );
  });

  test("a site it cannot reach is a reason, not a throw", async () => {
    const fetchImpl = (() =>
      Promise.reject(
        new Error("getaddrinfo ENOTFOUND"),
      )) as unknown as typeof fetch;
    expect(await puzzleLinkProblem(ITEM, { fetchImpl })).toBe(
      "the puzzle link https://wallgame.io/go/3 cannot be read: getaddrinfo ENOTFOUND",
    );
  });
});
