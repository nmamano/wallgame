/**
 * The one thing that differs between a dry run and a real post: where a
 * request goes.
 *
 * Both posting modules (post-x.mjs, post-youtube.mjs) build every request
 * themselves and hand it to a transport. The live transport sends it with
 * fetch. The dry-run transport writes it down and answers with a canned reply
 * shaped like the real one, so the module goes on to its next request exactly
 * as it would live. A dry run therefore runs the whole posting path and its
 * plan is the list of requests a live post would send, in order.
 *
 * A request is {method, url, headers, body, describe?}. `body` is a string or
 * a Buffer or a FormData; `describe` is what the plan shows instead of a body
 * that is binary (a byte count and a sha256, not megabytes of base64).
 *
 * SECRETS NEVER REACH A PLAN. A module gives each request its headers through
 * `headers(signer)`, and the dry-run signer returns a header that names the
 * credential instead of using it. The live signer is the only code that reads
 * a secret value.
 */
import { createHash } from "node:crypto";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** Send for real. Returns {status, headers, json, text}. */
export const liveTransport = () => {
  const sent = [];
  return {
    mode: "live",
    sent,
    async request(req) {
      sent.push(redacted(planEntry(req), req));
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: "manual",
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON; the caller reads text */
      }
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        json,
        text,
      };
    },
  };
};

/**
 * Write every request down. `reply(req, index)` gives the canned answer for
 * each one; the modules supply it, since only they know the shape.
 */
export const dryRunTransport = (reply) => {
  const sent = [];
  return {
    mode: "dry-run",
    sent,
    async request(req) {
      sent.push(planEntry(req));
      return reply(req, sent.length - 1);
    },
  };
};

const planEntry = (req) => ({
  method: req.method,
  url: req.url,
  headers: req.headers,
  body:
    req.describe ??
    (typeof req.body === "string" ? tryJson(req.body) : (req.body ?? null)),
});

/**
 * What the live transport keeps of a request it sent: no Authorization value,
 * and no body that a module marked `secretBody` (the Google token form holds
 * the client secret and the refresh token). The kept list goes into the
 * cycle record, which is not a secret store.
 */
const redacted = (entry, req) => ({
  ...entry,
  headers: Object.fromEntries(
    Object.entries(entry.headers ?? {}).map(([k, v]) =>
      k.toLowerCase() === "authorization" ? [k, "<redacted>"] : [k, v],
    ),
  ),
  body: req.secretBody ? "<redacted: holds credentials>" : entry.body,
});

const tryJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A transport error that keeps the reply, for the post log and the page. */
export class PostFailed extends Error {
  constructor(step, reply) {
    const detail = reply?.json
      ? JSON.stringify(reply.json)
      : (reply?.text ?? "");
    super(`${step}: HTTP ${reply?.status} ${detail.slice(0, 500)}`);
    this.name = "PostFailed";
    this.step = step;
    this.status = reply?.status;
  }
}

/**
 * The platform answered that the post was not made (TikTok's FAILED status),
 * as clear as a 4xx: posting again cannot make a second copy.
 */
export class NotPosted extends Error {
  constructor(message) {
    super(message);
    this.name = "NotPosted";
  }
}

export const ok = (reply) => reply.status >= 200 && reply.status < 300;
