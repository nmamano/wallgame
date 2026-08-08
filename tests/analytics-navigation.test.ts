/**
 * Reporting in-app navigation to analytics.
 *
 * Measured on production before any of this was written: GA emitted a
 * page_view on a full document load and on nothing else - not for a real click
 * from / to /play, and not for a parameter-only change between two games. These
 * tests cover the decision of what to report and the subscription that reports
 * it. Whether Google then accepts the event is a question no unit test can
 * answer; that is what the production wire capture is for.
 *
 * No browser, no gtag, no hostname: the whole point of injecting the sender is
 * that the interesting logic runs anywhere.
 */

import { describe, it, expect } from "bun:test";
import {
  canonicalPath,
  shouldReportNavigation,
  buildPageViewPayload,
  installNavigationReporting,
  metaForLocation,
  type NavigationSource,
  type PageViewPayload,
  type ReportableLocation,
} from "../frontend/src/lib/analytics";
import {
  CANONICAL_PATHS,
  pageMetaForPath,
  DEFAULT_PAGE_META,
} from "../shared/domain/page-metadata";
// The SERVER's own function, not the shared lookup it happens to call. An
// earlier version of the parity test compared metaForLocation to
// pageMetaForPath, which metaForLocation IS - it would have passed however far
// the two sides drifted.
import { metaForPath } from "../server/routes/html-shell";

const at = (pathname: string, searchStr = ""): ReportableLocation => ({
  pathname,
  searchStr,
});

