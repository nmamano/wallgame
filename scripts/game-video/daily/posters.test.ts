/**
 * The Facebook, Bluesky, Mastodon and Threads posters, against canned
 * replies only: there are no keys, and nothing here calls a platform.
 *
 * What must hold for each: the text posts exactly as approved; a secret is
 * never in a URL; the one public request comes after `beforeCommit`; and a
 * failure is "not posted" only when the platform says so, else uncertain.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRunTransport, errorText, NotPosted, sha256 } from "./transport.mjs";
import {
  blueskyLength,
  findUrls,
  mastodonLength,
  textLimitProblems,
  threadsLength,
} from "./post-limits.mjs";
import {
  postToFacebook,
  facebookDryRunReply,
  FB_RUPLOAD,
} from "./post-facebook.mjs";
import {
  postToBluesky,
  blueskyDryRunReply,
  richTextFacets,
  DRY_RUN_BLUESKY,
} from "./post-bluesky.mjs";
import {
  postToMastodon,
  mastodonDryRunReply,
  DRY_RUN_MASTODON,
} from "./post-mastodon.mjs";
import {
  postToThreads,
  threadsDryRunReply,
  threadsTokens,
  refreshThreadsToken,
  withoutSignedUrl,
  DRY_RUN_THREADS,
} from "./post-threads.mjs";
import { dryRunPublicUrl, r2PublicUrl, DRY_RUN_R2 } from "./public-url-r2.mjs";
import { openTokenStore } from "./token-store.mjs";
import {
  STORY_MAX_BYTES,
  instagramAuthCheck,
  instagramDryRunReply,
  postToInstagram,
  storyProblem,
} from "./post-instagram.mjs";
import {
  X_ME_URL,
  oauth1Header,
  xAppCheck,
  xAuthCheck,
  xSecretShape,
} from "./post-x.mjs";
import { createDaily } from "./routes.mjs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface Req {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  secretBody?: boolean;
}
interface Reply {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}
type Answer = (req: Req, index: number) => Reply;

const VIDEO = Buffer.from("fake mp4 bytes");
const LINK =
  "https://wallgame.io/?utm_source=bluesky&utm_medium=social&utm_campaign=daily-video";
const TEXT = `🎮 Red walled Blue in. ${LINK}`;
const noSleep = () => Promise.resolve();
const tempDir = () => mkdtempSync(join(tmpdir(), "posters-test-"));

/** What `run` failed with; a test fails if it did not fail. */
const failure = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (err) {
    return err;
  }
  throw new Error("expected the post to fail");
};

/**
 * A transport that says "live", so the live code path runs, but answers
 * from `answer` and keeps every request whole (headers and secret bodies
 * too), so a test can look for a secret anywhere in it.
 */
const fakeLive = (answer: Answer) => {
  const sent: Req[] = [];
  return {
    mode: "live",
    sent,
    request(req: Req) {
      sent.push(req);
      return Promise.resolve(answer(req, sent.length - 1));
    },
  };
};

/** The index of the commit request, and a beforeCommit that records it. */
const commitProbe = (transport: { sent: Req[] }) => {
  const probe = { at: -1, beforeCommit: () => Promise.resolve() };
  probe.beforeCommit = () => {
    probe.at = transport.sent.length;
    return Promise.resolve();
  };
  return probe;
};

const bodyOf = (req: Req) =>
  typeof req.body === "string"
    ? (JSON.parse(req.body) as Record<string, unknown>)
    : null;

/** No URL holds any of the secret values. */
const expectNoSecretInUrls = (sent: Req[], secrets: string[]) => {
  for (const req of sent) {
    for (const secret of secrets) expect(req.url).not.toContain(secret);
  }
};

describe("text limits", () => {
  test("Bluesky counts graphemes: a family emoji is one", () => {
    expect(blueskyLength("👨‍👩‍👧 ab")).toBe(4);
    expect(textLimitProblems("bluesky", "x".repeat(300))).toEqual([]);
    expect(textLimitProblems("bluesky", "x".repeat(301))[0]).toContain("301");
  });

  test("Threads counts an emoji as its UTF-8 bytes", () => {
    expect(threadsLength("ab🎮")).toBe(2 + 4);
    expect(textLimitProblems("threads", "🎮".repeat(125))).toEqual([]);
    expect(textLimitProblems("threads", "🎮".repeat(126))).toHaveLength(1);
  });

  test("Mastodon counts each URL as 23", () => {
    expect(mastodonLength(`Play ${LINK}`)).toBe(5 + 23);
    const long = `${"x".repeat(477)}${LINK}`;
    expect(textLimitProblems("mastodon", long)).toEqual([]);
    expect(textLimitProblems("mastodon", `x${long}`)).toHaveLength(1);
  });

  test("a URL ends before the punctuation of its sentence", () => {
    expect(
      findUrls("See https://wallgame.io/a. Then").map((u) => u.url),
    ).toEqual(["https://wallgame.io/a"]);
  });
});

