/**
 * Post one video to Instagram as a Reel through the Instagram Graph API, with
 * a resumable upload of the bytes. No public copy of the file is needed.
 *
 * Read on developers.facebook.com 2026-10-26 (Content Publishing, Facebook
 * Login for Business):
 *   POST https://graph.facebook.com/v26.0/<IG_ID>/media
 *        {media_type: REELS, upload_type: resumable, caption}  -> {id}
 *   POST https://rupload.facebook.com/ig-api-upload/v26.0/<container id>
 *        headers Authorization: OAuth <token>, offset: 0, file_size: N;
 *        body the bytes                            -> {success: true}
 *   GET  https://graph.facebook.com/v26.0/<container id>?fields=status_code
 *        IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED
 *   POST https://graph.facebook.com/v26.0/<IG_ID>/media_publish
 *        {creation_id}                             -> {id} (the media id)
 * The page gives the version only as <LATEST_API_VERSION>; v26.0 is the one
 * its Instagram Login examples name. It asks for one status check a minute,
 * for 5 minutes at most. 100 published posts in 24 hours per account.
 *
 * Auth (Wall Game PM, 2026-10-26, design A): a professional Instagram account
 * linked to a Facebook Page, and a system-user token of a Business app with
 * instagram_basic, instagram_content_publish and pages_read_engagement. A
 * system-user token does not expire, so nothing rotates here. Its one
 * secret, META_SYSTEM_USER_TOKEN, finds the Page, the Page token and the
 * linked IG_ID on each post (meta.mjs discoverMeta). The post goes out with
 * the Page token, as the Content Publishing guide says for Facebook Login.
 *
 * The token goes only in the Authorization header, never in a URL, so the
 * live transport keeps no copy of it.
 *
 * THE COMMIT IS media_publish. A container that is never published expires
 * after 24 hours and nobody sees it. After a 2xx from media_publish the post
 * exists: the permalink is asked for once, and a failure there leaves url
 * null, not a failed post. After a failed media_publish the container's
 * status decides (Reviewer 3, 2026-10-26): see postToInstagram.
 */
import { NotPosted, PostFailed, ok, sha256 } from "./transport.mjs";

const VERSION = "v26.0";
export const GRAPH = `https://graph.facebook.com/${VERSION}`;
export const RUPLOAD = `https://rupload.facebook.com/ig-api-upload/${VERSION}`;

const STATUS_POLL_MS = 60_000;
const STATUS_POLLS = 5;

export const instagramDryRunReply = (req) => {
  const path = req.url.split("?")[0];
  if (path.endsWith("/media")) {
    return { status: 200, json: { id: "DRY-RUN-CONTAINER" } };
  }
  if (path.startsWith(RUPLOAD)) {
    return {
      status: 200,
      json: { success: true, message: "Upload successful." },
    };
  }
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
 * Post `video` (a Buffer) as a Reel with `caption`. `creds` is {igUserId,
 * pageToken} from discoverMeta (in a dry run, from its canned replies).
 * `beforeCommit` runs just before media_publish. Returns {postId, url}.
 */
export const postToInstagram = async ({
  video,
  caption,
  transport,
  creds,
  sleep,
  beforeCommit,
}) => {
  const token = creds.pageToken;
  const user = creds.igUserId;
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

  const container = await graph("POST", `${GRAPH}/${user}/media`, {
    media_type: "REELS",
    upload_type: "resumable",
    caption,
  });
  const containerId = container.json?.id;
  if (!ok(container) || !containerId) {
    throw new PostFailed("instagram container", container);
  }

  const upload = await transport.request({
    method: "POST",
    url: `${RUPLOAD}/${containerId}`,
    headers: {
      authorization: `OAuth ${token}`,
      offset: "0",
      file_size: String(video.length),
    },
    body: video,
    describe: { bytes: video.length, sha256: sha256(video) },
  });
  if (!ok(upload) || upload.json?.success !== true) {
    throw new PostFailed("instagram upload", upload);
  }

  // Instagram must process the video before it can be published.
  let finished = false;
  for (let i = 0; i < STATUS_POLLS && !finished; i++) {
    if (i > 0) await sleep(STATUS_POLL_MS);
    const status = await graph(
      "GET",
      `${GRAPH}/${containerId}?fields=status_code`,
    );
    if (!ok(status)) throw new PostFailed("instagram status", status);
    const code = status.json?.status_code;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new NotPosted(`instagram processing ended in ${code}`);
    }
    finished = code === "FINISHED";
  }
  if (!finished) {
    throw new NotPosted(
      `instagram: the video was not processed after ${((STATUS_POLLS - 1) * STATUS_POLL_MS) / 1000} s; nothing was published`,
    );
  }

  await beforeCommit();

  const published = await graph("POST", `${GRAPH}/${user}/media_publish`, {
    creation_id: containerId,
  });
  const mediaId = published.json?.id;
  if (!ok(published) || !mediaId) {
    // The Graph API answers most errors with HTTP 400, transient ones too, so
    // a 400 alone does not prove that no Reel went out. The container says:
    // PUBLISHED is a Reel whose media id is unknown, FINISHED is clearly not
    // published, and anything else leaves the post uncertain.
    const failed = new PostFailed("instagram publish", published);
    let code;
    try {
      const status = await graph(
        "GET",
        `${GRAPH}/${containerId}?fields=status_code`,
      );
      code = ok(status) ? status.json?.status_code : undefined;
    } catch {
      code = undefined;
    }
    if (code === "PUBLISHED") return { postId: null, url: null };
    if (code === "FINISHED") throw failed;
    throw new Error(
      `${failed.message}; the container ${containerId} is ${code ?? "unknown"}: look at the Instagram profile before you post again`,
    );
  }

  let url = null;
  try {
    const link = await graph("GET", `${GRAPH}/${mediaId}?fields=permalink`);
    if (ok(link) && typeof link.json?.permalink === "string") {
      url = link.json.permalink;
    }
  } catch {
    /* the Reel is posted; only its link is unknown */
  }
  return { postId: mediaId, url };
};
