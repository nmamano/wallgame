/**
 * Post one video to Instagram as a Reel or as a Story through the Instagram
 * Graph API.
 * Instagram fetches the video from a public HTTPS URL: the caller gives a
 * `publicUrl` function that makes one (public-url-r2.mjs, as for Threads).
 *
 * WHY NOT THE RESUMABLE UPLOAD (Wall Game PM, 2026-10-28). The first live
 * post (2026-10-28 03:38 UTC) sent the bytes to
 * rupload.facebook.com/ig-api-upload with the Page token, and the upload
 * answered HTTP 400 ProcessingFailedError "Request processing failed",
 * while Facebook Reels took the same file and token on its own rupload
 * path. The Content Publishing page (read 2026-10-28) says the resumable
 * upload is "Only for apps that have implemented Facebook Login for
 * Business"; our app posts with a Business Integration System User token,
 * which its table lists as another login type. The video_url path has no
 * such limit.
 *
 * Read on developers.facebook.com 2026-10-28 (Instagram Platform, Content
 * Publishing):
 *   POST https://graph.facebook.com/v26.0/<IG_ID>/media
 *        {media_type: REELS, video_url, caption}  -> {id} (the container)
 *        "the media must be hosted on a publicly accessible server at the
 *        time of the attempt"
 *   GET  https://graph.facebook.com/v26.0/<container id>?fields=status_code
 *        IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED
 *   POST https://graph.facebook.com/v26.0/<IG_ID>/media_publish
 *        {creation_id}                             -> {id} (the media id)
 * It asks for one status check a minute, for 5 minutes at most. 100
 * published posts in 24 hours per account. The R2 copy stays until the
 * attempt ends (also after a failure), and its GET URL works for 15 minutes,
 * longer than the status checks.
 *
 * THAT URL IS A BEARER LINK: whoever has it can fetch the video until it
 * expires. It goes only to Instagram. The plan, the cycle record and every
 * error message name the stored object by its `key` instead.
 *
 * Auth (Wall Game PM, 2026-10-26, design A): a professional Instagram account
 * linked to a Facebook Page, and a system-user token of a Business app with
 * instagram_basic, instagram_content_publish and pages_read_engagement. A
 * system-user token does not expire, so nothing rotates here. Its one
 * secret, META_SYSTEM_USER_TOKEN, finds the Page, the Page token and the
 * linked IG_ID on each post (meta.mjs discoverMeta). The post goes out with
 * the Page token: the page's token table names a "Facebook Page access
 * token" for the Instagram API with Facebook Login, and the first live post
 * created its container with it.
 *
 * The token goes only in the Authorization header, never in a URL, so the
 * live transport keeps no copy of it.
 *
 * THE COMMIT IS media_publish. A container that is never published expires
 * after 24 hours and nobody sees it. After a 2xx from media_publish the post
 * exists: the permalink is asked for once, and a failure there leaves url
 * null, not a failed post. After a failed media_publish the container's
 * status decides, read SETTLE_READS times (Reviewer 3, 2026-10-26; Reviewer
 * 1, 2026-10-28): see postToInstagram.
 *
 * STORIES (Nil, 2026-10-29, via Wall Game Growth: every Instagram post also
 * goes to Stories). The same steps with media_type STORIES and no caption.
 * Read on developers.facebook.com 2026-10-29 (Content Publishing; IG User
 * Media reference; IG Media reference; the pages carry no update date):
 *   - a Story container is {media_type: STORIES, video_url}; the Story
 *     examples send no caption and the page names none for a Story;
 *   - the same permissions as a Reel (instagram_basic,
 *     instagram_content_publish, pages_read_engagement), the same status
 *     codes and polls, and the same 100 posts in 24 hours;
 *   - "Story Video Specifications": duration 3 seconds minimum, 60 seconds
 *     maximum; file size 100MB maximum (a Reel: 15 minutes, 300MB);
 *     aspect ratio 0.1:1 to 10:1, 9:16 recommended;
 *   - permalink: no exception for Stories.
 * A video outside the Story limits is refused before any request.
 * routes.mjs posts the Story as its own platform, "instagram-story", with
 * its own R2 copy, after the Reel.
 *
 * NEXT LIVE POST CHECKLIST (for Wall Game Growth):
 * - If the container status ends in ERROR, the cycle record has the reason
 *   in the error; report it to the code owner.
 * - The R2 bucket is empty after the post: the poster deletes its copy.
 */