/** A stand-in router: hand it resolutions and watch what gets reported. */
function fakeRouter() {
  let listener:
    | ((payload: {
        fromLocation?: ReportableLocation;
        toLocation: ReportableLocation;
      }) => void)
    | undefined;

  const source: NavigationSource = {
    subscribe(_event, next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };

  return {
    source,
    get subscribed() {
      return listener !== undefined;
    },
    resolve(from: ReportableLocation | undefined, to: ReportableLocation) {
      listener?.({ fromLocation: from, toLocation: to });
    },
  };
}

/**
 * Installs the reporter and records BOTH effects into one ordered list, so the
 * order between them is assertable rather than assumed.
 */
function install(router: ReturnType<typeof fakeRouter>) {
  const sent: PageViewPayload[] = [];
  const calls: string[] = [];
  const stop = installNavigationReporting(
    router.source,
    {
      setTitle: (title) => calls.push(`title:${title}`),
      send: (payload) => {
        calls.push(`event:${payload.page_title}`);
        sent.push(payload);
      },
    },
    "https://wallgame.io",
  );
  return { sent, calls, stop };
}

describe("canonicalPath", () => {
  it("treats a trailing slash as the same page", () => {
    expect(canonicalPath(at("/play/"))).toBe(canonicalPath(at("/play")));
  });

  it("keeps the query string, which selects different content", () => {
    expect(canonicalPath(at("/past-games", "?page=2"))).toBe(
      "/past-games?page=2",
    );
  });
});

describe("shouldReportNavigation", () => {
  it("says nothing on the first resolution", () => {
    // gtag's config call already counted the initial load; that is the one
    // thing GA does correctly today, and double-counting it would be worse
    // than the bug being fixed.
    expect(shouldReportNavigation(undefined, at("/"))).toBe(false);
  });

  it("reports a move between route families", () => {
    // The case that killed the original hypothesis: / -> /play emitted nothing.
    expect(shouldReportNavigation(at("/"), at("/play"))).toBe(true);
  });

  it("reports a change of only the path parameter", () => {
    expect(
      shouldReportNavigation(at("/game/AAAA1111"), at("/game/BBBB2222")),
    ).toBe(true);
  });

  it("reports a change of only the query string", () => {
    expect(
      shouldReportNavigation(at("/past-games"), at("/past-games", "?page=2")),
    ).toBe(true);
  });

  it("stays quiet when the location did not really change", () => {
    expect(shouldReportNavigation(at("/play"), at("/play"))).toBe(false);
    expect(shouldReportNavigation(at("/play"), at("/play/"))).toBe(false);
  });
});

describe("the payload", () => {
  it("carries an absolute location, a path and the destination title", () => {
    const payload = buildPageViewPayload(
      "https://wallgame.io",
      at("/"),
      at("/puzzles"),
      "Wall Game puzzles and solo campaign",
    );

    expect(payload).toEqual({
      page_location: "https://wallgame.io/puzzles",
      page_path: "/puzzles",
      page_title: "Wall Game puzzles and solo campaign",
      page_referrer: "https://wallgame.io/",
    });
  });

  /**
   * The referrer is the page just left, not the page being entered, and it is
   * absolute. Stating it separately because the two URLs differ by one path in
   * the assertion above, which is the kind of pair a copy-paste can equalise
   * without any test noticing.
   */
  it("names the page just left as the referrer", () => {
    const payload = buildPageViewPayload(
      "https://wallgame.io",
      at("/play", "?variant=classic"),
      at("/ranking"),
      "Wall Game rankings",
    );

    expect(payload.page_referrer).toBe(
      "https://wallgame.io/play?variant=classic",
    );
    expect(payload.page_location).toBe("https://wallgame.io/ranking");
  });
});

/**
 * What the referrer is FOR. gtag fills `page_referrer` from
 * `document.referrer` when a payload omits it, and in a single-page app that
 * value is frozen at whatever brought the visitor in - so an omitted referrer
 * does not read as "no referrer", it reads as "arrived from Google again",
 * on every navigation of the visit. That is what produced a shadow
 * "Unassigned" channel on the real property (see PageViewPayload).
 */
describe("the referrer never points outside the app", () => {
  it("stays in-app across a whole visit that began at Google", () => {
    const router = fakeRouter();
    const { sent } = install(router);

    router.resolve(undefined, at("/"));
    router.resolve(at("/"), at("/play"));
    router.resolve(at("/play"), at("/game/abc"));
    router.resolve(at("/game/abc"), at("/game/def"));

    expect(sent.map((event) => event.page_referrer)).toEqual([
      "https://wallgame.io/",
      "https://wallgame.io/play",
      "https://wallgame.io/game/abc",
    ]);
  });
});

describe("the subscription", () => {
  it("sends one event per real navigation, and none for the first", () => {
    const router = fakeRouter();
    const { sent } = install(router);

    router.resolve(undefined, at("/"));
    router.resolve(at("/"), at("/play"));
    router.resolve(at("/play"), at("/puzzles"));

    expect(sent.map((event) => event.page_path)).toEqual(["/play", "/puzzles"]);
  });

  it("sends one event for going back, and one for going forward", () => {
    const router = fakeRouter();
    const { sent } = install(router);

    router.resolve(undefined, at("/"));
    router.resolve(at("/"), at("/play"));
    router.resolve(at("/play"), at("/")); // back
    router.resolve(at("/"), at("/play")); // forward

    expect(sent.map((event) => event.page_path)).toEqual([
      "/play",
      "/",
      "/play",
    ]);
  });

  it("sets the title before sending, and sends the title it set", () => {
    const router = fakeRouter();
    const { calls, sent } = install(router);

    router.resolve(undefined, at("/"));
    router.resolve(at("/"), at("/ranking"));

    const title = pageMetaForPath("/ranking").title;
    // Order, not just presence: a title written after the event would leave GA
    // recording the page the visitor came from, and a test that only checked
    // both happened could not tell the two apart.
    expect(calls).toEqual([`title:${title}`, `event:${title}`]);
    expect(sent[0]?.page_title).toBe(title);
  });

  it("stops when told to", () => {
    const router = fakeRouter();
    const { sent, stop } = install(router);

    router.resolve(undefined, at("/"));
    stop();
    router.resolve(at("/"), at("/play"));

    expect(router.subscribed).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("the client and the server describe a page identically", () => {
  it("agrees on the title and description of every canonical page", () => {
    // The reason the copy lives in shared/: if these ever diverge, a crawler
    // and a visitor see different titles for the same URL, and nothing would
    // notice. So this drives the SERVER's metaForPath against the CLIENT's
    // metaForLocation, and would fail if either stopped reading the shared
    // table.
    for (const path of CANONICAL_PATHS) {
      const server = metaForPath(path);
      const client = metaForLocation(at(path));

      expect({ title: server.title, description: server.description }).toEqual(
        client,
      );
    }
  });

  it("agrees on the pages that have no copy of their own", () => {
    for (const path of ["/game/AAAA1111", "/puzzles/S-42", "/nope"]) {
      const server = metaForPath(path);

      expect(metaForLocation(at(path))).toEqual(DEFAULT_PAGE_META);
      expect({ title: server.title, description: server.description }).toEqual(
        DEFAULT_PAGE_META,
      );
    }
  });

  it("composes the absolute URL only on the server", () => {
    // The origin is a deployment fact and stays out of shared/, so this is the
    // one part of the metadata the client cannot reproduce.
    expect(metaForPath("/puzzles").url).toBe("https://wallgame.io/puzzles");
    expect(metaForPath("/puzzles/").url).toBe("https://wallgame.io/puzzles");
    expect(metaForPath("/game/AAAA1111").url).toBe(
      "https://wallgame.io/game/AAAA1111",
    );
  });
});
