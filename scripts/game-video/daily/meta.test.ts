/**
 * Meta discovery from META_SYSTEM_USER_TOKEN (meta.mjs), against canned
 * replies only: nothing here calls Meta.
 */
import { describe, expect, test } from "bun:test";
import { discoverMeta, MetaRefused } from "./meta.mjs";

interface Req {
  method: string;
  url: string;
  headers?: Record<string, string>;
}
interface Reply {
  status: number;
  json?: unknown;
}

/** A live-mode transport that answers from `answer` and keeps every request. */
const fakeLive = (answer: (req: Req) => Reply) => {
  const sent: Req[] = [];
  return {
    mode: "live",
    sent,
    request(req: Req) {
      sent.push(req);
      return Promise.resolve(answer(req));
    },
  };
};

/** What `run` rejected with; a test fails if it did not reject. */
const rejected = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
};

describe("Meta discovery", () => {
  const page = (id: string, name: string) => ({
    id,
    name,
    access_token: `SECRET-PAGE-TOKEN-${id}`,
  });
  const meta = (pages: unknown[], ig: unknown = { id: "IG1" }) =>
    fakeLive((req) => {
      if (req.url.includes("/me/accounts")) {
        return { status: 200, json: { data: pages } };
      }
      if (req.url.endsWith("?fields=instagram_business_account")) {
        return {
          status: 200,
          json: ig
            ? { instagram_business_account: ig, id: "P1" }
            : { id: "P1" },
        };
      }
      return { status: 200, json: { username: "wallgameio" } };
    });

  test("one Page: its id, name and Page token; the Instagram id and handle", async () => {
    const transport = meta([page("P1", "Wall Game")]);
    expect(
      await discoverMeta({
        transport,
        token: "SECRET-SU",
        instagram: "handle",
      }),
    ).toEqual({
      pageId: "P1",
      pageName: "Wall Game",
      pageToken: "SECRET-PAGE-TOKEN-P1",
      igUserId: "IG1",
      igUsername: "wallgameio",
    });
    expect(transport.sent.map((r) => r.url)).toEqual([
      "https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token",
      "https://graph.facebook.com/v26.0/P1?fields=instagram_business_account",
      "https://graph.facebook.com/v26.0/IG1?fields=username",
    ]);
    // The system user token goes only in the header.
    for (const r of transport.sent) {
      expect(r.url).not.toContain("SECRET");
      expect(r.headers?.authorization).toBe("Bearer SECRET-SU");
    }
    // Facebook alone needs no Instagram.
    const fb = meta([page("P1", "Wall Game")]);
    expect((await discoverMeta({ transport: fb, token: "t" })).pageId).toBe(
      "P1",
    );
    expect(fb.sent).toHaveLength(1);
  });

  test("no Page, two Pages, or a Page with no Instagram link is refused by name", async () => {
    const none = await rejected(
      discoverMeta({ transport: meta([]), token: "t" }),
    );
    expect(none).toBeInstanceOf(MetaRefused);
    expect(String(none)).toMatch(/sees no Facebook Page/);

    const two = String(
      await rejected(
        discoverMeta({
          transport: meta([page("P1", "Wall Game"), page("P2", "Nil's Page")]),
          token: "t",
        }),
      ),
    );
    expect(two).toMatch(/sees 2 Facebook Pages \("Wall Game", "Nil's Page"\)/);
    expect(two).not.toContain("SECRET");

    const unlinked = String(
      await rejected(
        discoverMeta({
          transport: meta([page("P1", "Wall Game")], null),
          token: "t",
          instagram: "id",
        }),
      ),
    );
    expect(unlinked).toMatch(
      /Page "Wall Game" has no linked Instagram professional account/,
    );
  });

  test("an error reply is refused without its body", async () => {
    const err = await rejected(
      discoverMeta({
        transport: fakeLive(() => ({
          status: 400,
          json: {
            error: {
              message: "SECRET-IN-MESSAGE",
              type: "OAuthException",
              code: 190,
            },
            data: [page("P1", "x")],
          },
        })),
        token: "t",
      }),
    );
    expect(String(err)).toBe(
      "MetaRefused: meta Page list (/me/accounts) failed: HTTP 400 OAuthException 190",
    );
  });
});