import {
  NotPosted,
  PostFailed,
  ok,
  settleAfterFailedCommit,
  sha256,
} from "./transport.mjs";
import { R2_HOST_SUFFIX, r2DryRunReply } from "./public-url-r2.mjs";
import { withoutSignedUrl } from "./post-threads.mjs";

const VERSION = "v26.0";
export const GRAPH = `https://graph.facebook.com/${VERSION}`;

const STATUS_POLL_MS = 60_000;
const STATUS_POLLS = 5;
/** Reads of the container after a failed media_publish, 60 s apart. */
const SETTLE_READS = 3;

/** Story Video Specifications (IG User Media reference, read 2026-10-29). */
export const STORY_MIN_SECONDS = 3;
export const STORY_MAX_SECONDS = 60;
// "100MB": read as 100e6 bytes, the smaller of the two readings.
export const STORY_MAX_BYTES = 100e6;

const MEDIA_TYPE = { reel: "REELS", story: "STORIES" };

/**
 * Why `video` cannot be a Story, or null.
 * @param {{ video: Buffer, durationSeconds: number }} o
 */
export const storyProblem = ({ video, durationSeconds }) => {
  if (!Number.isFinite(durationSeconds)) {
    return "instagram story: the video has no known duration";
  }
  if (
    durationSeconds < STORY_MIN_SECONDS ||
    durationSeconds > STORY_MAX_SECONDS
  ) {
    return `instagram story: the video is ${durationSeconds} s; a Story takes ${STORY_MIN_SECONDS}-${STORY_MAX_SECONDS} s`;
  }
  if (video.length > STORY_MAX_BYTES) {
    return `instagram story: the video is ${video.length} bytes; a Story takes ${STORY_MAX_BYTES} at most`;
  }
  return null;
};

export const instagramDryRunReply = (req) => {
  const path = req.url.split("?")[0];
  if (path.endsWith("/media")) {
    return { status: 200, json: { id: "DRY-RUN-CONTAINER" } };
  }
  if (new URL(req.url).host.endsWith(R2_HOST_SUFFIX)) return r2DryRunReply(req);
  if (path.endsWith("/media_publish")) {
    return { status: 200, json: { id: "DRY-RUN-MEDIA-ID" } };
  }
  if (req.url.includes("fields=status_code")) {
    return { status: 200, json: { status_code: "FINISHED" } };
  }
  if (req.url.includes("fields=permalink")) {
    return {
      status: 200,
      json: { permalink: "https://www.instagram.com/reel/DRY-RUN/" },
    };
  }
  return { status: 404, json: null };
};

/**
 * Post `video` (a Buffer) as a Reel with `caption`, or with surface "story"
 * as a Story (no caption; `durationSeconds` is checked against the Story
 * limits before any request). `publicUrl({video,
 * sha256, transport})` makes the video reachable at a public HTTPS URL and
 * returns {url, key, remove} (post-threads.mjs PublicUrl); the poster calls
 * remove once Instagram no longer needs the file. `creds` is {igUserId,
 * pageToken} from discoverMeta (in a dry run, from its canned replies).
 * `beforeCommit` runs just before media_publish. Returns {postId, url}.
 *
 * @param {{ video: Buffer, surface?: "reel" | "story", caption?: string,
 *   durationSeconds?: number, publicUrl: any, transport: any,
 *   creds: { igUserId: string, pageToken: string }, sleep: any,
 *   beforeCommit: any }} o
 */
