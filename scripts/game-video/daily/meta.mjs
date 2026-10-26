/**
 * Facebook and Instagram from ONE secret, META_SYSTEM_USER_TOKEN (Wall Game
 * PM, 2026-10-26): the token of a system user in the business's Meta
 * Business settings. The app finds the Page, its Page token and the linked
 * Instagram account on each post, so no Page id, Page token or Instagram id
 * is a secret, and the Page token is never stored: it lives in memory for
 * one post.
 *
 * Read on developers.facebook.com 2026-10-26 (Worker 1's research notes,
 * with quotes): "System users: make API calls" ("Once the system user has
 * pages_read_engagement permission, the system user access token can be
 * used to retrieve the page access token", GET /me/accounts, where me is the
 * system user; each Page comes with id, name, access_token, tasks); Graph
 * API Page reference ("If using a business system user in your request, the
 * business_management permission may be required"); Instagram Platform Page
 * reference (GET /{page-id}?fields=instagram_business_account -> {id}); IG
 * User reference (GET /{ig-user-id}?fields=username); Content Publishing
 * (Facebook Login: "Facebook Page access token" with instagram_basic,
 * instagram_content_publish, pages_read_engagement); Reels Publishing (a Page
 * token, with pages_show_list, pages_read_engagement, pages_manage_posts).
 * The IG media pages name a User token instead; the Content Publishing guide
 * names the Page token, so this app posts to both with the Page token.
 *
 * NO TOKEN IN AN ERROR: /me/accounts answers with every Page token, so a
 * refusal names the step, the HTTP status and Meta's error code only.
 */
import { NotPosted, ok } from "./transport.mjs";
import { FB_GRAPH } from "./post-facebook.mjs";

export const META_SECRETS = ["META_SYSTEM_USER_TOKEN"];

export const DRY_RUN_META = {
  META_SYSTEM_USER_TOKEN: "<META_SYSTEM_USER_TOKEN>",
};

/** What a dry run shows where the Page token goes. */
export const DRY_RUN_PAGE_TOKEN = "<Page token from /me/accounts>";

export const META_ACCOUNTS_URL = `${FB_GRAPH}/me/accounts?fields=id,name,access_token`;

/** Discovery found the Meta accounts in a state the app cannot post from. */
export class MetaRefused extends NotPosted {
  constructor(message) {
    super(message);
    this.name = "MetaRefused";
  }
}

const graphError = (step, reply) => {
  const e = reply.json?.error;
  const code = [e?.type, e?.code, e?.error_subcode]
    .filter((c) => typeof c === "string" || Number.isInteger(c))
    .filter((c) => /^[\w.-]{1,64}$/.test(String(c)))
    .join(" ");
  return new MetaRefused(
    `meta ${step} failed: HTTP ${reply.status}${code ? ` ${code}` : ""}`,
  );
};

/**
 * The Page the system user sees, its Page token, and (with `instagram`) the
 * Instagram account linked to it: "id" reads its id, "handle" also its
 * username. Refuses unless the system user sees exactly one Page, and,
 * with `instagram`, unless that Page has a linked Instagram account.
 * @param {{ transport: any, token: string, instagram?: false | "id" | "handle" }} o
 */
export const discoverMeta = async ({ transport, token, instagram = false }) => {
  const get = (url, bearer) =>
    transport.request({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${bearer}` },
    });

  const accounts = await get(META_ACCOUNTS_URL, token);
  if (!ok(accounts)) throw graphError("Page list (/me/accounts)", accounts);
  const pages = Array.isArray(accounts.json?.data) ? accounts.json.data : [];
  if (pages.length === 0) {
    throw new MetaRefused(
      "the Meta system user sees no Facebook Page: assign the Wall Game Page to it in Business settings (with pages_show_list and pages_read_engagement)",
    );
  }
  if (pages.length > 1) {
    const names = pages.map((p) => JSON.stringify(String(p.name ?? p.id)));
    throw new MetaRefused(
      `the Meta system user sees ${pages.length} Facebook Pages (${names.join(", ")}); it must see only the Wall Game Page`,
    );
  }
  const [page] = pages;
  const pageName = String(page.name ?? page.id);
  if (typeof page.id !== "string" || typeof page.access_token !== "string") {
    throw new MetaRefused(
      `Meta gave no Page token for ${JSON.stringify(pageName)}: the system user needs pages_read_engagement on it`,
    );
  }
  const found = {
    pageId: page.id,
    pageName,
    pageToken: page.access_token,
  };
  if (!instagram) return found;

  const linked = await get(
    `${FB_GRAPH}/${page.id}?fields=instagram_business_account`,
    token,
  );
  if (!ok(linked)) throw graphError("Instagram link read", linked);
  const igUserId = linked.json?.instagram_business_account?.id;
  if (typeof igUserId !== "string") {
    throw new MetaRefused(
      `the Facebook Page ${JSON.stringify(pageName)} has no linked Instagram professional account`,
    );
  }
  if (instagram === "id") return { ...found, igUserId };

  const ig = await get(`${FB_GRAPH}/${igUserId}?fields=username`, token);
  if (!ok(ig)) throw graphError("Instagram account read", ig);
  return {
    ...found,
    igUserId,
    igUsername: typeof ig.json?.username === "string" ? ig.json.username : null,
  };
};

/** The canned replies of discovery in a dry run; null for other requests. */
export const metaDryRunReply = (req) => {
  if (req.url === META_ACCOUNTS_URL) {
    return {
      status: 200,
      json: {
        data: [
          {
            id: "DRY-RUN-PAGE-ID",
            name: "Wall Game",
            access_token: DRY_RUN_PAGE_TOKEN,
          },
        ],
      },
    };
  }
  if (req.url.endsWith("?fields=instagram_business_account")) {
    return {
      status: 200,
      json: {
        instagram_business_account: { id: "DRY-RUN-IG-USER-ID" },
        id: "DRY-RUN-PAGE-ID",
      },
    };
  }
  if (req.url.endsWith("?fields=username")) {
    return { status: 200, json: { username: "wallgameio" } };
  }
  return null;
};
