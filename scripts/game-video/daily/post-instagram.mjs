/**
 * Post one video to Instagram as a Reel through the Instagram Graph API.
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
 * status decides (Reviewer 3, 2026-10-26): see postToInstagram.
 *
 * NEXT LIVE POST CHECKLIST (for Wall Game Growth):
 * - If the container status ends in ERROR, the cycle record has the reason
 *   in the error; report it to the code owner.
 * - The R2 bucket is empty after the post: the poster deletes its copy.
 */
import { NotPosted, PostFailed, ok, sha256 } from "./transport.mjs";
import { R2_HOST_SUFFIX, r2DryRunReply } from "./public-url-r2.mjs";
import { withoutSignedUrl } from "./post-threads.mjs";

const VERSION = "v26.0";
export const GRAPH = `https://graph.facebook.com/${VERSION}`;

const STATUS_POLL_MS = 60_000;
const STATUS_POLLS = 5;

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
 * Post `video` (a Buffer) as a Reel with `caption`. `publicUrl({video,
 * sha256, transport})` makes the video reachable at a public HTTPS URL and
 * returns {url, key, remove} (post-threads.mjs PublicUrl); the poster calls
 * remove once Instagram no longer needs the file. `creds` is {igUserId,
 * pageToken} from discoverMeta (in a dry run, from its canned replies).
 * `beforeCommit` runs just before media_publish. Returns {postId, url}.
 */
export const postToInstagram = async ({
  video,
  caption,
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

  const hosted = await publicUrl({ video, sha256: sha256(video), transport });
  const inPlaceOfUrl = `<signed URL of ${hosted.key}>`;
  try {
    if (!/^https:\/\//.test(hosted?.url ?? "")) {
      throw new NotPosted("instagram: the video needs a public https URL");
    }
    const container = await graph(
      "POST",
      `${GRAPH}/${user}/media`,
      { media_type: "REELS", video_url: hosted.url, caption },
      { media_type: "REELS", video_url: inPlaceOfUrl, caption },
    );
    const containerId = container.json?.id;
    if (!ok(container) || !containerId) {
      throw new PostFailed("instagram container", container);
    }

    // Instagram fetches and processes the video before it can be published.
    // Each read comes after a wait; a dry run sends nothing to Instagram, so
    // it does not wait (its plan is the same).
    let finished = false;
    for (let i = 0; i < STATUS_POLLS && !finished; i++) {
      if (!dry) await sleep(STATUS_POLL_MS);
      const status = await containerStatus(containerId);
      if (!ok(status)) throw new PostFailed("instagram status", status);
      const code = status.json?.status_code;
      if (code === "ERROR" || code === "EXPIRED") {
        throw new NotPosted(
          `instagram processing ended in ${code} (${status.json?.status ?? "no reason"})`,
        );
      }
      finished = code === "FINISHED";
    }
    if (!finished) {
      throw new NotPosted(
        `instagram: the video was not processed after ${(STATUS_POLLS * STATUS_POLL_MS) / 1000} s; nothing was published`,
      );
    }

    await beforeCommit();

    const published = await graph("POST", `${GRAPH}/${user}/media_publish`, {
      creation_id: containerId,
    });
    const mediaId = published.json?.id;
    if (!ok(published) || !mediaId) {
      // The Graph API answers most errors with HTTP 400, transient ones too,
      // so a 400 alone does not prove that no Reel went out. The container
      // says: PUBLISHED is a Reel whose media id is unknown, FINISHED is
      // clearly not published, and anything else leaves the post uncertain.
      const failed = new PostFailed("instagram publish", published);
      let code;
      try {
        const status = await containerStatus(containerId);
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
        `instagram: the public copy was not removed: ${err?.message ?? err}`,
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