describe("Facebook", () => {
  const live = { pageId: "PAGE1", pageToken: "SECRET-FB" };
  /** What a dry run's discovery gives (meta.mjs metaDryRunReply). */
  const DRY_RUN_FACEBOOK = {
    pageId: "DRY-RUN-PAGE-ID",
    pageToken: "<Page token from /me/accounts>",
  };

  test("start, upload, finish, then wait for published; the text is as given", async () => {
    const transport = dryRunTransport(facebookDryRunReply);
    const probe = commitProbe(transport);
    const result = await postToFacebook({
      video: VIDEO,
      durationSeconds: 30,
      description: TEXT,
      transport,
      creds: DRY_RUN_FACEBOOK,
      sleep: noSleep,
      beforeCommit: probe.beforeCommit,
    });
    const sent = transport.sent as Req[];
    expect(sent.map((r) => r.url.split("?")[0])).toEqual([
      "https://graph.facebook.com/v26.0/DRY-RUN-PAGE-ID/video_reels",
      `${FB_RUPLOAD}/DRY-RUN-VIDEO-ID`,
      "https://graph.facebook.com/v26.0/DRY-RUN-PAGE-ID/video_reels",
      "https://graph.facebook.com/v26.0/DRY-RUN-VIDEO-ID",
    ]);
    expect(probe.at).toBe(2);
    expect(sent[2].body).toMatchObject({
      upload_phase: "finish",
      video_state: "PUBLISHED",
      description: TEXT,
    });
    expect(sent[1].body).toEqual({
      bytes: VIDEO.length,
      sha256: sha256(VIDEO),
    });
    expect(result).toEqual({
      postId: "DRY-RUN-VIDEO-ID",
      url: "https://www.facebook.com/reel/DRY-RUN-VIDEO-ID",
    });
  });

  test("a video outside 3-90 s is refused before any request", async () => {
    for (const durationSeconds of [2.9, 90.5, null]) {
      const transport = dryRunTransport(facebookDryRunReply);
      const post = postToFacebook({
        video: VIDEO,
        durationSeconds,
        description: TEXT,
        transport,
        creds: DRY_RUN_FACEBOOK,
        sleep: noSleep,
        beforeCommit: noSleep,
      });
      expect(await failure(post)).toBeInstanceOf(NotPosted);
      expect(transport.sent).toHaveLength(0);
    }
  });

  test("the token is in headers only", async () => {
    const transport = fakeLive((req) => facebookDryRunReply(req));
    await postToFacebook({
      video: VIDEO,
      durationSeconds: 30,
      description: TEXT,
      transport,
      creds: live,
      sleep: noSleep,
      beforeCommit: noSleep,
    });
    expectNoSecretInUrls(transport.sent, ["SECRET-FB"]);
    expect(transport.sent[0].headers?.authorization).toBe("Bearer SECRET-FB");
    expect(transport.sent[1].headers?.authorization).toBe("OAuth SECRET-FB");
  });

  /** A finish that fails, and then the status `status`. */
  /** A finish that fails; then the status reads `statuses` in turn, the last one repeating. */
  const failedFinish = (statuses: unknown, finishStatus = 500) => {
    const reads: unknown[] = Array.isArray(statuses)
      ? [...(statuses as unknown[])]
      : [statuses];
    return fakeLive((req) => {
      if (bodyOf(req)?.upload_phase === "finish") {
        return { status: finishStatus, json: { error: { message: "x" } } };
      }
      if (req.url.includes("fields=status")) {
        const status = reads.length > 1 ? reads.shift() : reads[0];
        return { status: 200, json: { status } };
      }
      return facebookDryRunReply(req);
    });
  };
  const statusReads = (transport: ReturnType<typeof fakeLive>) =>
    transport.sent.filter((r) => r.url.includes("fields=status")).length;
  const run = (transport: ReturnType<typeof fakeLive>) =>
    postToFacebook({
      video: VIDEO,
      durationSeconds: 30,
      description: TEXT,
      transport,
      creds: live,
      sleep: noSleep,
      beforeCommit: noSleep,
    });

  test("after a failed finish, the video's status decides", async () => {
    const published = {
      publishing_phase: { status: "completed", publish_status: "published" },
    };
    expect((await run(failedFinish(published))).postId).toBe(
      "DRY-RUN-VIDEO-ID",
    );
    const notStarted = {
      processing_phase: { status: "completed" },
      publishing_phase: { status: "not_started" },
    };
    expect(await failure(run(failedFinish(notStarted, 400)))).toBeInstanceOf(
      NotPosted,
    );
    const busy = { publishing_phase: { status: "in_progress" } };
    const uncertain = run(failedFinish(busy));
    const err = await failure(uncertain);
    expect(String(err)).toMatch(/look at the Facebook Page/);
    expect(err).not.toBeInstanceOf(NotPosted);
  });

  test("after a failed finish, the status is read for a window: an accepted finish shows not_started at first", async () => {
    const notStarted = {
      processing_phase: { status: "not_started" },
      publishing_phase: { status: "not_started" },
    };
    const published = {
      publishing_phase: { status: "completed", publish_status: "published" },
    };
    const late = failedFinish([notStarted, notStarted, published], 400);
    expect((await run(late)).postId).toBe("DRY-RUN-VIDEO-ID");
    expect(statusReads(late)).toBe(3);

    // "Not posted" needs every read of the window to say so.
    const stays = failedFinish(notStarted, 400);
    expect(await failure(run(stays))).toBeInstanceOf(NotPosted);
    expect(statusReads(stays)).toBe(8);

    // Processing that ran once in the window leaves the post uncertain.
    const ran = failedFinish(
      [{ processing_phase: { status: "in_progress" } }, notStarted],
      400,
    );
    const err = await failure(run(ran));
    expect(err).not.toBeInstanceOf(NotPosted);
    expect(String(err)).toMatch(/look at the Facebook Page/);
  });

  test("a Reel that fails processing after the finish is not posted", async () => {
    const transport = fakeLive((req) =>
      req.url.includes("fields=status")
        ? {
            status: 200,
            json: { status: { processing_phase: { status: "error" } } },
          }
        : facebookDryRunReply(req),
    );
    expect(await failure(run(transport))).toBeInstanceOf(NotPosted);
  });
});

describe("Bluesky", () => {
  const live = {
    BLUESKY_IDENTIFIER: "did:plc:test",
    BLUESKY_APP_PASSWORD: "SECRET-PW",
  };
  const at = () => new Date("2026-10-27T12:00:00Z");

  test("the link facet counts bytes: an emoji before the link shifts it", () => {
    const [facet] = richTextFacets(TEXT);
    const bytes = Buffer.from(TEXT, "utf8");
    // 🎮 is 4 bytes but 2 UTF-16 units.
    expect(facet.index.byteStart).toBe(
      Buffer.byteLength("🎮 Red walled Blue in. "),
    );
    expect(
      bytes
        .subarray(facet.index.byteStart, facet.index.byteEnd)
        .toString("utf8"),
    ).toBe(LINK);
    expect(facet.features).toEqual([
      { $type: "app.bsky.richtext.facet#link", uri: LINK },
    ]);
  });

  test("a #tag gets a tag facet, as Bluesky's own client makes it", () => {
    const text = `Who wins? #WallGame #wall-game. ${LINK} #2026 end#no`;
    const facets = richTextFacets(text);
    const shown = facets.map((f) => [
      Buffer.from(text, "utf8")
        .subarray(f.index.byteStart, f.index.byteEnd)
        .toString("utf8"),
      f.features[0].$type.split("#")[1],
    ]);
    // In text order; trailing punctuation is not in the tag; a tag of
    // digits only, or a # inside a word, is no tag.
    expect(shown).toEqual([
      ["#WallGame", "tag"],
      ["#wall-game", "tag"],
      [LINK, "link"],
    ]);
    expect(facets[1].features[0]).toEqual({
      $type: "app.bsky.richtext.facet#tag",
      tag: "wall-game",
    });
  });

  test("a session with no PDS fails without its tokens in the error", async () => {
    const transport = fakeLive((req) =>
      req.url.includes("createSession")
        ? {
            status: 200,
            json: {
              accessJwt: "SECRET-ACCESS-JWT",
              refreshJwt: "SECRET-REFRESH-JWT",
              did: "did:plc:abc",
            },
          }
        : blueskyDryRunReply(req),
    );
    const err = await failure(
      postToBluesky({
        video: VIDEO,
        text: TEXT,
        transport,
        creds: live,
        sleep: noSleep,
        beforeCommit: noSleep,
        now: at,
      }),
    );
    expect(String(err)).toMatch(/bluesky session: no pds/);
    expect(String(err)).not.toContain("SECRET");
    // The session names the account by its identifier (the DID in code).
    const session = transport.sent[0];
    expect(session.secretBody).toBe(true);
    expect(
      (JSON.parse(String(session.body)) as { identifier: string }).identifier,
    ).toBe("did:plc:test");
  });

  test("session, service token, upload, job, then the post with the text as given", async () => {
    const transport = dryRunTransport(blueskyDryRunReply);
    const probe = commitProbe(transport);
    const result = await postToBluesky({
      video: VIDEO,
      text: TEXT,
      size: { width: 1080, height: 1920 },
      transport,
      creds: DRY_RUN_BLUESKY,
      sleep: noSleep,
      beforeCommit: probe.beforeCommit,
      now: at,
    });
    const sent = transport.sent as Req[];
    expect(sent.map((r) => r.url.split("?")[0])).toEqual([
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      "https://dry-run-pds.example/xrpc/com.atproto.server.getServiceAuth",
      "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo",
      "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus",
      "https://dry-run-pds.example/xrpc/com.atproto.repo.createRecord",
    ]);
    expect(probe.at).toBe(4);
    expect(sent[1].url).toContain("aud=did%3Aweb%3Adry-run-pds.example");
    const record = (sent[4].body as { record: Record<string, unknown> }).record;
    expect(record.text).toBe(TEXT);
    expect(record.facets).toEqual(richTextFacets(TEXT));
    expect(record.embed).toMatchObject({
      $type: "app.bsky.embed.video",
      aspectRatio: { width: 1080, height: 1920 },
    });
    expect(result.url).toBe(
      "https://bsky.app/profile/did:plc:dryrun/post/3dryrunpost",
    );
  });

  test("the app password is only in a body marked secret", async () => {
    const transport = fakeLive((req) => blueskyDryRunReply(req));
    await postToBluesky({
      video: VIDEO,
      text: TEXT,
      transport,
      creds: live,
      sleep: noSleep,
      beforeCommit: noSleep,
      now: at,
    });
    expectNoSecretInUrls(transport.sent, ["SECRET-PW", "DRY-RUN-ACCESS"]);
    const holders = transport.sent.filter((r) =>
      JSON.stringify(r.body ?? "").includes("SECRET-PW"),
    );
    expect(holders).toHaveLength(1);
    expect(holders[0].secretBody).toBe(true);
  });

  test("a failed video job is not posted; an already processed one is used", async () => {
    const failing = fakeLive((req) =>
      req.url.includes("getJobStatus")
        ? {
            status: 200,
            json: {
              jobStatus: {
                jobId: "j",
                did: "d",
                state: "JOB_STATE_FAILED",
                failureCode: "encoding_failure",
              },
            },
          }
        : blueskyDryRunReply(req),
    );
    const run = (transport: ReturnType<typeof fakeLive>) =>
      postToBluesky({
        video: VIDEO,
        text: TEXT,
        transport,
        creds: live,
        sleep: noSleep,
        beforeCommit: noSleep,
        now: at,
      });
    expect(String(await failure(run(failing)))).toMatch(/encoding_failure/);
    expect(failing.sent.some((r) => r.url.includes("createRecord"))).toBe(
      false,
    );

    const blob = {
      $type: "blob",
      ref: { $link: "bafkreiold" },
      mimeType: "video/mp4",
      size: 1,
    };
    const known = fakeLive((req) =>
      req.url.includes("uploadVideo")
        ? {
            status: 409,
            json: {
              error: "already_exists",
              jobStatus: {
                jobId: "j",
                did: "d",
                state: "JOB_STATE_COMPLETED",
                blob,
              },
            },
          }
        : blueskyDryRunReply(req),
    );
    await run(known);
    const post = known.sent.find((r) => r.url.includes("createRecord"));
    expect(
      (bodyOf(post!) as { record: { embed: { video: unknown } } }).record.embed
        .video,
    ).toEqual(blob);
  });

  test("a text over 300 graphemes is refused before any request", async () => {
    const transport = dryRunTransport(blueskyDryRunReply);
    expect(
      await failure(
        postToBluesky({
          video: VIDEO,
          text: "x".repeat(301),
          transport,
          creds: DRY_RUN_BLUESKY,
          sleep: noSleep,
          beforeCommit: noSleep,
        }),
      ),
    ).toBeInstanceOf(NotPosted);
    expect(transport.sent).toHaveLength(0);
  });
});

