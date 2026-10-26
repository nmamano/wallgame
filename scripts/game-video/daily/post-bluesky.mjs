/**
 * Post one video to Bluesky through the AT Protocol, with the video sent to
 * Bluesky's video service first, so the post never shows a video that is
 * still processing.
 *
 * Read 2026-10-26 on docs.bsky.app ("Uploading Video", recommended method)
 * and in the lexicons of bluesky-social/atproto (packages/api/lexicons):
 *   POST https://bsky.social/xrpc/com.atproto.server.createSession
 *        {identifier, password}           -> {accessJwt, did, didDoc}
 *        The account's PDS is the #atproto_pds service of didDoc.
 *   GET  <pds>/xrpc/com.atproto.server.getServiceAuth
 *        ?aud=did:web:<pds host>&lxm=com.atproto.repo.uploadBlob&exp=<+30 min>
 *                                         -> {token}
 *   POST https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=..&name=..
 *        Authorization: Bearer <service token>, body the mp4
 *                                         -> {jobStatus} (the tutorial reads
 *                                            the job status at the top level)
 *   GET  https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=..
 *        state JOB_STATE_COMPLETED or JOB_STATE_FAILED (others are in
 *        progress), and the blob once it is stored on the PDS
 *   POST <pds>/xrpc/com.atproto.repo.createRecord
 *        {repo: did, collection: app.bsky.feed.post, record}
 *                                         -> {uri, cid}
 * The record is {text, createdAt, langs, facets, embed: app.bsky.embed.video
 * {video: blob, aspectRatio}}. Text: 300 graphemes (post-limits.mjs). Video:
 * mp4 up to 300 MB. A Bluesky-hosted account needs a verified email to post
 * video, and the video service has a daily limit per account.
 *
 * LINKS. Bluesky shows a URL in the text as a link only through a facet
 * (app.bsky.richtext.facet, #link) whose byteStart and byteEnd count UTF-8
 * bytes of the text. The poster adds one for each http(s) URL. The facet is
 * the only thing the poster adds: the text stays exactly as approved.
 *
 * SECRETS. BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an app password, not the
 * account password) are Isomux secrets in the app's environment. The app
 * password is only in the createSession body, which is marked secretBody so
 * the live transport keeps no copy; the session and service tokens are only
 * in Authorization headers. No bot label (Wall Game PM, 2026-10-26).
 *
 * FIRST LIVE POST CHECKLIST (for Wall Game Growth, on the first real post):
 * - The link in the text is clickable and opens the tracked URL.
 * - The video plays in the post (not "processing").
 *
 * THE COMMIT IS createRecord. Everything before it leaves nothing public: an
 * uploaded video that no post names is not shown.
 */
import { NotPosted, PostFailed, ok, sha256 } from "./transport.mjs";
import { blueskyLength, findUrls, textLimitProblems } from "./post-limits.mjs";

export const BLUESKY_SECRETS = ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"];

export const BSKY_ENTRYWAY = "https://bsky.social";
export const BSKY_VIDEO = "https://video.bsky.app";

/** The tutorial polls once a second; a short video is done in under a minute. */
const JOB_POLL_MS = 2_000;
const JOB_POLLS = 150;

export const DRY_RUN_BLUESKY = {
  BLUESKY_HANDLE: "<BLUESKY_HANDLE>",
  BLUESKY_APP_PASSWORD: "<BLUESKY_APP_PASSWORD>",
};

const DRY_PDS = "https://dry-run-pds.example";
const DRY_DID = "did:plc:dryrun";
const DRY_BLOB = {
  $type: "blob",
  ref: { $link: "bafkreidryrun" },
  mimeType: "video/mp4",
  size: 1,
};

export const blueskyDryRunReply = (req) => {
  const path = req.url.split("?")[0];
  if (path.endsWith("/com.atproto.server.createSession")) {
    return {
      status: 200,
      json: {
        accessJwt: "DRY-RUN-ACCESS",
        refreshJwt: "DRY-RUN-REFRESH",
        handle: "dry-run.bsky.social",
        did: DRY_DID,
        didDoc: {
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: DRY_PDS,
            },
          ],
        },
      },
    };
  }
  if (path.endsWith("/com.atproto.server.getServiceAuth")) {
    return { status: 200, json: { token: "DRY-RUN-SERVICE-TOKEN" } };
  }
  if (path.endsWith("/app.bsky.video.uploadVideo")) {
    return {
      status: 200,
      json: {
        jobStatus: {
          jobId: "DRY-RUN-JOB",
          did: DRY_DID,
          state: "JOB_STATE_CREATED",
        },
      },
    };
  }
  if (path.endsWith("/app.bsky.video.getJobStatus")) {
    return {
      status: 200,
      json: {
        jobStatus: {
          jobId: "DRY-RUN-JOB",
          did: DRY_DID,
          state: "JOB_STATE_COMPLETED",
          blob: DRY_BLOB,
        },
      },
    };
  }
  if (path.endsWith("/com.atproto.repo.createRecord")) {
    return {
      status: 200,
      json: {
        uri: `at://${DRY_DID}/app.bsky.feed.post/3dryrunpost`,
        cid: "bafyreidryrun",
      },
    };
  }
  return { status: 404, json: null };
};

