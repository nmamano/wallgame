/**
 * Post one video to Threads. Threads does not take the bytes: it fetches the
 * video from a public HTTPS URL. The caller gives a `publicUrl` function that
 * makes one (public-url-r2.mjs: Cloudflare R2, Nil, ask eb46a7d2), so this
 * file chooses no host.
 *
 * THAT URL IS A BEARER LINK: whoever has it can fetch the video until it
 * expires. It goes only to Threads. The plan, the cycle record and every
 * error message name the stored object by its `key` instead.
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
 * the token store keeps the newest token (threadsTokens), and
 * refreshThreadsToken renews it when it is a day old. The poster calls it
 * before each post, and the app also calls it once a day, so a week with no
 * post does not let the token lapse. The first long-lived token and the user
 * id come from /daily/connect (connect.mjs); the app's environment holds
 * only THREADS_APP_ID and THREADS_APP_SECRET.
 *
 * The token goes only in the Authorization header. The pages' examples put
 * access_token in the query string and do not say that a Bearer header is
 * accepted; the Graph API accepts one, and the first live call proves it for
 * Threads. A query string would put the token in the plan and the logs.
 *
 * FIRST LIVE POST CHECKLIST (for Wall Game Growth, on the first real post):
 * - The token is sent as "Authorization: Bearer". The Threads pages show it
 *   only as an access_token query parameter. Connect already reads /me this
 *   way, so a refusal shows there first. If a request answers 401 or
 *   "invalid token", this is the cause: report it to the code owner, and do
 *   not move the token into the URL.
 * - The token refresh: one day after Connect, /daily/connect shows a newer
 *   "refreshed" time for Threads. If it does not, the refresh failed: the
 *   post-log row does not show that, so look at the app log.
 * - The permalink in the post log opens the post.
 * - The R2 bucket wallgame-threads-video is empty after the post: the poster
 *   deletes its copy. An object that stays means the DELETE failed (see the
 *   app log). Before the first live post, the bucket must have the 1-day
 *   lifecycle rule (Nil's backstop for such copies): check that it exists.
 *
 * THE COMMIT IS threads_publish. A container that is never published expires
 * after 24 hours and nobody sees it. After a failed publish the container's
 * status decides, as in post-instagram.mjs.
 */
import {
  NotPosted,
  PostFailed,
  ok,
  settleAfterFailedCommit,
  sha256,
} from "./transport.mjs";
import { textLimitProblems } from "./post-limits.mjs";
import { R2_HOST_SUFFIX, r2DryRunReply } from "./public-url-r2.mjs";

export const THREADS_SECRETS = ["THREADS_APP_ID", "THREADS_APP_SECRET"];

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

const DRY_RUN_TOKEN = "<Threads token from /daily/connect>";

export const DRY_RUN_THREADS = {
  userId: "<Threads user id from /daily/connect>",
};

/**
 * The Threads connection in the token store (token-store.mjs), as the
 * refresh needs it. /daily/connect writes it; `save` and `tried` change it.
 */
export const threadsTokens = (store) => {
  const record = () => store.read("threads");
  return {
    current: () => record()?.accessToken ?? null,
    refreshedAt: () => record()?.refreshedAt ?? null,
    triedAt: () => record()?.triedAt ?? null,
    save: (token, at, expiresInSeconds) =>
      store.update("threads", {
        accessToken: token,
        refreshedAt: at,
        triedAt: at,
        accessExpiresAt: Number.isFinite(expiresInSeconds)
          ? new Date(Date.parse(at) + expiresInSeconds * 1000).toISOString()
          : null,
      }),
    /** A failed refresh: keep the token, and do not try again for a day. */
    tried: (at) => store.update("threads", { triedAt: at }),
  };
};

/**
 * Renew the token when it is a day old (Connect counts as the first renewal).
 * A refusal waits a day like any failure. Returns
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
        authorization: `Bearer ${dry ? DRY_RUN_TOKEN : tokens.current()}`,
      },
    });
    const token = reply.json?.access_token;
    if (!ok(reply) || typeof token !== "string" || !token) {
      throw new PostFailed("threads token refresh", reply);
    }
    if (!dry) tokens.save(token, at.toISOString(), reply.json?.expires_in);
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
  if (new URL(req.url).host.endsWith(R2_HOST_SUFFIX)) return r2DryRunReply(req);
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
 * way to take it down again. Its requests go through `transport`, so they
 * are in the plan. `key` names the stored copy where the URL must not be.
 * @typedef {(v: { video: Buffer, sha256: string, transport: any }) =>
 *   Promise<{ url: string, key: string, remove: () => Promise<void> }>}
 *   PublicUrl
 */

/**
 * `text` with `url`, and any S3-style signature, replaced: also in a
 * percent-encoded copy of the URL ("X-Amz-Signature%3D...").
 */
export const withoutSignedUrl = (text, url, replacement) =>
  text
    .split(url)
    .join(replacement)
    .replace(/(X-Amz-Signature(?:=|%3D))[0-9a-f]+/gi, "$1<removed>");

/**
 * Post `video` (a Buffer) with `text`. `publicUrl({video, sha256,
 * transport})` makes the video reachable at a public HTTPS URL and returns
 * {url, key, remove}; the poster calls remove once Threads no longer needs
 * the file. `tokens` is a
 * threadsTokens store. `creds` holds the stored `userId` (live) or
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
  const token = dry ? DRY_RUN_TOKEN : tokens.current();
  const user = creds.userId;
  const graph = (method, url, body, describe) =>
    transport.request({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      describe,
    });
  const containerStatus = async (containerId) => {
    const reply = await graph(
      "GET",
      `${THREADS_GRAPH}/${containerId}?fields=status,error_message`,
    );
    if (!ok(reply)) throw new PostFailed("threads status", reply);
    return reply.json ?? {};
  };

  const hosted = await publicUrl({ video, sha256: sha256(video), transport });
  const inPlaceOfUrl = `<signed URL of ${hosted.key}>`;
  try {
    if (!/^https:\/\//.test(hosted?.url ?? "")) {
      throw new NotPosted("threads: the video needs a public https URL");
    }
    const container = await graph(
      "POST",
      `${THREADS_GRAPH}/${user}/threads`,
      { media_type: "VIDEO", video_url: hosted.url, text },
      { media_type: "VIDEO", video_url: inPlaceOfUrl, text },
    );
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
  } catch (err) {
    // Threads may quote the URL in an error; the message goes into the
    // cycle record, so the URL and any signature in it are taken out.
    if (err instanceof Error) {
      err.message = withoutSignedUrl(err.message, hosted.url, inPlaceOfUrl);
    }
    throw err;
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