describe("Mastodon", () => {
  const live = {
    MASTODON_BASE_URL: "https://mastodon.example",
    MASTODON_ACCESS_TOKEN: "SECRET-MASTO",
  };

  test("media, wait until processed, then the status with the text as given", async () => {
    let polls = 0;
    const transport = fakeLive((req) => {
      if (req.url.includes("/api/v1/media/") && polls++ === 0) {
        return { status: 206, json: { id: "DRY-RUN-MEDIA-ID", url: null } };
      }
      return mastodonDryRunReply(req);
    });
    const probe = commitProbe(transport);
    const result = await postToMastodon({
      video: VIDEO,
      text: TEXT,
      transport,
      creds: live,
      sleep: noSleep,
      beforeCommit: probe.beforeCommit,
    });
    expect(
      transport.sent.map((r) => `${r.method} ${new URL(r.url).pathname}`),
    ).toEqual([
      "POST /api/v2/media",
      "GET /api/v1/media/DRY-RUN-MEDIA-ID",
      "GET /api/v1/media/DRY-RUN-MEDIA-ID",
      "POST /api/v1/statuses",
    ]);
    expect(probe.at).toBe(3);
    const status = transport.sent[3];
    expect(bodyOf(status)).toEqual({
      status: TEXT,
      media_ids: ["DRY-RUN-MEDIA-ID"],
      visibility: "public",
      language: "en",
    });
    expectNoSecretInUrls(transport.sent, ["SECRET-MASTO"]);
    expect(result.postId).toBe("DRY-RUN-STATUS-ID");
  });

  test("the idempotency key is the same for the same post, and differs for another text", async () => {
    const keyFor = async (text: string) => {
      const transport = dryRunTransport(mastodonDryRunReply);
      await postToMastodon({
        video: VIDEO,
        text,
        transport,
        creds: DRY_RUN_MASTODON,
        sleep: noSleep,
        beforeCommit: noSleep,
      });
      return (transport.sent as Req[]).at(-1)?.headers?.["idempotency-key"];
    };
    expect(await keyFor(TEXT)).toBe(await keyFor(TEXT));
    expect(await keyFor(TEXT)).not.toBe(await keyFor(`${TEXT}!`));
  });

  test("a video the server cannot process is not posted; the address must be https", async () => {
    const transport = fakeLive((req) =>
      req.url.includes("/api/v1/media/")
        ? { status: 422, json: { error: "bad" }, text: "bad" }
        : mastodonDryRunReply(req),
    );
    const run = (creds: typeof live, t = transport) =>
      postToMastodon({
        video: VIDEO,
        text: TEXT,
        transport: t,
        creds,
        sleep: noSleep,
        beforeCommit: noSleep,
      });
    expect(await failure(run(live))).toBeInstanceOf(NotPosted);
    const http = fakeLive((req) => mastodonDryRunReply(req));
    expect(
      String(
        await failure(
          run({ ...live, MASTODON_BASE_URL: "http://mastodon.example" }, http),
        ),
      ),
    ).toMatch(/https/);
    expect(http.sent).toHaveLength(0);
  });
});

