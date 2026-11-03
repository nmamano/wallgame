/**
 * Nil's TikTok inbox (tiktok-drafts.mjs): a slot sends a draft only when
 * the latest one does not wait; the TikTok post ids stay strings.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTiktokDrafts } from "./tiktok-drafts.mjs";
import { idsAsText, tiktokPostStatus } from "./post-tiktok.mjs";

const OLD = "v_inbox_file~v2.7703619995012335647";
const NEW = "v_inbox_file~v2.7703991087983691807";

/** A drafts store whose latest draft and TikTok answers a test sets. */
const world = () => {
  let latest: { publishId: string; sentAt: string } | null = null;
  let answer: () => Promise<{ status?: string }> = () =>
    Promise.resolve({ status: "SEND_TO_USER_INBOX" });
  let t = Date.parse("2026-11-03T17:00:00Z");
  const reads: string[] = [];
  const drafts = createTiktokDrafts({
    path: join(mkdtempSync(join(tmpdir(), "tiktok-drafts-")), "d.json"),
    latest: () => latest,
    readStatus: (id: string) => {
      reads.push(id);
      return answer();
    },
    now: () => t,
  });
  return {
    drafts,
    reads,
    send: (publishId: string, sentAt: string) =>
      (latest = { publishId, sentAt }),
    answer: (status: string) => (answer = () => Promise.resolve({ status })),
    fail: (message: string) =>
      (answer = () => Promise.reject(new Error(message))),
    at: (iso: string) => (t = Date.parse(iso)),
  };
};

describe("a TikTok draft waits", () => {
  test("no draft yet: the slot sends one, with no read", async () => {
    const w = world();
    expect(await w.drafts.waiting()).toBe(null);
    expect(w.reads).toEqual([]);
    expect(w.drafts.status()).toEqual({
      waitingPublishId: null,
      waitingSince: null,
      lastPostedAt: null,
      lastRead: null,
    });
  });

  test("SEND_TO_USER_INBOX: it waits, and status() says since when", async () => {
    const w = world();
    w.send(NEW, "2026-11-03T17:00:12.611Z");
    expect(await w.drafts.waiting()).toBe("a draft is waiting");
    expect(w.reads).toEqual([NEW]);
    expect(w.drafts.status()).toMatchObject({
      waitingPublishId: NEW,
      waitingSince: "2026-11-03T17:00:12.611Z",
      lastPostedAt: null,
      lastRead: {
        at: "2026-11-03T17:00:00.000Z",
        publishId: NEW,
        status: "SEND_TO_USER_INBOX",
        error: null,
        failingSince: null,
      },
    });
    w.answer("PROCESSING_UPLOAD");
    expect(await w.drafts.waiting()).toBe(
      "a draft is waiting (TikTok: PROCESSING_UPLOAD)",
    );
  });

  test("PUBLISH_COMPLETE: the slot sends one; the first time seen is lastPostedAt, and the draft is not read again", async () => {
    const w = world();
    w.send(NEW, "2026-11-03T17:00:12.611Z");
    await w.drafts.waiting();
    w.at("2026-11-03T18:00:00Z");
    w.answer("PUBLISH_COMPLETE");
    expect(await w.drafts.waiting()).toBe(null);
    expect(w.drafts.mayWait()).toBe(false);
    w.at("2026-11-03T19:00:00Z");
    expect(await w.drafts.waiting()).toBe(null);
    expect(w.reads).toEqual([NEW, NEW]);
    expect(w.drafts.status()).toMatchObject({
      waitingPublishId: null,
      waitingSince: null,
      lastPostedAt: "2026-11-03T18:00:00.000Z",
    });
  });

  test("FAILED: the slot sends one", async () => {
    const w = world();
    w.send(NEW, "2026-11-03T17:00:12.611Z");
    w.answer("FAILED");
    expect(await w.drafts.waiting()).toBe(null);
    expect(w.drafts.status().waitingPublishId).toBe(null);
  });

  test("only the latest draft counts: a lost older one never blocks", async () => {
    const w = world();
    w.send(OLD, "2026-11-02T17:00:19.879Z");
    expect(await w.drafts.waiting()).toBe("a draft is waiting");
    w.answer("PUBLISH_COMPLETE");
    w.send(NEW, "2026-11-03T17:00:12.611Z");
    expect(await w.drafts.waiting()).toBe(null);
    expect(w.reads).toEqual([OLD, NEW]);
  });

  test("a failed read: no draft (status unknown), and a run of failures shows when it began", async () => {
    const w = world();
    w.send(NEW, "2026-11-03T17:00:12.611Z");
    w.fail("tiktok status: HTTP 401 code access_token_invalid");
    expect(await w.drafts.waiting()).toBe(
      "draft status unknown: tiktok status: HTTP 401 code access_token_invalid",
    );
    w.at("2026-11-03T18:00:00Z");
    await w.drafts.waiting();
    expect(w.drafts.status()).toMatchObject({
      waitingPublishId: NEW,
      lastRead: {
        at: "2026-11-03T18:00:00.000Z",
        status: null,
        error: "tiktok status: HTTP 401 code access_token_invalid",
        failingSince: "2026-11-03T17:00:00.000Z",
      },
    });
    w.answer("SEND_TO_USER_INBOX");
    await w.drafts.waiting();
    expect(w.drafts.status().lastRead?.failingSince).toBe(null);
  });

  test("a reply with no status is unknown too", async () => {
    const w = world();
    w.send(NEW, "2026-11-03T17:00:12.611Z");
    w.answer(undefined as unknown as string);
    expect(await w.drafts.waiting()).toBe(
      "draft status unknown: TikTok gave no status",
    );
  });

  test("tiktok --lost: the next slot sends one with no read; refused with no draft, no name, or no draft waiting", async () => {
    const w = world();
    expect(() => w.drafts.markLost({ by: "Growth" })).toThrow(
      "there is no TikTok draft",
    );
    w.send(OLD, "2026-11-02T17:00:19.879Z");
    expect(() => w.drafts.markLost({ by: " " })).toThrow("needs --by");
    expect(w.drafts.markLost({ by: "Wall Game Growth" })).toEqual({
      publishId: OLD,
    });
    expect(await w.drafts.waiting()).toBe(null);
    expect(w.reads).toEqual([]);
    expect(w.drafts.status().waitingPublishId).toBe(null);
    expect(() => w.drafts.markLost({ by: "Wall Game Growth" })).toThrow(
      "is not waiting",
    );
    // The next draft waits as usual.
    w.send(NEW, "2026-11-03T17:00:12.611Z");
    expect(await w.drafts.waiting()).toBe("a draft is waiting");
  });
});

