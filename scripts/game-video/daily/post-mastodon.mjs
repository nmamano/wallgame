/**
 * Not wired: Nil skipped Mastodon, ask 3ed3cdb1, 2026-10-26. The module and
 * its tests stay, so it can be wired again; no route, mode or ask uses it.
 *
 * Post one video to Mastodon: upload it as a media attachment, wait until the
 * server has processed it, then post a status that carries it.
 *
 * Read on docs.joinmastodon.org 2026-10-26 (methods/media, methods/statuses,
 * entities/Instance):
 *   POST <server>/api/v2/media       multipart: file    (scope write:media)
 *        200: processed; 202: accepted, url null while it is processed
 *   GET  <server>/api/v1/media/<id>
 *        200: processed, url set; 206: still processing; 422: it failed
 *   POST <server>/api/v1/statuses    {status, media_ids, visibility, language}
 *        (scope write:statuses) -> Status {id, url}
 *        Header Idempotency-Key: "to prevent duplicate submissions of the
 *        same status"; the server keeps a key "for up to 1 hour".
 * Text: 500 characters by default, a link counting 23 (post-limits.mjs).
 * Video: a server sets its own size limit (the docs' example is 99 MB).
 *
 * The server is not chosen yet, so its address is a secret next to the
 * token: MASTODON_BASE_URL (for example https://mastodon.social) and
 * MASTODON_ACCESS_TOKEN, both Isomux secrets in the app's environment. The
 * address is in every URL, so it is not a credential; the token is only in
 * the Authorization header. The bot flag is an account setting, not this
 * poster's job (Wall Game PM, 2026-10-26).
 *
 * FIRST LIVE POST CHECKLIST (for Wall Game Growth, on the first real post):
 * - The status shows the video and the text with the link, and the URL in
 *   the post log opens it.
 * - The account has the bot flag on (an account setting).
 *
 * THE COMMIT IS POST /api/v1/statuses. An attachment that no status uses is
 * not shown. The Idempotency-Key is the hash of the video and the text, so a
 * second attempt at the same post within the hour returns the first status
 * and does not make a second one.
 */
import { NotPosted, PostFailed, ok, sha256 } from "./transport.mjs";
import { textLimitProblems } from "./post-limits.mjs";

export const MASTODON_SECRETS = ["MASTODON_BASE_URL", "MASTODON_ACCESS_TOKEN"];

const MEDIA_POLL_MS = 5_000;
const MEDIA_POLLS = 60;

export const DRY_RUN_MASTODON = {
  MASTODON_BASE_URL: "https://mastodon.example",
  MASTODON_ACCESS_TOKEN: "<MASTODON_ACCESS_TOKEN>",
};

export const mastodonDryRunReply = (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/v2/media") {
    return {
      status: 202,
      json: { id: "DRY-RUN-MEDIA-ID", type: "video", url: null },
    };
  }
  if (path.startsWith("/api/v1/media/")) {
    return {
      status: 200,
      json: {
        id: "DRY-RUN-MEDIA-ID",
        type: "video",
        url: "https://mastodon.example/media/dry-run.mp4",
      },
    };
  }
  if (path === "/api/v1/statuses") {
    return {
      status: 200,
      json: {
        id: "DRY-RUN-STATUS-ID",
        url: "https://mastodon.example/@wallgame/DRY-RUN-STATUS-ID",
      },
    };
  }
  return { status: 404, json: null };
};

/** The server's origin, or an error that says what is wrong with the secret. */
const serverOrigin = (base) => {
  let url;
  try {
    url = new URL(String(base));
  } catch {
    throw new NotPosted("mastodon: MASTODON_BASE_URL is not a URL");
  }
  if (url.protocol !== "https:") {
    throw new NotPosted("mastodon: MASTODON_BASE_URL must be https");
  }
  return url.origin;
};

/**
 * Post `video` (a Buffer) with `text`. `creds` holds the two secrets (live)
 * or DRY_RUN_MASTODON. `beforeCommit` runs just before the status is posted.
 * Returns {postId, url}.
 */
export const postToMastodon = async ({
  video,
  text,
  transport,
  creds,
  sleep,
  beforeCommit,
}) => {
  const problems = textLimitProblems("mastodon", text);
  if (problems.length) throw new NotPosted(problems.join("; "));
  const server = serverOrigin(creds.MASTODON_BASE_URL);
  const dry = transport.mode === "dry-run";
  const auth = {
    authorization: `Bearer ${dry ? "<MASTODON_ACCESS_TOKEN>" : creds.MASTODON_ACCESS_TOKEN}`,
  };

  const form = new FormData();
  form.append("file", new Blob([video], { type: "video/mp4" }), "video.mp4");
  const media = await transport.request({
    method: "POST",
    url: `${server}/api/v2/media`,
    headers: auth,
    body: form,
    describe: {
      multipart: { file: { bytes: video.length, sha256: sha256(video) } },
    },
  });
  const mediaId = media.json?.id;
  if (!ok(media) || !mediaId) throw new PostFailed("mastodon media", media);

  // 200 is processed now; 202 is processed later: poll until the url is set.
  let ready = media.status === 200 && Boolean(media.json?.url);
  for (let polls = 0; !ready; polls++) {
    if (polls >= MEDIA_POLLS) {
      throw new NotPosted(
        `mastodon: the video was not processed after ${(MEDIA_POLLS * MEDIA_POLL_MS) / 1000} s; nothing was posted`,
      );
    }
    if (polls > 0) await sleep(MEDIA_POLL_MS);
    const check = await transport.request({
      method: "GET",
      url: `${server}/api/v1/media/${encodeURIComponent(mediaId)}`,
      headers: auth,
    });
    if (check.status === 422) {
      throw new NotPosted(
        `mastodon: the server could not process the video (${check.text ?? ""})`,
      );
    }
    if (check.status !== 200 && check.status !== 206) {
      throw new PostFailed("mastodon media status", check);
    }
    ready = check.status === 200 && Boolean(check.json?.url);
  }

  await beforeCommit();

  const status = await transport.request({
    method: "POST",
    url: `${server}/api/v1/statuses`,
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": sha256(`${sha256(video)}\n${text}`),
    },
    body: JSON.stringify({
      status: text,
      media_ids: [mediaId],
      visibility: "public",
      language: "en",
    }),
  });
  const postId = status.json?.id;
  if (!ok(status) || !postId) throw new PostFailed("mastodon status", status);
  return {
    postId,
    url: typeof status.json.url === "string" ? status.json.url : null,
  };
};