describe("Threads", () => {
  const day = (iso: string) => () => new Date(iso);
  /** A token store in which /daily/connect connected Threads with `token`. */
  const connectedStore = (token: string) => {
    const store = openTokenStore(tempDir());
    store.write("threads", {
      connectedAt: "2026-10-26T09:00:00.000Z",
      connectedBy: "Nil",
      scopes: ["threads_basic", "threads_content_publish"],
      account: { id: "U1", name: "wallgameio" },
      accessToken: token,
      refreshedAt: null,
      triedAt: null,
    });
    return store;
  };

  test("refresh, copy to R2, container, wait, publish, permalink; the copy is removed", async () => {
    const transport = dryRunTransport(threadsDryRunReply);
    const probe = commitProbe(transport);
    const result = await postToThreads({
      video: VIDEO,
      text: TEXT,
      publicUrl: dryRunPublicUrl,
      tokens: threadsTokens(openTokenStore(tempDir())),
      transport,
      creds: DRY_RUN_THREADS,
      sleep: noSleep,
      beforeCommit: probe.beforeCommit,
    });
    const sent = transport.sent as Req[];
    const object = sent[1].url;
    const key = object.split("/").slice(-2).join("/");
    expect(key).toMatch(/^wallgame-threads-video\/[0-9a-f]{32}\.mp4$/);
    expect(sent.map((r) => `${r.method} ${r.url.split("?")[0]}`)).toEqual([
      "GET https://graph.threads.com/refresh_access_token",
      `PUT ${object}`,
      "POST https://graph.threads.com/v1.0/<Threads user id from /daily/connect>/threads",
      "GET https://graph.threads.com/v1.0/DRY-RUN-CONTAINER",
      "POST https://graph.threads.com/v1.0/<Threads user id from /daily/connect>/threads_publish",
      "GET https://graph.threads.com/v1.0/DRY-RUN-MEDIA-ID",
      `DELETE ${object}`,
    ]);
    expect(object).toStartWith(
      "https://dry-run-account.r2.cloudflarestorage.com/wallgame-threads-video/",
    );
    expect(probe.at).toBe(4);
    // The plan names the object, not the signed URL that Threads gets.
    expect(sent[2].body).toEqual({
      media_type: "VIDEO",
      video_url: `<signed URL of ${key}>`,
      text: TEXT,
    });
    expect(result).toEqual({
      postId: "DRY-RUN-MEDIA-ID",
      url: "https://www.threads.com/@wallgame/post/DRY-RUN",
    });
  });

  test("the token renews itself once a day and is kept; a failure keeps the old one", async () => {
    const store = connectedStore("SEED-TOKEN");
    const tokens = threadsTokens(store);
    let n = 0;
    const transport = fakeLive(() => ({
      status: 200,
      json: {
        access_token: `NEW-${++n}`,
        token_type: "bearer",
        expires_in: 5184000,
      },
    }));
    expect(
      (
        await refreshThreadsToken({
          transport,
          tokens,
          now: day("2026-10-27T10:00:00Z"),
        })
      ).refreshed,
    ).toBe(true);
    expect(tokens.current()).toBe("NEW-1");
    expect(transport.sent[0].headers?.authorization).toBe("Bearer SEED-TOKEN");
    expectNoSecretInUrls(transport.sent, ["SEED-TOKEN"]);
    // Within a day: no request.
    await refreshThreadsToken({
      transport,
      tokens,
      now: day("2026-10-28T09:00:00Z"),
    });
    expect(transport.sent).toHaveLength(1);
    // A day later it renews with the kept token; the rest of the
    // connection stays as Connect wrote it.
    await refreshThreadsToken({
      transport,
      tokens,
      now: day("2026-10-28T10:00:01Z"),
    });
    expect(transport.sent[1].headers?.authorization).toBe("Bearer NEW-1");
    expect(store.read("threads")).toMatchObject({
      accessToken: "NEW-2",
      refreshedAt: "2026-10-28T10:00:01.000Z",
      accessExpiresAt: "2026-12-27T10:00:01.000Z",
      account: { id: "U1", name: "wallgameio" },
      connectedBy: "Nil",
    });

    const refusing = fakeLive(() => ({
      status: 400,
      json: { error: { message: "too young" } },
    }));
    const outcome = await refreshThreadsToken({
      transport: refusing,
      tokens,
      now: day("2026-10-29T10:00:02Z"),
    });
    expect(outcome.refreshed).toBe(false);
    expect(outcome.error).toContain("too young");
    expect(tokens.current()).toBe("NEW-2");
  });

  test("after a failed publish, the container's status decides", async () => {
    const run = (...statuses: string[]) => {
      const transport = fakeLive((req) => {
        if (req.url.includes("/threads_publish")) {
          return { status: 500, json: { error: { message: "x" } } };
        }
        if (
          req.url.includes("fields=status") &&
          transport.sent.some((r) => r.url.includes("/threads_publish"))
        ) {
          const status = statuses.length > 1 ? statuses.shift() : statuses[0];
          return { status: 200, json: { status } };
        }
        return threadsDryRunReply(req);
      });
      return postToThreads({
        video: VIDEO,
        text: TEXT,
        publicUrl: dryRunPublicUrl,
        tokens: threadsTokens(connectedStore("SEED")),
        transport,
        creds: { userId: "U1" },
        sleep: noSleep,
        beforeCommit: noSleep,
      });
    };
    expect(await run("PUBLISHED")).toEqual({ postId: null, url: null });
    expect(await failure(run("FINISHED"))).toBeInstanceOf(NotPosted);
    // An accepted publish can show FINISHED for a moment.
    expect(await run("FINISHED", "PUBLISHED")).toEqual({
      postId: null,
      url: null,
    });
    const uncertain = run("IN_PROGRESS");
    const err = await failure(uncertain);
    expect(String(err)).toMatch(/look at the Threads profile/);
    expect(err).not.toBeInstanceOf(NotPosted);
  });

  test("a container that fails processing is not posted, the copy is still removed, and the error holds no signed URL", async () => {
    // The live path, with R2 signed by DRY_RUN_R2. Threads quotes the URL
    // it could not fetch in its error, as a platform may.
    const signedUrl = () => {
      const container = transport.sent.find((r) => r.url.endsWith("/threads"));
      return String(bodyOf(container!)?.video_url);
    };
    const transport = fakeLive((req) =>
      req.url.includes("fields=status")
        ? {
            status: 200,
            json: {
              status: "ERROR",
              error_message: `FAILED_DOWNLOADING_VIDEO from ${signedUrl()}`,
            },
          }
        : threadsDryRunReply(req),
    );
    const err = String(
      await failure(
        postToThreads({
          video: VIDEO,
          text: TEXT,
          publicUrl: r2PublicUrl({ env: DRY_RUN_R2 }),
          tokens: threadsTokens(connectedStore("SEED")),
          transport,
          creds: { userId: "U1" },
          sleep: noSleep,
          beforeCommit: noSleep,
        }),
      ),
    );
    expect(signedUrl()).toContain("X-Amz-Signature=");
    expect(err).toMatch(
      /FAILED_DOWNLOADING_VIDEO from <signed URL of wallgame-threads-video\/[0-9a-f]{32}\.mp4>/,
    );
    expect(err).not.toContain("X-Amz-Signature");
    expect(transport.sent.at(-1)?.method).toBe("DELETE");
    expect(transport.sent.some((r) => r.url.includes("threads_publish"))).toBe(
      false,
    );
  });

  test("withoutSignedUrl takes out the URL, and any signature in another form", () => {
    const url = "https://h/b/k.mp4?X-Amz-Date=1&X-Amz-Signature=abc123";
    expect(withoutSignedUrl(`get ${url} failed`, url, "<k>")).toBe(
      "get <k> failed",
    );
    const escaped = url.replace("&", "\\u0026");
    expect(withoutSignedUrl(escaped, url, "<k>")).toBe(
      "https://h/b/k.mp4?X-Amz-Date=1\\u0026X-Amz-Signature=<removed>",
    );
    // A platform may quote the URL as a percent-encoded parameter.
    expect(
      withoutSignedUrl(`video_url=${encodeURIComponent(url)}`, url, "<k>"),
    ).toBe(
      "video_url=https%3A%2F%2Fh%2Fb%2Fk.mp4%3FX-Amz-Date%3D1%26X-Amz-Signature%3D<removed>",
    );
    expect(withoutSignedUrl(url.toUpperCase(), url, "<k>")).not.toContain(
      "ABC123",
    );
  });
});