const BSKY_TAG =
  // eslint-disable-next-line no-misleading-character-class
  /(^|\s)[#＃]((?!\ufe0f)[^\s\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]*[^\d\s\p{P}\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]+[^\s\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]*)?/gu;

/**
 * One #link facet for each URL in `text` and one #tag facet for each
 * hashtag, in text order, with byte positions in its UTF-8
 * form. An emoji before a URL is 4 bytes but 2 UTF-16 units, so the UTF-16
 * positions of JavaScript strings would put the link in the wrong place.
 * @param {string} text
 * @returns {{ index: { byteStart: number, byteEnd: number },
 *   features: { $type: string, uri?: string, tag?: string }[] }[]}
 */
export const richTextFacets = (text) => {
  const bytes = (s) => new TextEncoder().encode(s).length;
  const facet = (start, end, feature) => ({
    index: {
      byteStart: bytes(text.slice(0, start)),
      byteEnd: bytes(text.slice(0, end)),
    },
    features: [feature],
  });
  // A #tag is plain text on Bluesky unless a facet makes it a tag. This is
  // the rule of Bluesky's own client (bluesky-social/atproto,
  // packages/api/src/rich-text: TAG_REGEX in util.ts and detectFacets in
  // detection.ts, read 2026-10-26): trailing punctuation is not part of the
  // tag, and a tag over 64 graphemes is no tag.
  const tags = [...text.matchAll(BSKY_TAG)].flatMap((m) => {
    const tag = (m[2] ?? "").trim().replace(/\p{P}+$/gu, "");
    if (!tag || blueskyLength(tag) > 64) return [];
    const start = m.index + m[1].length;
    return [
      facet(start, start + 1 + tag.length, {
        $type: "app.bsky.richtext.facet#tag",
        tag,
      }),
    ];
  });
  const links = findUrls(text).map(({ url, start, end }) =>
    facet(start, end, { $type: "app.bsky.richtext.facet#link", uri: url }),
  );
  return [...links, ...tags].sort(
    (a, b) => a.index.byteStart - b.index.byteStart,
  );
};

/**
 * {width, height} of the first video track of an MP4, from its track header
 * (ISO/IEC 14496-12: moov > trak > tkhd, width and height as 16.16 fixed
 * point after the matrix), or null. Bluesky sizes the player from the
 * embed's aspectRatio, and the app has no ffprobe.
 * @param {Buffer} mp4
 * @returns {{ width: number, height: number } | null}
 */
export const mp4VideoSize = (mp4) => {
  const boxes = function* (from, to) {
    for (let at = from; at + 8 <= to; ) {
      let size = mp4.readUInt32BE(at);
      let head = 8;
      if (size === 1) {
        size = Number(mp4.readBigUInt64BE(at + 8));
        head = 16;
      } else if (size === 0) {
        size = to - at;
      }
      if (size < head || at + size > to) return;
      yield {
        type: mp4.toString("latin1", at + 4, at + 8),
        start: at + head,
        end: at + size,
      };
      at += size;
    }
  };
  for (const moov of boxes(0, mp4.length)) {
    if (moov.type !== "moov") continue;
    for (const trak of boxes(moov.start, moov.end)) {
      if (trak.type !== "trak") continue;
      for (const tkhd of boxes(trak.start, trak.end)) {
        if (tkhd.type !== "tkhd") continue;
        // version 0 and 1 differ in the size of the times before the matrix.
        const at = tkhd.start + (mp4[tkhd.start] === 1 ? 88 : 76);
        if (at + 8 > tkhd.end) continue;
        const width = mp4.readUInt32BE(at) >>> 16;
        const height = mp4.readUInt32BE(at + 4) >>> 16;
        // An audio track's header has width and height 0.
        if (width && height) return { width, height };
      }
    }
  }
  return null;
};

/** The post's page from its at:// uri. */
const postUrl = (uri) => {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri ?? "");
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
};

/**
 * Post `video` (a Buffer) with `text`. `size` is {width, height} of the video
 * when known (the embed's aspect ratio). `creds` holds the two secrets (live)
 * or DRY_RUN_BLUESKY. `now` gives createdAt and the service token's expiry.
 * `beforeCommit` runs just before createRecord. Returns {postId, url}.
 */
