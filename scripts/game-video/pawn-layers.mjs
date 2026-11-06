/**
 * The pawn art the renderer composes, kept to the site's own files (board
 * task b2a19d62, Wall Game PM, 2026-11-06).
 *
 * A player's skin is a free string in the game record (up to 64 characters),
 * and the site draws an http(s) skin as it is. Before this module the render
 * fetched such a skin from its own host and wrote the reply's Content-Type,
 * unescaped, into an <img> of the HTML it composed, in a Chromium with no
 * sandbox on Nil's desktop: a guest could run script there. Nil's rule
 * (2026-10-27): no untrusted public code on his desktop.
 *
 * Three guards, each enough alone for the script:
 * - scrubOffSiteSkins: the capture browser gives the replay page the default
 *   skin for each skin that is not a built-in name, so the page never draws
 *   an off-site pawn and the scrape finds none.
 * - inlineLayer: fetches only a pawn file of the site (builtInLayerUrl), with
 *   no redirect, and keeps only an SVG or PNG reply of a pawn's size.
 * - composeLayers: builds the stack with DOM properties, not HTML text, so
 *   no value can add an attribute, on a page with no network
 *   (newComposePage).
 */

/** The site folders that hold pawn art (frontend/public). */
const PAWN_FOLDERS = ["pawns", "pawn-backings", "pawn-foreground-fixes"];

/**
 * A skin the site ships: "default", a file name ("cat3.svg", or "cat3"), or
 * its site path ("/pawns/cat/cat3.svg"). Every other value is replaced.
 */
const BUILT_IN_SKIN =
  /^(?:default|[a-z0-9][a-z0-9_-]*(?:\.svg)?|\/?pawns\/[a-z-]+\/[a-z0-9][a-z0-9_-]*\.svg)$/i;

/** Whether a skin value names one of the site's own pawn files. */
export const isBuiltInSkin = (value) =>
  typeof value === "string" && BUILT_IN_SKIN.test(value.trim());

/**
 * Set every skin of the replay response that is not built in to "default",
 * in place. Returns what it replaced, as "player <id> <key>", for the log.
 */
export const scrubOffSiteSkins = (body) => {
  const replaced = [];
  for (const p of body?.matchStatus?.players ?? []) {
    const appearance = p?.appearance;
    if (!appearance || typeof appearance !== "object") continue;
    for (const [key, value] of Object.entries(appearance)) {
      if (!key.endsWith("Skin") || value == null) continue;
      if (isBuiltInSkin(value)) continue;
      appearance[key] = "default";
      replaced.push(`player ${p.playerId} ${key}`);
    }
  }
  return replaced;
};

const PAWN_PATH = new RegExp(
  `^/(?:${PAWN_FOLDERS.join("|")})/[a-z-]+/[A-Za-z0-9][A-Za-z0-9_.-]*\\.(?:svg|png)$`,
);

/**
 * The layer's URL when it is a pawn file of `origin` (no query, no other
 * folder, no other host), else null.
 */
export const builtInLayerUrl = (src, origin) => {
  let url;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  if (url.search || url.username || url.password) return null;
  if (!PAWN_PATH.test(url.pathname) || url.pathname.includes("..")) {
    return null;
  }
  return url.href;
};

/** The media types a pawn layer may have: the site's SVG pawns and PNG backings. */
export const LAYER_TYPES = ["image/svg+xml", "image/png"];
/** Over 5 times the largest pawn file (cat176.svg, 177 KB, 2026-11-06). */
export const MAX_LAYER_BYTES = 1024 * 1024;

/** A Content-Type header's media type, lower case, with no parameters. */
export const mediaType = (header) =>
  String(header ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

/**
 * Inline a layer as a data url.
 *
 * The bytes still come from the origin - this is the same read the browser
 * would do - but inlining keeps the canvas untainted, so the colour can be
 * sampled from the pixels the product paints.
 *
 * @param {string} src
 * @param {string} origin
 * @param {(url: string, init: RequestInit) => Promise<Response>} [fetchImpl]
 */
export const inlineLayer = async (src, origin, fetchImpl = fetch) => {
  const url = builtInLayerUrl(src, origin);
  if (!url) {
    throw new Error(
      `refused a pawn layer that is not a pawn file of ${origin}: ${String(src).slice(0, 120)}`,
    );
  }
  const res = await fetchImpl(url, { redirect: "error" });
  if (!res.ok) throw new Error(`could not read ${url}: HTTP ${res.status}`);
  const type = mediaType(res.headers.get("content-type"));
  if (!LAYER_TYPES.includes(type)) {
    throw new Error(
      `refused ${url}: its type is not ${LAYER_TYPES.join(" or ")}`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_LAYER_BYTES) {
    throw new Error(`refused ${url}: ${bytes.length} bytes`);
  }
  return `data:${type};base64,${bytes.toString("base64")}`;
};

/**
 * A page to compose pawns on, with no network at all: its layers come in as
 * data: URLs (inlineLayer), so any request it makes (a CSS url() in a
 * filter, say) is aborted (b2a19d62, Video Reviewer 1's N2).
 *
 * @param {import("playwright-core").Browser} browser
 * @param {Parameters<import("playwright-core").Browser["newPage"]>[0]} options
 */
export const newComposePage = async (browser, options) => {
  const page = await browser.newPage(options);
  await page.route("**/*", (route) => route.abort());
  return page;
};

/**
 * Compose a pawn's layer stack ({src, filter}, as the page drew it) into a
 * `size` px square PNG at `file`, on `page` (`size` px square). The seat
 * cards, a reactor's prey (REACTOR_ART) and the capture picture's pawns are
 * composed the same way.
 *
 * @param {import("playwright-core").Page} page
 * @param {{ src: string, filter: string }[]} layers
 * @param {string} file
 * @param {{ origin: string, size: number, fetchImpl?: (url: string, init: RequestInit) => Promise<Response> }} options
 */
export const composeLayers = async (
  page,
  layers,
  file,
  { origin, size, fetchImpl = fetch },
) => {
  const items = await Promise.all(
    layers.map(async (l) => ({
      data: await inlineLayer(l.src, origin, fetchImpl),
      filter: String(l.filter ?? "none"),
    })),
  );
  await page.setContent(
    `<html><body style="margin:0;width:${Number(size)}px;height:${Number(size)}px;background:transparent">
       <div id="stack" style="position:relative;width:100%;height:100%"></div>
     </body></html>`,
  );
  await page.evaluate(async (list) => {
    const stack = document.getElementById("stack");
    const imgs = list.map(({ data, filter }) => {
      const img = document.createElement("img");
      img.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
      img.style.filter = filter;
      img.src = data;
      stack.append(img);
      return img;
    });
    await Promise.all(imgs.map((img) => img.decode()));
  }, items);
  await page.screenshot({ path: file, omitBackground: true });
};