describe("Instagram fetches the video from R2", () => {
  const CREDS = { igUserId: "IG1", pageToken: "SECRET-PAGE" };
  const post = (
    transport: ReturnType<typeof fakeLive>,
    sleep: (ms: number) => Promise<void> = noSleep,
    beforeCommit = noSleep,
  ) =>
    postToInstagram({
      video: VIDEO,
      caption: "c",
      publicUrl: r2PublicUrl({ env: DRY_RUN_R2 }),
      transport,
      creds: CREDS,
      sleep,
      beforeCommit,
    });

  test("a Reel by video_url: no rupload, the commit is media_publish, and the copy is deleted after it", async () => {
    const transport = fakeLive(instagramDryRunReply);
    const probe = commitProbe(transport);
    expect(await post(transport, noSleep, probe.beforeCommit)).toEqual({
      postId: "DRY-RUN-MEDIA-ID",
      url: "https://www.instagram.com/reel/DRY-RUN/",
    });
    const sent = transport.sent;
    expect(sent.some((r) => r.url.includes("rupload"))).toBe(false);
    const put = sent.find((r) => r.method === "PUT");
    const container = sent.find((r) => r.url.endsWith("/IG1/media"));
    const body = bodyOf(container!);
    expect(body).toMatchObject({ media_type: "REELS", caption: "c" });
    expect(body).not.toHaveProperty("upload_type");
    // Instagram gets the signed GET of the object that was put.
    const signed = new URL(String(body?.video_url));
    expect(`${signed.origin}${signed.pathname}`).toBe(String(put?.url));
    expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]+$/);
    expect(sent[probe.at].url).toMatch(/\/IG1\/media_publish$/);
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", url: put?.url });
    expectNoSecretInUrls(sent, ["SECRET-PAGE"]);
  });

  test("a Story: media_type STORIES, no caption, its own copy, deleted after it", async () => {
    const transport = fakeLive(instagramDryRunReply);
    const probe = commitProbe(transport);
    const result = await postToInstagram({
      video: VIDEO,
      surface: "story",
      durationSeconds: 30,
      publicUrl: r2PublicUrl({ env: DRY_RUN_R2 }),
      transport,
      creds: CREDS,
      sleep: noSleep,
      beforeCommit: probe.beforeCommit,
    });
    expect(result.postId).toBe("DRY-RUN-MEDIA-ID");
    const sent = transport.sent;
    const put = sent.find((r) => r.method === "PUT");
    const body = bodyOf(sent.find((r) => r.url.endsWith("/IG1/media"))!);
    expect(Object.keys(body ?? {}).sort()).toEqual(["media_type", "video_url"]);
    expect(body?.media_type).toBe("STORIES");
    expect(sent[probe.at].url).toMatch(/\/IG1\/media_publish$/);
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", url: put?.url });
    expectNoSecretInUrls(sent, ["SECRET-PAGE"]);
  });

  test("a video outside the Story limits is refused before any request", async () => {
    const story = (video: Buffer, durationSeconds: number) => {
      const transport = fakeLive(instagramDryRunReply);
      return failure(
        postToInstagram({
          video,
          surface: "story",
          durationSeconds,
          publicUrl: r2PublicUrl({ env: DRY_RUN_R2 }),
          transport,
          creds: CREDS,
          sleep: noSleep,
          beforeCommit: noSleep,
        }),
      ).then((err) => ({ err, sent: transport.sent.length }));
    };
    const long = await story(VIDEO, 60.5);
    expect(long.err).toBeInstanceOf(NotPosted);
    expect(String(long.err)).toContain(
      "instagram story: the video is 60.5 s; a Story takes 3-60 s",
    );
    expect(long.sent).toBe(0);
    expect(String((await story(VIDEO, 2.9)).err)).toContain("is 2.9 s");
    const big = await story(Buffer.alloc(STORY_MAX_BYTES + 1), 30);
    expect(String(big.err)).toContain(
      `a Story takes ${STORY_MAX_BYTES} at most`,
    );
    expect(big.sent).toBe(0);
    // The limits are inclusive.
    expect(storyProblem({ video: VIDEO, durationSeconds: 60 })).toBeNull();
    expect(storyProblem({ video: VIDEO, durationSeconds: 3 })).toBeNull();
  });

  test("processing that ends in ERROR is not posted, the copy is still removed, and the error holds no signed URL", async () => {
    const signedUrl = () =>
      String(
        bodyOf(transport.sent.find((r) => r.url.endsWith("/IG1/media"))!)
          ?.video_url,
      );
    const transport = fakeLive((req) =>
      req.url.includes("fields=status_code")
        ? {
            status: 200,
            json: {
              status_code: "ERROR",
              status: `Error: could not fetch ${signedUrl()}`,
            },
          }
        : instagramDryRunReply(req),
    );
    const err = await failure(post(transport));
    expect(err).toBeInstanceOf(NotPosted);
    expect(String(err)).toMatch(
      /ERROR \(Error: could not fetch <signed URL of wallgame-threads-video\/[0-9a-f]{32}\.mp4>\)/,
    );
    expect(String(err)).not.toContain("X-Amz-Signature");
    expect(transport.sent.at(-1)?.method).toBe("DELETE");
    expect(transport.sent.some((r) => r.url.includes("media_publish"))).toBe(
      false,
    );
  });

  test("a video still IN_PROGRESS after 5 minutes is not posted; each read waits a minute, inside the URL's 15 minutes", async () => {
    const waits: number[] = [];
    const transport = fakeLive((req) =>
      req.url.includes("fields=status_code")
        ? { status: 200, json: { status_code: "IN_PROGRESS" } }
        : instagramDryRunReply(req),
    );
    const err = await failure(
      post(transport, (ms) => {
        waits.push(ms);
        return Promise.resolve();
      }),
    );
    expect(err).toBeInstanceOf(NotPosted);
    expect(String(err)).toMatch(/not processed after 300 s/);
    expect(waits).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(transport.sent.at(-1)?.method).toBe("DELETE");
    expect(transport.sent.some((r) => r.url.includes("media_publish"))).toBe(
      false,
    );
  });
});

