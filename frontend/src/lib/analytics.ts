/**
 * Telling Google Analytics that the page changed.
 *
 * Measured on production 2026-08-05: GA counted a page_view on a full document
 * load and on nothing else. A real click from / to /play - two different
 * routes, confirmed client-side - produced zero requests to the collect
 * endpoint, as did a parameter-only change from one game to another. Enhanced
 * measurement is not seeing this app's navigation at all, so roughly three
 * quarters of what people do here has been invisible: a visitor who loads once
 * and then plays five games in a sitting counted as a single pageview.
 *
 * So we say it explicitly. The decision of whether a navigation is worth
 * reporting is a pure function with no browser in it; the gtag call is injected
 * at the edge, because gtag exists only on the production hostname and code
 * that can only run there can never be tested.
 */

import type { PageMeta } from "../../../shared/domain/page-metadata";
import {
  normalizePath,
  pageMetaForPath,
} from "../../../shared/domain/page-metadata";

/**
 * The part of a location that decides whether this is a different page.
 *
 * `searchStr`, not `search`: TanStack's ParsedLocation carries BOTH, and
 * `search` is the PARSED OBJECT. Reading the wrong one silently produced a
 * page_path of "/play[object Object]" - caught only by running the real app,
 * because a hand-written fake router supplies whatever the test author
 * believed.
 */
export interface ReportableLocation {
  pathname: string;
  /** Leading "?" included, as the router gives it. Empty when there is none. */
  searchStr: string;
}

export interface PageViewPayload {
  page_location: string;
  page_path: string;
  page_title: string;
}

export type SendPageView = (payload: PageViewPayload) => void;

/**
 * Both effects a reported navigation has, injected together.
 *
 * `setTitle` is injected rather than writing `document.title` directly for the
 * same reason `send` is: it makes the ORDER testable. GA falls back to the
 * document's title for anything a payload leaves out, so a title written after
 * the event would attribute the visit to the page the visitor just left - and
 * that is a bug no assertion on a global could distinguish from success.
 */
export interface NavigationReporter {
  setTitle: (title: string) => void;
  send: SendPageView;
}

/**
 * What counts as "the same page". The hash is excluded on purpose: jumping to
 * an anchor is not a page change, and counting it would inflate exactly the
 * number this work exists to make trustworthy.
 */
export function canonicalPath(location: ReportableLocation): string {
  return `${normalizePath(location.pathname)}${location.searchStr}`;
}

/**
 * Whether a resolved navigation should be reported.
 *
 * `from` is undefined on the app's first resolution, and that case returns
 * false: gtag's own config call already counted the initial load - it is the
 * one thing that was working - so reporting it here would double-count the
 * loads GA currently gets right.
 */
export function shouldReportNavigation(
  from: ReportableLocation | undefined,
  to: ReportableLocation,
): boolean {
  if (!from) return false;
  return canonicalPath(from) !== canonicalPath(to);
}

/** The page's own title and description, from the table the server also uses. */
export function metaForLocation(location: ReportableLocation): PageMeta {
  return pageMetaForPath(location.pathname);
}

export function buildPageViewPayload(
  origin: string,
  location: ReportableLocation,
  title: string,
): PageViewPayload {
  const path = canonicalPath(location);
  return {
    page_location: `${origin}${path}`,
    page_path: path,
    page_title: title,
  };
}

/**
 * The impure seam. Subscribes once and hands back the unsubscribe, so a caller
 * can prove it stops - and so hot reloading in development cannot pile up a new
 * subscription on every edit, which would multiply every event.
 *
 * Typed structurally rather than against the router: this needs `subscribe`
 * and nothing else, and depending on the concrete router type would drag the
 * whole route tree into a test that only wants to check counting.
 */
export interface NavigationSource {
  subscribe(
    event: "onResolved",
    listener: (payload: {
      fromLocation?: ReportableLocation;
      toLocation: ReportableLocation;
    }) => void,
  ): () => void;
}

export function installNavigationReporting(
  router: NavigationSource,
  reporter: NavigationReporter,
  origin: string,
): () => void {
  return router.subscribe("onResolved", ({ fromLocation, toLocation }) => {
    if (!shouldReportNavigation(fromLocation, toLocation)) return;

    const meta = metaForLocation(toLocation);
    reporter.setTitle(meta.title);
    reporter.send(buildPageViewPayload(origin, toLocation, meta.title));
  });
}

/**
 * `gtag` is defined solely on the production hostname - see the guard in
 * index.html - so everywhere else every send below is a no-op rather than an
 * error. One reader for it, so the two senders cannot disagree about how it is
 * found.
 */
function findGtag(): ((...args: unknown[]) => void) | undefined {
  return (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
}

/**
 * The two things that actually touch the browser, and the only part of this
 * file that cannot run in a test.
 */
export const browserReporter: NavigationReporter = {
  setTitle: (title) => {
    document.title = title;
  },
  send: (payload) => {
    findGtag()?.("event", "page_view", payload);
  },
};

/**
 * Anything that is worth counting but is not a navigation.
 *
 * A page view answers "did they get here"; these answer "did they do the
 * thing". The account nudge is the first caller and the reason this exists:
 * signups are countable in our own database, but a signup that never happened
 * looks identical whether the offer was never shown, shown and ignored, or
 * clicked and abandoned at the identity provider. Those are three different
 * problems with three different fixes.
 *
 * Params are flat scalars because that is all GA4 stores - a nested object
 * arrives as "[object Object]", which is the same class of bug as the parsed
 * `search` object in `ReportableLocation` above.
 */
export type SendEvent = (
  name: string,
  params?: Record<string, string | number | boolean>,
) => void;

export const browserSendEvent: SendEvent = (name, params) => {
  findGtag()?.("event", name, params ?? {});
};
