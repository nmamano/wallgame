/**
 * Post one video to Threads. Threads does not take the bytes: it fetches the
 * video from a public HTTPS URL. Where that URL comes from is not decided
 * (Wall Game PM, 2026-10-26), so the caller gives a `publicUrl` function, and
 * this file never chooses a host.
 *
 * Read on developers.facebook.com 2026-10-26 (Threads API: Posts,
 * Troubleshooting, Overview, Long-Lived Access Tokens):
 *   POST https://graph.threads.com/v1.0/<user-id>/threads
 *        {media_type: VIDEO, video_url, text}     -> {id} (the container)
 *   GET  https://graph.threads.com/v1.0/<container-id>?fields=status,error_message
 *        FINISHED, IN_PROGRESS, ERROR, EXPIRED, PUBLISHED. "It is
 *        recommended to wait on average 30 seconds before publishing", and
 *        to query the status "once per minute, for no more than 5 minutes".
 *   POST https://graph.threads.com/v1.0/<user-id>/threads_publish
 *        {creation_id}                            -> {id} (the media id)
 *   GET  https://graph.threads.com/v1.0/<media-id>?fields=permalink
 *   GET  https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token
 *        -> {access_token, token_type, expires_in}
 * Text: 500 characters, an emoji counting its UTF-8 bytes (post-limits.mjs);
 * at most 5 links. 250 API posts in a moving 24 hours per profile.
 *
 * THE TOKEN EXPIRES. A long-lived token is "valid for 60 days" and "can be
 * refreshed as long as they are at least 24 hours old but have not expired";
 * a token that expires cannot be refreshed. So nobody refreshes it by hand:
 * threadsTokens keeps the newest token in the app's data dir, and
 * refreshThreadsToken renews it when it is a day old. The poster calls it
 * before each post, and the app also calls it once a day, so a week with no
 * post does not let the token lapse. THREADS_USER_ID and
 * THREADS_ACCESS_TOKEN (the first long-lived token) are Isomux secrets; a new
 * secret replaces the kept chain.
 *
 * The token goes only in the Authorization header. The pages' examples put
 * access_token in the query string and do not say that a Bearer header is
 * accepted; the Graph API accepts one, and the first live call proves it for
 * Threads. A query string would put the token in the plan and the logs.
 *
 * FIRST LIVE POST CHECKLIST (for Wall Game Growth, on the first real post):
 * - The token is sent as "Authorization: Bearer". The Threads pages show it
 *   only as an access_token query parameter. If the first request answers
 *   401 or "invalid token", this is the cause: report it to the code owner,
 *   and do not move the token into the URL.
 * - The token refresh: after the first post, the app's data dir has
 *   daily/tokens/threads.json with a refreshedAt. If it has only triedAt,
 *   the refresh failed: the post-log row does not show that, so look at the
 *   app log.
 * - The permalink in the post log opens the post.
 *
 * THE COMMIT IS threads_publish. A container that is never published expires
 * after 24 hours and nobody sees it. After a failed publish the container's
 * status decides, as in post-instagram.mjs.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  NotPosted,
  PostFailed,
  ok,
  settleAfterFailedCommit,
  sha256,
} from "./transport.mjs";
import { textLimitProblems } from "./post-limits.mjs";

export const THREADS_SECRETS = ["THREADS_USER_ID", "THREADS_ACCESS_TOKEN"];

export const THREADS_GRAPH = "https://graph.threads.com/v1.0";
export const THREADS_REFRESH_URL =
  "https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token";

const FIRST_WAIT_MS = 30_000;
const STATUS_POLL_MS = 60_000;
const STATUS_POLLS = 5;
/** After a failed publish: 3 reads, a minute apart (the docs' pace), so 2 min. */
const SETTLE_READS = 3;
/** The docs' floor for a refresh. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export const DRY_RUN_THREADS = {
  THREADS_USER_ID: "<THREADS_USER_ID>",
};

/**
 * The newest long-lived token, kept in `dir`/threads.json (mode 0600).
 * `seed` is the secret; the file records the hash of the seed it grew from,
 * so a new secret starts a new chain. `refreshedAt` is null for the seed.
 */