export const postToBluesky = async ({
  video,
  text,
  size = /** @type {{ width: number, height: number } | null} */ (null),
  transport,
  creds,
  sleep,
  beforeCommit,
  now = () => new Date(),
}) => {
  const problems = textLimitProblems("bluesky", text);
  if (problems.length) throw new NotPosted(problems.join("; "));

  const call = async (step, req) => {
    const reply = await transport.request(req);
    if (!ok(reply)) throw new PostFailed(`bluesky ${step}`, reply);
    return reply;
  };
  const json = (body) => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const session = await call("session", {
    method: "POST",
    url: `${BSKY_ENTRYWAY}/xrpc/com.atproto.server.createSession`,
    ...json({
      identifier: creds.BLUESKY_HANDLE,
      password: creds.BLUESKY_APP_PASSWORD,
    }),
    secretBody: true,
  });
  const { accessJwt, did, didDoc } = session.json ?? {};
  const pds = didDoc?.service?.find((s) =>
    String(s.id).endsWith("#atproto_pds"),
  )?.serviceEndpoint;
  if (!accessJwt || !did || !pds) {
    // Not the reply body: it can hold accessJwt and refreshJwt, and the
    // error goes into the cycle record (Reviewer 1, 700a661e).
    const missing = Object.entries({ accessJwt, did, pds })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new PostFailed(`bluesky session: no ${missing.join(", ")}`, {
      status: session.status,
    });
  }
  const userAuth = { authorization: `Bearer ${accessJwt}` };

  const exp = Math.floor(now().getTime() / 1000) + 30 * 60;
  const service = await call("service auth", {
    method: "GET",
    url: `${pds}/xrpc/com.atproto.server.getServiceAuth?${new URLSearchParams({
      aud: `did:web:${new URL(pds).host}`,
      lxm: "com.atproto.repo.uploadBlob",
      exp: String(exp),
    })}`,
    headers: userAuth,
  });
  const serviceToken = service.json?.token;
  if (!serviceToken)
    throw new PostFailed("bluesky service auth: no token", service);

  // A video the service already processed comes back as an error
  // (already_exists) that still carries its blob (docs.bsky.app, the note
  // under "Recommended method"), so a reply with a blob is used either way.
  const jobOf = (reply) => reply.json?.jobStatus ?? reply.json ?? {};
  const upload = await transport.request({
    method: "POST",
    url: `${BSKY_VIDEO}/xrpc/app.bsky.video.uploadVideo?${new URLSearchParams({
      did,
      name: `${sha256(video).slice(0, 16)}.mp4`,
    })}`,
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "content-type": "video/mp4",
    },
    body: video,
    describe: { bytes: video.length, sha256: sha256(video) },
  });
  let job = jobOf(upload);
  if (!job.blob && (!ok(upload) || !job.jobId)) {
    throw new PostFailed("bluesky upload", upload);
  }

  // The post must name a stored video: wait for the job's blob.
  for (let polls = 0; !job.blob; polls++) {
    if (job.state === "JOB_STATE_FAILED") {
      throw new NotPosted(
        `bluesky: the video job failed (${job.failureCode ?? job.error ?? "no reason"})`,
      );
    }
    if (polls >= JOB_POLLS) {
      throw new NotPosted(
        `bluesky: the video was not processed after ${(JOB_POLLS * JOB_POLL_MS) / 1000} s; nothing was posted`,
      );
    }
    if (polls > 0) await sleep(JOB_POLL_MS);
    const status = await transport.request({
      method: "GET",
      url: `${BSKY_VIDEO}/xrpc/app.bsky.video.getJobStatus?${new URLSearchParams({ jobId: job.jobId })}`,
    });
    const next = jobOf(status);
    if (!ok(status) && !next.blob) {
      throw new PostFailed("bluesky job status", status);
    }
    job = { jobId: job.jobId, ...next };
  }

  await beforeCommit();

  const facets = richTextFacets(text);
  const created = await transport.request({
    method: "POST",
    url: `${pds}/xrpc/com.atproto.repo.createRecord`,
    headers: { ...userAuth, "content-type": "application/json" },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: now().toISOString(),
        langs: ["en"],
        ...(facets.length ? { facets } : {}),
        embed: {
          $type: "app.bsky.embed.video",
          video: job.blob,
          ...(size
            ? { aspectRatio: { width: size.width, height: size.height } }
            : {}),
        },
      },
    }),
  });
  const uri = created.json?.uri;
  if (!ok(created) || !uri) throw new PostFailed("bluesky post", created);
  return { postId: uri, url: postUrl(uri) };
};
