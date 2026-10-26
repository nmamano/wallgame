/**
 * The Facebook, Bluesky, Mastodon and Threads posters, against canned
 * replies only: there are no keys, and nothing here calls a platform.
 *
 * What must hold for each: the text posts exactly as approved; a secret is
 * never in a URL; the one public request comes after `beforeCommit`; and a
 * failure is "not posted" only when the platform says so, else uncertain.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRunTransport, NotPosted, sha256 } from "./transport.mjs";
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
  DRY_RUN_FACEBOOK,
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

interface Req {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  secretBody?: boolean;
}
interface Reply {
  status: number;
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
  const live = {
    FACEBOOK_PAGE_ID: "PAGE1",
    FACEBOOK_PAGE_ACCESS_TOKEN: "SECRET-FB",
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
      "https://graph.facebook.com/v26.0/<FACEBOOK_PAGE_ID>/video_reels",
      `${FB_RUPLOAD}/DRY-RUN-VIDEO-ID`,
      "https://graph.facebook.com/v26.0/<FACEBOOK_PAGE_ID>/video_reels",
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
    BLUESKY_HANDLE: "wallgame.io",
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