describe("read-only auth checks", () => {
  const X_ENV = {
    X_API_KEY: "SECRET-KEY",
    X_API_SECRET: "SECRET-KEY-SECRET",
  };
  /** What Connect stores for X (tokens/x.json). */
  const X_RECORD = {
    connectedAt: "2026-10-28T05:00:00.000Z",
    connectedBy: "Nil",
    scopes: [],
    account: { id: "123", name: "@wallgameio" },
    accessToken: "123-SECRET-TOKEN",
    accessTokenSecret: "SECRET-TOKEN-SECRET",
  };
  const ALL_SECRETS = [
    ...Object.values(X_ENV),
    X_RECORD.accessToken,
    X_RECORD.accessTokenSecret,
  ];

  test("xSecretShape says yes or no for the key pair and holds no part of a value", () => {
    expect(
      xSecretShape({ X_API_KEY: "", X_API_SECRET: "SECRET-KEY-SECRET\n" }),
    ).toEqual({
      X_API_KEY: { set: false, whitespaceAtAnEnd: false },
      X_API_SECRET: { set: true, whitespaceAtAnEnd: true },
    });
  });

  test("xAppCheck posts client_credentials with Basic key:secret and keeps only the status", async () => {
    const transport = fakeLive(() => ({
      status: 200,
      json: { token_type: "bearer", access_token: "SECRET-BEARER" },
    }));
    const r = await xAppCheck({ transport, env: X_ENV });
    expect(r).toEqual({ status: 200, ok: true });
    expect(JSON.stringify(r)).not.toContain("SECRET-BEARER");
    expect(transport.sent).toHaveLength(1);
    const [req] = transport.sent;
    expect(req).toMatchObject({
      method: "POST",
      url: "https://api.x.com/oauth2/token",
      body: "grant_type=client_credentials",
    });
    expect(req.headers?.authorization).toBe(
      `Basic ${Buffer.from("SECRET-KEY:SECRET-KEY-SECRET").toString("base64")}`,
    );
  });

  test("xAuthCheck sends one signed GET of /2/users/me and reports the access level, or X's error", async () => {
    const ok = fakeLive(() => ({
      status: 200,
      headers: { "x-access-level": "read-write" },
      json: { data: { id: "1", username: "wallgameio" } },
    }));
    const sign = (r: { method: string; url: string }) =>
      oauth1Header(r, {
        consumerKey: "k",
        consumerSecret: "s",
        token: "t",
        tokenSecret: "ts",
      });
    expect(await xAuthCheck({ transport: ok, sign })).toEqual({
      status: 200,
      ok: true,
      username: "wallgameio",
      accessLevel: "read-write",
    });
    expect(ok.sent).toHaveLength(1);
    expect(ok.sent[0]).toMatchObject({ method: "GET", url: X_ME_URL });
    expect(ok.sent[0].headers?.authorization).toMatch(/^OAuth /);

    const refused = fakeLive(() => ({
      status: 401,
      json: { title: "Unauthorized", status: 401, detail: "Unauthorized" },
    }));
    expect(await xAuthCheck({ transport: refused, sign })).toEqual({
      status: 401,
      ok: false,
      title: "Unauthorized",
      detail: "Unauthorized",
    });
  });

  test("instagramAuthCheck reads the account with the Page token, and reports only Graph error codes", async () => {
    const creds = { igUserId: "IG1", pageToken: "SECRET-PAGE" };
    const ok = fakeLive(() => ({
      status: 200,
      json: { username: "wallgame.io" },
    }));
    expect(await instagramAuthCheck({ transport: ok, creds })).toEqual({
      status: 200,
      ok: true,
      username: "wallgame.io",
    });
    expect(ok.sent[0]).toMatchObject({
      method: "GET",
      url: "https://graph.facebook.com/v26.0/IG1?fields=username",
    });
    expect(ok.sent[0].headers?.authorization).toBe("Bearer SECRET-PAGE");
    const refused = fakeLive(() => ({
      status: 400,
      json: {
        error: {
          message: "token SECRET-PAGE is bad",
          type: "OAuthException",
          code: 190,
        },
      },
    }));
    const r = await instagramAuthCheck({ transport: refused, creds });
    expect(r).toEqual({ status: 400, ok: false, error: "OAuthException 190" });
  });

  /** GET /api/daily/auth-check on an app with `env`; its reply and requests. */
  const authCheck = async (
    env: Record<string, string>,
    platform: string,
    answer: Answer = () => ({ status: 200, json: {} }),
    connected: Record<string, object> = {},
  ) => {
    const transport = fakeLive(answer);
    const daily = createDaily({
      dataDir: tempDir(),
      env,
      live: () => transport,
    });
    const tokenStore = openTokenStore(join(daily.store.dirs.root, "tokens"));
    for (const [p, record] of Object.entries(connected)) {
      tokenStore.write(p, record as Parameters<typeof tokenStore.write>[1]);
    }
    const server: Server = createServer((req, res) => {
      void daily.handle(req, res, new URL(req.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/daily/auth-check?platform=${platform}`,
      );
      return {
        status: res.status,
        text: await res.text(),
        sent: transport.sent,
      };
    } finally {
      daily.stop();
      server.close();
    }
  };

  test("the route checks the key pair, then /2/users/me with the connected token, read-only, and names no secret value", async () => {
    const answer: Answer = (req) =>
      req.url.endsWith("/oauth2/token")
        ? { status: 200, json: { access_token: "SECRET-BEARER" } }
        : {
            status: 401,
            json: {
              title: "Unauthorized",
              status: 401,
              detail: "Unauthorized",
            },
          };
    const { status, text, sent } = await authCheck(
      { ...X_ENV, X_API_SECRET: "SECRET-KEY-SECRET\n" },
      "x",
      answer,
      { x: X_RECORD },
    );
    expect(status).toBe(200);
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST https://api.x.com/oauth2/token",
      `GET ${X_ME_URL}`,
    ]);
    // The user call is signed with the stored token, not an env var.
    expect(sent[1].headers?.authorization).toContain(
      'oauth_token="123-SECRET-TOKEN"',
    );
    const reply = JSON.parse(text) as {
      missing: string[];
      shape: Record<string, unknown>;
      app: unknown;
      result: unknown;
    };
    expect(reply.missing).toEqual([]);
    expect(reply.shape.X_API_SECRET).toEqual({
      set: true,
      whitespaceAtAnEnd: true,
    });
    expect(reply.app).toEqual({ status: 200, ok: true });
    expect(reply.result).toMatchObject({ status: 401, ok: false });
    for (const secret of [...ALL_SECRETS, "SECRET-BEARER"]) {
      expect(text).not.toContain(secret);
    }

    // Not connected: the key pair only.
    const alone = await authCheck(X_ENV, "x", answer);
    expect(alone.sent.map((r) => r.url)).toEqual([
      "https://api.x.com/oauth2/token",
    ]);
    expect(JSON.parse(alone.text)).toMatchObject({
      app: { status: 200, ok: true },
      result: { ok: false, error: "not connected (/daily/connect)" },
    });
  });

  test("the route does not call a platform whose own secrets are missing; R2 alone does not stop the Instagram read", async () => {
    const x = await authCheck({ X_API_KEY: "SECRET-KEY" }, "x");
    expect(x.sent).toHaveLength(0);
    expect(JSON.parse(x.text)).toMatchObject({
      missing: ["X_API_SECRET"],
      result: null,
    });
    const ig = await authCheck({}, "instagram");
    expect(ig.sent).toHaveLength(0);
    const withMeta = await authCheck(
      { META_SYSTEM_USER_TOKEN: "SECRET-SU" },
      "instagram",
      (req) =>
        req.url.includes("/me/accounts")
          ? {
              status: 200,
              json: {
                data: [
                  { id: "P1", name: "Wall Game", access_token: "SECRET-PAGE" },
                ],
              },
            }
          : req.url.includes("fields=instagram_business_account")
            ? {
                status: 200,
                json: { instagram_business_account: { id: "IG1" } },
              }
            : { status: 200, json: { username: "wallgame.io" } },
    );
    expect(withMeta.sent.every((r) => r.method === "GET")).toBe(true);
    expect(JSON.parse(withMeta.text)).toMatchObject({
      missing: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
      result: { status: 200, ok: true, username: "wallgame.io" },
    });
    for (const secret of ["SECRET-SU", "SECRET-PAGE"]) {
      expect(withMeta.text).not.toContain(secret);
    }
  });

  test("an unknown platform is refused", async () => {
    expect((await authCheck({}, "tiktok")).status).toBe(409);
  });
});

describe("GET /api/daily/tiktok-status", () => {
  const ENV = { TIKTOK_CLIENT_SECRET: "SECRET-CLIENT" };
  const RECORD = {
    connectedAt: "2026-10-28T21:23:00.000Z",
    connectedBy: "Nil",
    scopes: ["video.upload", "user.info.basic", "user.info.stats"],
    account: { id: "u1", name: "wallgame.io" },
    refreshToken: "SECRET-REFRESH",
    refreshExpiresAt: "2027-10-28T21:23:00.000Z",
  };
  const ID = "v_inbox_file~v2.7703619995012335647";
  const SECRETS = [
    "SECRET-CLIENT",
    "SECRET-REFRESH",
    "SECRET-ACCESS",
    "SECRET-URL",
  ];
  /** TikTok's token reply (a rotated refresh token), then `status`. */
  const answer =
    (status: Reply): Answer =>
    (req) =>
      req.url.endsWith("/oauth/token/")
        ? {
            status: 200,
            json: {
              access_token: "SECRET-ACCESS",
              refresh_token: "SECRET-ROTATED",
              refresh_expires_in: 86_400,
            },
          }
        : status;

  /** The route on an app with `env` and `record`; reply, requests, store. */
  const ask = async (
    query: string,
    status: Reply,
    {
      env = ENV as Record<string, string>,
      record = RECORD as object | null,
      posting = false,
    } = {},
  ) => {
    const transport = fakeLive(answer(status));
    const daily = createDaily({
      dataDir: tempDir(),
      env,
      live: () => transport,
    });
    const tokens = openTokenStore(join(daily.store.dirs.root, "tokens"));
    if (record)
      tokens.write("tiktok", record as Parameters<typeof tokens.write>[1]);
    const server: Server = createServer((req, res) => {
      void daily.handle(req, res, new URL(req.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    // A post that runs until the request is answered.
    let release: () => void = () => undefined;
    const post = posting
      ? daily.asThePost(() => new Promise<void>((r) => (release = r)))
      : null;
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/daily/tiktok-status${query}`,
      );
      return {
        status: res.status,
        text: await res.text(),
        sent: transport.sent,
        refreshToken: tokens.read("tiktok")?.refreshToken,
      };
    } finally {
      release();
      await post;
      daily.stop();
      server.close();
    }
  };
  const inbox: Reply = {
    status: 200,
    json: {
      data: {
        status: "SEND_TO_USER_INBOX",
        uploaded_bytes: 3_456_789,
        // A field the route does not pass on.
        upload_url: "https://open-upload.tiktokapis.us/SECRET-URL",
      },
      error: { code: "ok", message: "", log_id: "L1" },
    },
  };

  test("one token refresh, one status fetch: TikTok's status and fields, the rotated token kept, no token in the reply", async () => {
    const r = await ask(`?publishId=${encodeURIComponent(ID)}`, inbox);
    expect(r.status).toBe(200);
    const reply = JSON.parse(r.text) as Record<string, unknown>;
    expect(reply).toMatchObject({
      publishId: ID,
      code: "ok",
      status: "SEND_TO_USER_INBOX",
      uploaded_bytes: 3_456_789,
    });
    expect(Object.keys(reply).sort()).toEqual(
      ["at", "code", "publishId", "status", "uploaded_bytes"].sort(),
    );
    expect(r.sent.map((q) => `${q.method} ${q.url}`)).toEqual([
      "POST https://open.tiktokapis.com/v2/oauth/token/",
      "POST https://open.tiktokapis.com/v2/post/publish/status/fetch/",
    ]);
    expect(JSON.parse(r.sent[1].body as string)).toEqual({ publish_id: ID });
    expect(r.sent[1].headers?.authorization).toBe("Bearer SECRET-ACCESS");
    // As at a post: the rotated refresh token is the one kept.
    expect(r.refreshToken).toBe("SECRET-ROTATED");
    for (const secret of [...SECRETS, "SECRET-ROTATED"]) {
      expect(r.text).not.toContain(secret);
    }
  });

  test("a failed upload: TikTok's fail_reason", async () => {
    const r = await ask(`?publishId=${encodeURIComponent(ID)}`, {
      status: 200,
      json: {
        data: { status: "FAILED", fail_reason: "file_format_check_failed" },
        error: { code: "ok" },
      },
    });
    expect(JSON.parse(r.text)).toMatchObject({
      status: "FAILED",
      fail_reason: "file_format_check_failed",
    });
  });

  test("a refusal by TikTok names the HTTP status and code, never the reply", async () => {
    const r = await ask(`?publishId=${encodeURIComponent(ID)}`, {
      status: 401,
      json: {
        error: {
          code: "access_token_invalid",
          message: "token SECRET-ACCESS is bad",
        },
      },
    });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text)).toEqual({
      error: "tiktok status: HTTP 401 code access_token_invalid",
    });
  });

  test("no request without a valid publishId, without the secret or Connect, or while a post runs", async () => {
    const bad = await ask("?publishId=a%20b", inbox);
    expect(bad.status).toBe(409);
    expect(bad.sent).toHaveLength(0);
    const none = await ask("", inbox);
    expect(none.status).toBe(409);
    const noSecret = await ask(`?publishId=${ID}`, inbox, { env: {} });
    expect(noSecret.status).toBe(409);
    expect(noSecret.text).toContain("secrets missing: TIKTOK_CLIENT_SECRET");
    expect(noSecret.sent).toHaveLength(0);
    const notConnected = await ask(`?publishId=${ID}`, inbox, { record: null });
    expect(notConnected.status).toBe(409);
    expect(notConnected.text).toContain("not connected");
    expect(notConnected.sent).toHaveLength(0);
    const posting = await ask(`?publishId=${ID}`, inbox, {
      posting: true,
    });
    expect(posting.status).toBe(409);
    expect(posting.text).toContain("a post is already running");
    expect(posting.sent).toHaveLength(0);
  });
});

