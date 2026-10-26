/**
 * Post one video to the Wall Game Facebook Page as a Reel, through the Graph
 * API, with the bytes uploaded from here. No public copy of the file is
 * needed.
 *
 * Read on developers.facebook.com 2026-10-26 (Video API, "Reels Publishing";
 * page reference video_reels):
 *   POST https://graph.facebook.com/v26.0/<page-id>/video_reels
 *        {upload_phase: start}                  -> {video_id, upload_url}
 *   POST https://rupload.facebook.com/video-upload/v26.0/<video-id>
 *        headers Authorization: OAuth <token>, offset: 0, file_size: N;
 *        body the bytes                         -> {success: true}
 *   POST https://graph.facebook.com/v26.0/<page-id>/video_reels
 *        {video_id, upload_phase: finish, video_state: PUBLISHED,
 *         description}                          -> {success: true}
 *   GET  https://graph.facebook.com/v26.0/<video-id>?fields=status
 *        status.video_status, and uploading_phase, processing_phase,
 *        publishing_phase, each with a status of not_started, in_progress,
 *        completed or error; publishing_phase.publish_status is draft,
 *        scheduled, published or error.
 * The page asks for a Page access token with pages_show_list,
 * pages_read_engagement and pages_manage_posts. Video: 3 to 90 seconds,
 * 9:16 (an error table also allows 16:9 to 9:16), H.264 or H.265, AAC.
 * 30 API-published Reels in a moving 24 hours per Page. The finish step
 * returns no post id: the Reel is the video, so the video id names it.
 *
 * The app's environment holds FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN
 * as Isomux secrets (the same Meta app and Page as Instagram, design A). The
 * page's examples put access_token in the query string; here the token goes
 * only in the Authorization header, as in post-instagram.mjs, so no URL and
 * no plan holds it.
 *
 * FIRST LIVE POST CHECKLIST (for Wall Game Growth, on the first real post):
 * - The URL in the post log is https://www.facebook.com/reel/<video id>,
 *   made from the video id because the finish step returns no post id.
 *   Open it: if it does not show the Reel, report the Page's real Reel URL
 *   to the code owner.
 * - The Reel shows on the Page as public, with the approved text.
 *
 * THE COMMIT IS THE FINISH STEP with video_state PUBLISHED. Before it, the
 * uploaded video is a draft that nobody sees. After it, Facebook processes
 * the video and then publishes it, so the poster waits for publish_status
 * published. After a failed finish, the video's status decides: see
 * postToFacebook.
 */
import { NotPosted, PostFailed, ok, sha256 } from "./transport.mjs";

export const FACEBOOK_SECRETS = [
  "FACEBOOK_PAGE_ID",
  "FACEBOOK_PAGE_ACCESS_TOKEN",
];

const VERSION = "v26.0";
export const FB_GRAPH = `https://graph.facebook.com/${VERSION}`;
export const FB_RUPLOAD = `https://rupload.facebook.com/video-upload/${VERSION}`;

/** The duration that the Reels page allows, in seconds. */
export const FACEBOOK_MIN_SECONDS = 3;
export const FACEBOOK_MAX_SECONDS = 90;

/** A short Reel is processed in well under a minute; this bounds a stuck one. */
const STATUS_POLL_MS = 15_000;
const STATUS_POLLS = 20;

export const DRY_RUN_FACEBOOK = {
  FACEBOOK_PAGE_ID: "<FACEBOOK_PAGE_ID>",
  FACEBOOK_PAGE_ACCESS_TOKEN: "<FACEBOOK_PAGE_ACCESS_TOKEN>",
};

const phase = (status) => ({
  video: status?.video_status,
  processing: status?.processing_phase?.status,
  publishing: status?.publishing_phase?.status,
  published: status?.publishing_phase?.publish_status === "published",
});

export const facebookDryRunReply = (req) => {
  const path = req.url.split("?")[0];
  const body = typeof req.body === "string" ? JSON.parse(req.body) : null;
  if (path.endsWith("/video_reels") && body?.upload_phase === "start") {
    return {
      status: 200,
      json: {
        video_id: "DRY-RUN-VIDEO-ID",
        upload_url: `${FB_RUPLOAD}/DRY-RUN-VIDEO-ID`,
      },
    };
  }
  if (path.startsWith(FB_RUPLOAD)) {
    return { status: 200, json: { success: true } };
  }
  if (path.endsWith("/video_reels") && body?.upload_phase === "finish") {
    return { status: 200, json: { success: true } };
  }
  if (req.url.includes("fields=status")) {
    return {
      status: 200,
      json: {
        status: {
          video_status: "ready",
          uploading_phase: { status: "completed" },
          processing_phase: { status: "completed" },
          publishing_phase: {
            status: "completed",
            publish_status: "published",
          },
        },
      },
    };
  }
  return { status: 404, json: null };
};

