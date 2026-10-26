/**
 * The R2 public copy for Threads, against canned replies only: nothing here
 * calls R2. The signer is checked against AWS's published S3 examples (read
 * 2026-10-26: "Authenticating Requests: Using Query Parameters" and "Signature
 * Calculations for the Authorization Header", S3 API Reference), which use
 * AWS's example credentials and 2013-05-24T00:00:00Z.
 */
import { describe, expect, test } from "bun:test";
import { dryRunTransport, PostFailed, sha256 } from "./transport.mjs";
import {
  presignedUrl,
  r2PublicUrl,
  signedHeaders,
  uriEncode,
  GET_URL_SECONDS,
  R2_BUCKET,
} from "./public-url-r2.mjs";

const AWS_EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AWS_DATE = new Date("2013-05-24T00:00:00Z");
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("SigV4, AWS's S3 examples", () => {
  test("a presigned GET URL", () => {
    expect(
      presignedUrl({
        method: "GET",
        url: "https://examplebucket.s3.amazonaws.com/test.txt",
        expiresSeconds: 86400,
        creds: AWS_EXAMPLE,
        region: "us-east-1",
        date: AWS_DATE,
      }),
    ).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  test("an Authorization header: GET Object with a Range header", () => {
    expect(
      signedHeaders({
        method: "GET",
        url: "https://examplebucket.s3.amazonaws.com/test.txt",
        headers: { range: "bytes=0-9" },
        payloadHash: EMPTY_SHA256,
        creds: AWS_EXAMPLE,
        region: "us-east-1",
        date: AWS_DATE,
      }),
    ).toEqual({
      range: "bytes=0-9",
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": "20130524T000000Z",
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    });
  });

  test("S3 encodes every byte outside A-Z a-z 0-9 - _ . ~", () => {
    expect(uriEncode("test$file.text")).toBe("test%24file.text");
    expect(uriEncode("a b/c*!'()~-_.")).toBe("a%20b%2Fc%2A%21%27%28%29~-_.");
  });
});

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const ENV = {
  R2_ACCOUNT_ID: "acct0123",
  R2_ACCESS_KEY_ID: "AKID-R2",
  R2_SECRET_ACCESS_KEY: "do-not-send-this-secret",
};
const VIDEO = Buffer.from("not really an mp4, but bytes all the same");
const HASH = sha256(VIDEO);
const NAME = "0123456789abcdef0123456789abcdef";
const OBJECT = `https://acct0123.r2.cloudflarestorage.com/${R2_BUCKET}/${NAME}.mp4`;
const at = () => new Date("2026-10-26T21:30:00Z");

/** What `run` failed with; a test fails if it did not fail. */
const failure = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
};

const hosting = (answer: (req: Req) => { status: number }) => {
  const transport = dryRunTransport(answer);
  const publicUrl = r2PublicUrl({ env: ENV, now: at, randomName: () => NAME });
  return {
    sent: transport.sent as Req[],
    host: () => publicUrl({ video: VIDEO, sha256: HASH, transport }),
  };
};

describe("r2PublicUrl", () => {
  test("PUT to the private bucket, a 15-minute GET URL, DELETE on remove", async () => {
    const { sent, host } = hosting(() => ({ status: 200 }));
    const hosted = await host();

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("PUT");
    expect(sent[0].url).toBe(OBJECT);
    expect(sent[0].body).toEqual({ bytes: VIDEO.length, sha256: HASH });
    expect(sent[0].headers["content-type"]).toBe("video/mp4");
    expect(sent[0].headers["x-amz-content-sha256"]).toBe(HASH);
    expect(sent[0].headers.authorization).toStartWith(
      "AWS4-HMAC-SHA256 Credential=AKID-R2/20261026/auto/s3/aws4_request,SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,Signature=",
    );

    const get = new URL(hosted.url);
    expect(`${get.origin}${get.pathname}`).toBe(OBJECT);
    expect(get.searchParams.get("X-Amz-Expires")).toBe(String(GET_URL_SECONDS));
    expect(GET_URL_SECONDS).toBe(15 * 60);
    expect(get.searchParams.get("X-Amz-Credential")).toBe(
      "AKID-R2/20261026/auto/s3/aws4_request",
    );
    expect(get.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    await hosted.remove();
    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ["PUT", OBJECT],
      ["DELETE", OBJECT],
    ]);
    expect(sent[1].headers["x-amz-content-sha256"]).toBe(EMPTY_SHA256);

    // The secret key signs; it is in no request and in no URL.
    expect(JSON.stringify(sent) + hosted.url).not.toContain(
      ENV.R2_SECRET_ACCESS_KEY,
    );
  });

  test("each video gets a new random 128-bit name, with no game id or date", async () => {
    const transport = dryRunTransport(() => ({ status: 200 }));
    const publicUrl = r2PublicUrl({ env: ENV, now: at });
    const names = [];
    for (let i = 0; i < 2; i++) {
      await publicUrl({ video: VIDEO, sha256: HASH, transport });
    }
    for (const req of transport.sent as Req[]) {
      const name = new URL(req.url).pathname.split("/").pop();
      expect(name).toMatch(/^[0-9a-f]{32}\.mp4$/);
      names.push(name);
    }
    expect(new Set(names).size).toBe(2);
  });

  test("an upload that fails is deleted all the same, and the post stops", async () => {
    const { sent, host } = hosting((req) => ({
      status: req.method === "PUT" ? 503 : 204,
    }));
    expect(await failure(host())).toBeInstanceOf(PostFailed);
    expect(sent.map((r) => r.method)).toEqual(["PUT", "DELETE"]);
  });

  test("a lost upload reply: the object is deleted and the error kept", async () => {
    const { sent, host } = hosting((req) => {
      if (req.method === "PUT") throw new Error("socket hang up");
      return { status: 204 };
    });
    expect(String(await failure(host()))).toContain("socket hang up");
    expect(sent.map((r) => r.method)).toEqual(["PUT", "DELETE"]);
  });

  test("remove: a 404 is gone already; another refusal is an error", async () => {
    let deleteStatus = 404;
    const { host } = hosting((req) => ({
      status: req.method === "DELETE" ? deleteStatus : 200,
    }));
    const hosted = await host();
    await hosted.remove();
    deleteStatus = 403;
    expect(String(await failure(hosted.remove()))).toContain(
      "r2 delete: HTTP 403",
    );
  });
});