export const threadsTokens = (dir, seed) => {
  const path = join(dir, "threads.json");
  const seedSha256 = sha256(String(seed));
  const kept = () => {
    if (!existsSync(path)) return null;
    const k = JSON.parse(readFileSync(path, "utf8"));
    return k.seedSha256 === seedSha256 ? k : null;
  };
  const write = (record) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const part = `${path}.part`;
    writeFileSync(part, JSON.stringify({ seedSha256, ...record }), {
      mode: 0o600,
    });
    renameSync(part, path);
  };
  return {
    current: () => kept()?.token ?? seed,
    refreshedAt: () => kept()?.refreshedAt ?? null,
    triedAt: () => kept()?.triedAt ?? null,
    save: (token, at) => write({ token, refreshedAt: at, triedAt: at }),
    /** A failed refresh: keep the token, and do not try again for a day. */
    tried: (at) => {
      const k = kept();
      write({
        token: k?.token ?? seed,
        refreshedAt: k?.refreshedAt ?? null,
        triedAt: at,
      });
    },
  };
};

/**
 * Renew the token when it is a day old. A seed has no known age: it is tried
 * at once, and a refusal (too young) waits a day like any failure. Returns
 * {refreshed, error?}. It never throws: an old token that still works is
 * better than no post, and a token that no longer works fails the post with
 * the platform's own reason.
 */
export const refreshThreadsToken = async ({
  transport,
  tokens,
  now = () => new Date(),
}) => {
  const at = now();
  const last = tokens.triedAt();
  if (last && at.getTime() - Date.parse(last) < REFRESH_AFTER_MS) {
    return { refreshed: false };
  }
  const dry = transport.mode === "dry-run";
  try {
    const reply = await transport.request({
      method: "GET",
      url: THREADS_REFRESH_URL,
      headers: {
        authorization: `Bearer ${dry ? "<THREADS_ACCESS_TOKEN>" : tokens.current()}`,
      },
    });
    const token = reply.json?.access_token;
    if (!ok(reply) || typeof token !== "string" || !token) {
      throw new PostFailed("threads token refresh", reply);
    }
    if (!dry) tokens.save(token, at.toISOString());
    return { refreshed: true };
  } catch (err) {
    if (!dry) tokens.tried(at.toISOString());
    return { refreshed: false, error: String(err?.message ?? err) };
  }
};

export const threadsDryRunReply = (req) => {
  const path = req.url.split("?")[0];
  if (path === THREADS_REFRESH_URL.split("?")[0]) {
    return {
      status: 200,
      json: {
        access_token: "DRY-RUN-TOKEN",
        token_type: "bearer",
        expires_in: 5184000,
      },
    };
  }
  if (path.endsWith("/threads")) {
    return { status: 200, json: { id: "DRY-RUN-CONTAINER" } };
  }
  if (path.endsWith("/threads_publish")) {
    return { status: 200, json: { id: "DRY-RUN-MEDIA-ID" } };
  }
  if (req.url.includes("fields=status")) {
    return {
      status: 200,
      json: { status: "FINISHED", id: "DRY-RUN-CONTAINER" },
    };
  }
  if (req.url.includes("fields=permalink")) {
    return {
      status: 200,
      json: { permalink: "https://www.threads.com/@wallgame/post/DRY-RUN" },
    };
  }
  return { status: 404, json: null };
};

/**
 * Makes the video public at an https URL for Threads to fetch, and gives the
 * way to take it down again. Its hosting is not chosen (Nil, ask eb46a7d2).
 * @typedef {(v: { video: Buffer, sha256: string }) =>
 *   Promise<{ url: string, remove: () => Promise<void> }>} PublicUrl
 */

/** What a dry run gets in place of a public copy of the video. */
export const dryRunPublicUrl = async ({ sha256: hash }) => ({
  url: `https://<public host, not chosen>/${hash.slice(0, 16)}.mp4`,
  remove: async () => {},
});

/**
 * Post `video` (a Buffer) with `text`. `publicUrl({video, sha256})` makes
 * the video reachable at a public HTTPS URL and returns {url, remove}; the
 * poster calls remove once Threads no longer needs the file. `tokens` is a
 * threadsTokens store. `creds` holds THREADS_USER_ID (live) or
 * DRY_RUN_THREADS. `beforeCommit` runs just before threads_publish. Returns
 * {postId, url}.
 */
