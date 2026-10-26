/**
 * Post one video to YouTube as a Short through the YouTube Data API v3
 * videos.insert, with a resumable upload.
 *
 * Read on developers.google.com 2026-10-26:
 *   POST https://oauth2.googleapis.com/token        refresh -> access token
 *   POST https://www.googleapis.com/upload/youtube/v3/videos
 *        ?uploadType=resumable&part=snippet,status  -> Location header
 *   PUT  <Location>                                 the bytes -> video resource
 * One insert costs 1 unit of the Video Uploads bucket, 100 calls a day.
 *
 * UNVERIFIED PROJECTS. The 2020 rule locked uploads from unverified API
 * projects to private until a Google audit. The videos.insert page read on
 * 2026-10-26 says the opposite: "Videos uploaded from unverified API projects
 * are not restricted to private viewing mode." Unchecked until the first real
 * upload, so the result keeps the privacy status YouTube returns and the post
 * log records it.
 *
 * A Short is a vertical video of three minutes or less; YouTube decides by the
 * file, and #Shorts in the title is a hint only.
 *
 * Auth: OAuth 2.0 with a refresh token for the channel, scope
 * https://www.googleapis.com/auth/youtube.upload. The app's environment holds
 * YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN as Isomux
 * secrets. A Google OAuth app left in "Testing" status expires its refresh
 * tokens after 7 days, so the consent screen must be "In production".
 */
import { PostFailed, ok, sha256 } from "./transport.mjs";

export const YOUTUBE_SECRETS = [
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
];
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_UPLOAD_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus";

/** YouTube's "Gaming" category. */
const GAMING = "20";

/** The token request body. The dry-run form names the secrets. */
export const tokenBody = (creds) =>
  new URLSearchParams({
    client_id: creds.YOUTUBE_CLIENT_ID,
    client_secret: creds.YOUTUBE_CLIENT_SECRET,
    refresh_token: creds.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }).toString();

export const DRY_RUN_CREDS = {
  YOUTUBE_CLIENT_ID: "<YOUTUBE_CLIENT_ID>",
  YOUTUBE_CLIENT_SECRET: "<YOUTUBE_CLIENT_SECRET>",
  YOUTUBE_REFRESH_TOKEN: "<YOUTUBE_REFRESH_TOKEN>",
};

export const youtubeDryRunReply = (req) => {
  if (req.url === GOOGLE_TOKEN_URL) {
    return {
      status: 200,
      json: { access_token: "DRY-RUN-ACCESS", expires_in: 3599 },
    };
  }
  if (req.method === "POST") {
    return {
      status: 200,
      headers: {
        location:
          "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=DRY-RUN",
      },
      json: null,
    };
  }
  return {
    status: 200,
    json: {
      id: "DRY-RUN-VIDEO-ID",
      status: { uploadStatus: "uploaded", privacyStatus: "public" },
    },
  };
};

/**
 * Upload `video` (a Buffer). `caption` has youtubeTitle and youtubeDescription.
 * `creds` is the live credentials, or DRY_RUN_CREDS for a dry run.
 * Returns {postId, url, privacyStatus, uploadStatus}.
 *
 * `beforeCommit` runs just before the PUT of the bytes, the request that makes
 * the video. A resumable session that is started and never filled makes
 * nothing.
 */
export const postToYoutube = async ({
  video,
  caption,
  transport,
  creds,
  beforeCommit,
}) => {
  const dry = transport.mode === "dry-run";
  const token = await transport.request({
    method: "POST",
    url: GOOGLE_TOKEN_URL,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody(creds),
    secretBody: !dry,
  });
  if (!ok(token) || !token.json?.access_token) {
    throw new PostFailed("youtube token", token);
  }
  const bearer = dry
    ? "Bearer <access token from the step above>"
    : `Bearer ${token.json.access_token}`;

  const metadata = {
    snippet: {
      title: caption.youtubeTitle,
      description: caption.youtubeDescription,
      tags: ["wall game", "board game", "strategy"],
      categoryId: GAMING,
    },
    status: {
      privacyStatus: "public",
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
    },
  };
  const start = await transport.request({
    method: "POST",
    url: YOUTUBE_UPLOAD_URL,
    headers: {
      authorization: bearer,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(video.length),
      "x-upload-content-type": "video/mp4",
    },
    body: JSON.stringify(metadata),
  });
  const location = start.headers?.location;
  if (!ok(start) || !location) throw new PostFailed("youtube start", start);

  await beforeCommit();

  const put = await transport.request({
    method: "PUT",
    url: location,
    headers: {
      authorization: bearer,
      "content-type": "video/mp4",
      "content-length": String(video.length),
    },
    body: video,
    describe: { bytes: video.length, sha256: sha256(video) },
  });
  const id = put.json?.id;
  if (!ok(put) || !id) throw new PostFailed("youtube upload", put);
  return {
    postId: id,
    url: `https://www.youtube.com/shorts/${id}`,
    privacyStatus: put.json.status?.privacyStatus ?? null,
    uploadStatus: put.json.status?.uploadStatus ?? null,
  };
};