describe("Nil's TikTok inbox on the app (tiktok-drafts.mjs)", () => {
  const ENV = { TIKTOK_CLIENT_SECRET: "SECRET-CLIENT" };
  const RECORD = {
    connectedAt: "2026-10-28T21:23:00.000Z",
    connectedBy: "Nil",
    scopes: ["video.upload"],
    account: { id: "u1", name: "wallgame.io" },
    refreshToken: "SECRET-REFRESH",
  };
  const ID = "v_inbox_file~v2.7703991087983691807";

  test("the status block, crew.mjs's route and tiktok --lost read the latest draft of the live post log", async () => {
    const transport = fakeLive((req) =>
      req.url.endsWith("/oauth/token/")
        ? { status: 200, json: { access_token: "SECRET-ACCESS" } }
        : {
            status: 200,
            json: {
              data: { status: "SEND_TO_USER_INBOX" },
              error: { code: "ok" },
            },
          },
    );
    const daily = createDaily({
      dataDir: tempDir(),
      env: ENV,
      live: () => transport,
    });
    openTokenStore(join(daily.store.dirs.root, "tokens")).write(
      "tiktok",
      RECORD as Parameters<ReturnType<typeof openTokenStore>["write"]>[1],
    );
    writeFileSync(
      daily.store.postLog.live,
      [
        { utc: "2026-11-02T17:00:19.879Z", platform: "tiktok", postId: "old" },
        { utc: "2026-11-03T17:00:12.611Z", platform: "tiktok", postId: ID },
        { utc: "2026-11-03T17:00:20.000Z", platform: "x", postId: "1" },
      ]
        .map((r) => JSON.stringify(r) + "\n")
        .join(""),
    );
    const server: Server = createServer((req, res) => {
      void daily.handle(req, res, new URL(req.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, path: string, body?: object) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    };
    try {
      // No read yet: the latest draft may wait.
      const before = await call("GET", "/api/review/status");
      expect(before.json.tiktok).toEqual({
        waitingPublishId: ID,
        waitingSince: "2026-11-03T17:00:12.611Z",
        lastPostedAt: null,
        lastRead: null,
      });
      expect(transport.sent).toHaveLength(0);
      expect((await call("GET", "/api/daily/tiktok")).json).toEqual(
        before.json.tiktok as Record<string, unknown>,
      );
      expect((await call("POST", "/api/daily/tiktok/lost", {})).status).toBe(
        409,
      );
      const lost = await call("POST", "/api/daily/tiktok/lost", {
        by: "Wall Game Growth",
      });
      expect(lost.json).toEqual({ publishId: ID });
      expect((await call("GET", "/api/daily/tiktok")).json).toMatchObject({
        waitingPublishId: null,
      });
      expect(JSON.stringify(transport.sent)).not.toContain("old");
      // A damaged file: the status still answers, with the error for TikTok.
      writeFileSync(join(daily.store.dirs.root, "tiktok-drafts.json"), "{");
      const damaged = await call("GET", "/api/review/status");
      expect(damaged.status).toBe(200);
      expect(damaged.json.tiktok).toEqual({
        error:
          "tiktok-drafts.json cannot be read: move it aside, then the next read starts again",
      });
      expect(damaged.json).toHaveProperty("counts");
    } finally {
      daily.stop();
      server.close();
    }
  });
});

describe("GET /api/daily/youtube-recent", () => {
  const ENV = { YOUTUBE_CLIENT_SECRET: "SECRET-CLIENT" };
  const RECORD = {
    connectedAt: "2026-10-29T05:38:00.000Z",
    connectedBy: "Nil",
    scopes: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
    ],
    account: null,
    refreshToken: "SECRET-REFRESH",
  };
  const API = "https://www.googleapis.com/youtube/v3";
  /** Google's replies: a token, the channel, the playlist, the videos. */
  const google =
    (videos: Reply): Answer =>
    (req) =>
      req.url === "https://oauth2.googleapis.com/token"
        ? {
            status: 200,
            json: {
              access_token: "SECRET-ACCESS",
              refresh_token: "SECRET-ROTATED",
            },
          }
        : req.url.startsWith(`${API}/channels`)
          ? {
              status: 200,
              json: {
                items: [
                  {
                    contentDetails: { relatedPlaylists: { uploads: "UU1" } },
                  },
                ],
              },
            }
          : req.url.startsWith(`${API}/playlistItems`)
            ? {
                status: 200,
                json: {
                  items: [
                    { contentDetails: { videoId: "NEW1" } },
                    { contentDetails: { videoId: "OLD2" } },
                  ],
                },
              }
            : videos;

  const ask = async (
    answer: Answer,
    { record = RECORD as object | null } = {},
  ) => {
    const transport = fakeLive(answer);
    const daily = createDaily({
      dataDir: tempDir(),
      env: ENV as Record<string, string>,
      live: () => transport,
    });
    const tokens = openTokenStore(join(daily.store.dirs.root, "tokens"));
    if (record) {
      tokens.write("youtube", record as Parameters<typeof tokens.write>[1]);
    }
    const server: Server = createServer((req, res) => {
      void daily.handle(req, res, new URL(req.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/daily/youtube-recent`,
      );
      return {
        status: res.status,
        text: await res.text(),
        sent: transport.sent,
        refreshToken: tokens.read("youtube")?.refreshToken,
      };
    } finally {
      daily.stop();
      server.close();
    }
  };

  test("the last uploads in every state, only the allowed fields, newest first; the rotated token kept; no secret in the reply", async () => {
    const r = await ask(
      google({
        status: 200,
        json: {
          items: [
            {
              id: "OLD2",
              snippet: {
                title: "the 15:00 post",
                publishedAt: "2026-11-04T23:00:30Z",
                description: "SECRET-NOT-PASSED",
              },
              status: { privacyStatus: "public", uploadStatus: "processed" },
              processingDetails: { processingStatus: "succeeded" },
            },
            {
              id: "NEW1",
              snippet: {
                title: "bro was ahead, then he stepped in",
                publishedAt: "2026-11-05T05:00:41Z",
              },
              status: {
                privacyStatus: "public",
                uploadStatus: "failed",
                failureReason: "uploadAborted",
              },
              processingDetails: { processingStatus: "failed" },
            },
          ],
        },
      }),
    );
    expect(r.status).toBe(200);
    const reply = JSON.parse(r.text) as { at: string; videos: unknown[] };
    expect(reply.videos).toEqual([
      {
        id: "NEW1",
        title: "bro was ahead, then he stepped in",
        publishedAt: "2026-11-05T05:00:41Z",
        privacyStatus: "public",
        uploadStatus: "failed",
        processingStatus: "failed",
        failureReason: "uploadAborted",
        rejectionReason: null,
      },
      {
        id: "OLD2",
        title: "the 15:00 post",
        publishedAt: "2026-11-04T23:00:30Z",
        privacyStatus: "public",
        uploadStatus: "processed",
        processingStatus: "succeeded",
        failureReason: null,
        rejectionReason: null,
      },
    ]);
    expect(r.sent.map((q) => `${q.method} ${q.url}`)).toEqual([
      "POST https://oauth2.googleapis.com/token",
      `GET ${API}/channels?part=contentDetails&mine=true`,
      `GET ${API}/playlistItems?part=contentDetails&maxResults=5&playlistId=UU1`,
      `GET ${API}/videos?part=snippet,status,processingDetails&id=NEW1,OLD2`,
    ]);
    expect(r.sent[1].headers?.authorization).toBe("Bearer SECRET-ACCESS");
    expect(r.refreshToken).toBe("SECRET-ROTATED");
    for (const secret of [
      "SECRET-CLIENT",
      "SECRET-REFRESH",
      "SECRET-ROTATED",
      "SECRET-ACCESS",
      "SECRET-NOT-PASSED",
    ]) {
      expect(r.text).not.toContain(secret);
    }
  });

  test("a refusal names the step, the HTTP status and Google's reason, never the reply", async () => {
    const r = await ask(
      google({
        status: 403,
        json: {
          error: {
            code: 403,
            message: "token SECRET-ACCESS has no quota",
            errors: [{ reason: "quotaExceeded" }],
          },
        },
      }),
    );
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text)).toEqual({
      error: "youtube videos: HTTP 403 quotaExceeded",
    });
  });

  test("no request without the secret, the Connect or the read scope", async () => {
    const answer = google({ status: 200, json: { items: [] } });
    const none = await ask(answer, { record: null });
    expect(none.status).toBe(409);
    expect(none.text).toContain("not connected");
    expect(none.sent).toHaveLength(0);
    const noScope = await ask(answer, {
      record: { ...RECORD, scopes: [RECORD.scopes[1]] },
    });
    expect(noScope.status).toBe(409);
    expect(noScope.text).toContain("no youtube.readonly scope");
    expect(noScope.sent).toHaveLength(0);
  });
});

describe("errorText keeps a network fault's cause", () => {
  test("fetch failed names its cause's code and message; a plain error is its message", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
    expect(errorText(err)).toBe(
      "fetch failed (cause: ECONNRESET read ECONNRESET)",
    );
    expect(errorText(new Error("youtube upload: HTTP 500"))).toBe(
      "youtube upload: HTTP 500",
    );
    expect(errorText("text")).toBe("text");
    expect(
      errorText(new Error("x", { cause: new Error("y".repeat(300)) })),
    ).toBe(`x (cause: ${"y".repeat(200)})`);
    // A URL with a token in a cause's text is masked.
    expect(
      errorText(
        new Error("fetch failed", {
          cause: new Error(
            "bad https://graph.facebook.com/v1/me?access_token=SECRET-T&x=1 https://h/p?key=SECRET-K#f https://h/p?a=1&refresh_token=SECRET-R",
          ),
        }),
      ),
    ).toBe(
      "fetch failed (cause: bad https://graph.facebook.com/v1/me?access_token=<masked>&x=1 https://h/p?key=<masked>#f https://h/p?a=1&refresh_token=<masked>)",
    );
  });
});