export const postToThreads = async ({
  video,
  text,
  publicUrl,
  tokens,
  transport,
  creds,
  sleep,
  beforeCommit,
  now = () => new Date(),
}) => {
  const problems = textLimitProblems("threads", text);
  if (problems.length) throw new NotPosted(problems.join("; "));

  await refreshThreadsToken({ transport, tokens, now });
  const dry = transport.mode === "dry-run";
  const token = dry ? "<THREADS_ACCESS_TOKEN>" : tokens.current();
  const user = creds.THREADS_USER_ID;
  const graph = (method, url, body) =>
    transport.request({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const containerStatus = async (containerId) => {
    const reply = await graph(
      "GET",
      `${THREADS_GRAPH}/${containerId}?fields=status,error_message`,
    );
    if (!ok(reply)) throw new PostFailed("threads status", reply);
    return reply.json ?? {};
  };

  const hosted = await publicUrl({ video, sha256: sha256(video) });
  try {
    if (!/^https:\/\//.test(hosted?.url ?? "")) {
      throw new NotPosted("threads: the video needs a public https URL");
    }
    const container = await graph("POST", `${THREADS_GRAPH}/${user}/threads`, {
      media_type: "VIDEO",
      video_url: hosted.url,
      text,
    });
    const containerId = container.json?.id;
    if (!ok(container) || !containerId) {
      throw new PostFailed("threads container", container);
    }

    // Threads fetches and processes the video before it can be published.
    let finished = false;
    for (let i = 0; i < STATUS_POLLS && !finished; i++) {
      // The waits give Threads time to fetch the video; a dry run sends
      // nothing to Threads, so it does not wait (its plan is the same).
      if (!dry) await sleep(i === 0 ? FIRST_WAIT_MS : STATUS_POLL_MS);
      const { status, error_message: why } = await containerStatus(containerId);
      if (status === "ERROR" || status === "EXPIRED") {
        throw new NotPosted(
          `threads processing ended in ${status} (${why ?? "no reason"})`,
        );
      }
      finished = status === "FINISHED";
    }
    if (!finished) {
      throw new NotPosted(
        "threads: the video was not processed after 4.5 minutes; nothing was published",
      );
    }

    await beforeCommit();

    const published = await graph(
      "POST",
      `${THREADS_GRAPH}/${user}/threads_publish`,
      {
        creation_id: containerId,
      },
    );
    const mediaId = published.json?.id;
    if (!ok(published) || !mediaId) {
      // An accepted publish can show FINISHED for a moment, so one read
      // cannot prove "not posted": read the container for SETTLE_READS polls.
      const failed = new PostFailed("threads publish", published);
      const { outcome, state } = await settleAfterFailedCommit({
        read: () => containerStatus(containerId),
        classify: ({ status }) =>
          status === "PUBLISHED"
            ? "posted"
            : status === "FINISHED"
              ? "not-posted"
              : "unknown",
        reads: SETTLE_READS,
        waitMs: STATUS_POLL_MS,
        sleep: dry ? async () => {} : sleep,
      });
      if (outcome === "posted") return { postId: null, url: null };
      if (outcome === "not-posted") {
        throw new NotPosted(
          `${failed.message}; the container stayed FINISHED, not published`,
        );
      }
      throw new Error(
        `${failed.message}; the container ${containerId} is ${state?.status ?? "unknown"}: look at the Threads profile before you post again`,
      );
    }

    let url = null;
    try {
      const link = await graph(
        "GET",
        `${THREADS_GRAPH}/${mediaId}?fields=permalink`,
      );
      if (ok(link) && typeof link.json?.permalink === "string") {
        url = link.json.permalink;
      }
    } catch {
      /* the post is made; only its link is unknown */
    }
    return { postId: mediaId, url };
  } finally {
    try {
      await hosted?.remove?.();
    } catch (err) {
      // The post's own result matters more; the copy is short-lived anyway.
      console.warn(
        `threads: the public copy was not removed: ${err?.message ?? err}`,
      );
    }
  }
};