export const postToInstagram = async ({
  video,
  surface = "reel",
  caption,
  durationSeconds,
  publicUrl,
  transport,
  creds,
  sleep,
  beforeCommit,
}) => {
  const dry = transport.mode === "dry-run";
  const token = creds.pageToken;
  const user = creds.igUserId;
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
  const containerStatus = (containerId) =>
    graph("GET", `${GRAPH}/${containerId}?fields=status_code,status`);

  const mediaType = MEDIA_TYPE[surface];
  if (!mediaType) throw new NotPosted(`instagram: no surface ${surface}`);
  const story = surface === "story";
  if (story) {
    const problem = storyProblem({ video, durationSeconds });
    if (problem) throw new NotPosted(problem);
  }
  // A Story is its own platform in the post log ("instagram-story").
  const name = story ? "instagram story" : "instagram";

  const hosted = await publicUrl({ video, sha256: sha256(video), transport });
  const inPlaceOfUrl = `<signed URL of ${hosted.key}>`;
  try {
    if (!/^https:\/\//.test(hosted?.url ?? "")) {
      throw new NotPosted(`${name}: the video needs a public https URL`);
    }
    const fields = story ? {} : { caption };
    const container = await graph(
      "POST",
      `${GRAPH}/${user}/media`,
      { media_type: mediaType, video_url: hosted.url, ...fields },
      { media_type: mediaType, video_url: inPlaceOfUrl, ...fields },
    );
    const containerId = container.json?.id;
    if (!ok(container) || !containerId) {
      throw new PostFailed(`${name} container`, container);
    }

    // Instagram fetches and processes the video before it can be published.
    // Each read comes after a wait; a dry run sends nothing to Instagram, so
    // it does not wait (its plan is the same).
    let finished = false;
    for (let i = 0; i < STATUS_POLLS && !finished; i++) {
      if (!dry) await sleep(STATUS_POLL_MS);
      const status = await containerStatus(containerId);
      if (!ok(status)) throw new PostFailed(`${name} status`, status);
      const code = status.json?.status_code;
      if (code === "ERROR" || code === "EXPIRED") {
        throw new NotPosted(
          `${name} processing ended in ${code} (${status.json?.status ?? "no reason"})`,
        );
      }
      finished = code === "FINISHED";
    }
    if (!finished) {
      throw new NotPosted(
        `${name}: the video was not processed after ${(STATUS_POLLS * STATUS_POLL_MS) / 1000} s; nothing was published`,
      );
    }

    await beforeCommit();

    const published = await graph("POST", `${GRAPH}/${user}/media_publish`, {
      creation_id: containerId,
    });
    const mediaId = published.json?.id;
    if (!ok(published) || !mediaId) {
      // The Graph API answers most errors with HTTP 400, transient ones too,
      // and an accepted publish can show FINISHED for a moment, so one read
      // cannot prove "not posted": read the container for SETTLE_READS polls
      // (Reviewer 1, 2026-10-28, as for Facebook and Threads).
      const failed = new PostFailed(`${name} publish`, published);
      const { outcome, state } = await settleAfterFailedCommit({
        read: async () => {
          const status = await containerStatus(containerId);
          if (!ok(status)) throw new PostFailed(`${name} status`, status);
          return status.json ?? {};
        },
        classify: ({ status_code: code }) =>
          code === "PUBLISHED"
            ? "posted"
            : code === "FINISHED"
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
        `${failed.message}; the container ${containerId} is ${state?.status_code ?? "unknown"}: look at the Instagram profile before you post again`,
      );
    }

    let url = null;
    try {
      const link = await graph("GET", `${GRAPH}/${mediaId}?fields=permalink`);
      if (ok(link) && typeof link.json?.permalink === "string") {
        url = link.json.permalink;
      }
    } catch {
      /* the Reel or Story is posted; only its link is unknown */
    }
    return { postId: mediaId, url };
  } catch (err) {
    // Instagram may quote the URL in an error; the message goes into the
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
        `${name}: the public copy was not removed: ${err?.message ?? err}`,
      );
    }
  }
};

/**
 * READ-ONLY: the Instagram account that a post would go to, read with the
 * token a post uses (the Page token). It posts nothing. `creds` is
 * {igUserId, pageToken} from discoverMeta.
 */
export const instagramAuthCheck = async ({ transport, creds }) => {
  const reply = await transport.request({
    method: "GET",
    url: `${GRAPH}/${creds.igUserId}?fields=username`,
    headers: { authorization: `Bearer ${creds.pageToken}` },
  });
  return ok(reply)
    ? { status: reply.status, ok: true, username: reply.json?.username ?? null }
    : {
        status: reply.status,
        ok: false,
        // Codes only, as meta.mjs reports a Graph error.
        error: [
          reply.json?.error?.type,
          reply.json?.error?.code,
          reply.json?.error?.error_subcode,
        ]
          .filter((c) => /^[\w.-]{1,64}$/.test(String(c ?? "")))
          .join(" "),
      };
};