test("a damaged file throws without quoting it, and is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-drafts-"));
  const path = join(dir, "d.json");
  writeFileSync(path, '{"drafts": {"secret-looking text');
  const drafts = createTiktokDrafts({
    path,
    latest: () => ({ publishId: NEW, sentAt: "2026-11-03T17:00:12.611Z" }),
    readStatus: () => Promise.resolve({ status: "SEND_TO_USER_INBOX" }),
  });
  const err = await drafts.waiting().catch((e: unknown) => e);
  expect(String(err)).toContain("tiktok-drafts.json cannot be read");
  expect(String(err)).not.toContain("secret-looking");
  expect(() => drafts.status()).toThrow("cannot be read");
  expect(readFileSync(path, "utf8")).toBe('{"drafts": {"secret-looking text');
});

describe("TikTok post ids stay strings", () => {
  // The 19 digits of the publish_id of v-2026-10-31-2 (2026-11-02), over 2^53.
  const ID = "7703619995012335647";
  const text = `{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${ID}],"uploaded_bytes":3456789},"error":{"code":"ok","message":"","log_id":"L1"}}`;

  interface Status {
    data: { publicaly_available_post_id: unknown[]; uploaded_bytes: number };
  }
  const parsed = () => JSON.parse(text) as Status;

  test("JSON.parse alone changes the id; idsAsText keeps every digit", () => {
    expect(String(parsed().data.publicaly_available_post_id[0])).not.toBe(ID);
    const json = idsAsText({ text, json: parsed() }) as Status;
    expect(json.data.publicaly_available_post_id).toEqual([ID]);
    // The other numbers stay numbers.
    expect(json.data.uploaded_bytes).toBe(3456789);
    // A single id, not in a list.
    const one = idsAsText({
      text: `{"publicaly_available_post_id": ${ID}}`,
    }) as { publicaly_available_post_id: unknown };
    expect(one.publicaly_available_post_id).toBe(ID);
  });

  test("tiktokPostStatus returns the id as a string", async () => {
    const transport = {
      mode: "live",
      request: (req: { url: string }) =>
        Promise.resolve(
          req.url.endsWith("/oauth/token/")
            ? { status: 200, json: { access_token: "A" } }
            : { status: 200, text, json: parsed() },
        ),
    };
    const r = await tiktokPostStatus({
      transport,
      creds: {
        TIKTOK_CLIENT_KEY: "k",
        TIKTOK_CLIENT_SECRET: "s",
        refreshToken: "r",
      },
      onRefreshToken: () => undefined,
      publishId: OLD,
    });
    expect(r).toMatchObject({
      status: "PUBLISH_COMPLETE",
      publicaly_available_post_id: [ID],
    });
  });
});