/**
 * Post `video` (a Buffer, `durationSeconds` long) as a Reel with
 * `description`. `creds` holds the two secrets (live) or DRY_RUN_FACEBOOK.
 * `beforeCommit` runs just before the finish step. Returns {postId, url}.
 */
export const postToFacebook = async ({
  video,
  durationSeconds,
  description,
  transport,
  creds,
  sleep,
  beforeCommit,
}) => {
  // Refused before any request: Facebook would take the upload and fail it.
  if (
    typeof durationSeconds !== "number" ||
    durationSeconds < FACEBOOK_MIN_SECONDS ||
    durationSeconds > FACEBOOK_MAX_SECONDS
  ) {
    throw new NotPosted(
      `facebook: a Reel is ${FACEBOOK_MIN_SECONDS} to ${FACEBOOK_MAX_SECONDS} s, and this video is ${durationSeconds ?? "of unknown length"} s`,
    );
  }
  const dry = transport.mode === "dry-run";
  const token = dry
    ? "<FACEBOOK_PAGE_ACCESS_TOKEN>"
    : creds.FACEBOOK_PAGE_ACCESS_TOKEN;
  const page = creds.FACEBOOK_PAGE_ID;
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
  const readStatus = async () => {
    const reply = await graph("GET", `${FB_GRAPH}/${videoId}?fields=status`);
    if (!ok(reply)) throw new PostFailed("facebook status", reply);
    return phase(reply.json?.status);
  };

  const start = await graph("POST", `${FB_GRAPH}/${page}/video_reels`, {
    upload_phase: "start",
  });
  const videoId = start.json?.video_id;
  if (!ok(start) || !videoId) throw new PostFailed("facebook start", start);

  const upload = await transport.request({
    method: "POST",
    url: `${FB_RUPLOAD}/${videoId}`,
    headers: {
      authorization: `OAuth ${token}`,
      offset: "0",
      file_size: String(video.length),
      "content-type": "application/octet-stream",
    },
    body: video,
    describe: { bytes: video.length, sha256: sha256(video) },
  });
  if (!ok(upload) || upload.json?.success !== true) {
    throw new PostFailed("facebook upload", upload);
  }

  await beforeCommit();

  const posted = {
    postId: videoId,
    url: `https://www.facebook.com/reel/${videoId}`,
  };
  const finish = await graph("POST", `${FB_GRAPH}/${page}/video_reels`, {
    video_id: videoId,
    upload_phase: "finish",
    video_state: "PUBLISHED",
    description,
  });
  if (!ok(finish) || finish.json?.success !== true) {
    // A Graph error is often HTTP 400 even when it is transient, so the
    // reply alone does not prove that no Reel went out. The video says:
    // published is a Reel; publishing not started is clearly not posted;
    // anything else leaves the post uncertain.
    const failed = new PostFailed("facebook finish", finish);
    let state;
    try {
      state = await readStatus();
    } catch {
      state = null;
    }
    if (state?.published) return posted;
    if (
      state?.publishing === "not_started" &&
      state.processing !== "in_progress"
    ) {
      throw new NotPosted(`${failed.message}; the video was not published`);
    }
    throw new Error(
      `${failed.message}; video ${videoId} is ${JSON.stringify(state)}: look at the Facebook Page before you post again`,
    );
  }

  // Facebook publishes after it processes the video. Wait for it, so a Reel
  // that failed processing is not logged as posted.
  for (let i = 0; i < STATUS_POLLS; i++) {
    let state;
    try {
      state = await readStatus();
    } catch {
      state = null;
    }
    if (state?.published) return posted;
    if (
      state?.video === "error" ||
      state?.processing === "error" ||
      state?.publishing === "error"
    ) {
      throw new NotPosted(
        `facebook: video ${videoId} ended in error before it was published (${JSON.stringify(state)})`,
      );
    }
    await sleep(STATUS_POLL_MS);
  }
  throw new Error(
    `facebook: video ${videoId} was not published ${(STATUS_POLLS * STATUS_POLL_MS) / 1000} s after the finish step: look at the Facebook Page before you post again`,
  );
};
