/**
 * The app's messages to office agents (office.mjs): the token goes only to
 * the office, in the bearer header, and never into an error, whatever the
 * office or the network answers (Video Reviewer 2's probe, 2026-10-28).
 */
import { describe, expect, test } from "bun:test";
import { appMessenger, DIRECTOR_AGENT_ID, OFFICE } from "./office.mjs";

const TOKEN = "tok-SECRET-123";

/** A stand-in for the office: the answer to each request. */
type Office = () => Promise<Response>;

/** The error that `send` throws with this office, as a text. */
const errorWith = async (office: Office) => {
  const send = appMessenger({
    env: { ISOMUX_APP_TOKEN: TOKEN },
    fetch: office as unknown as typeof globalThis.fetch,
  });
  try {
    await send("agent-x", "hi");
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("send did not throw");
};

const answer =
  (body: string, status: number): Office =>
  () =>
    Promise.resolve(new Response(body, { status }));

describe("appMessenger", () => {
  test("no answer from the office ever puts the token in the error", async () => {
    const cases: [Office, string][] = [
      // A body that echoes the token: only a plain error code is kept.
      [
        answer(JSON.stringify({ error: `bad token ${TOKEN}` }), 401),
        "the office refused the message: HTTP 401",
      ],
      [
        answer(JSON.stringify({ error: "recipient_not_found" }), 404),
        "the office refused the message: HTTP 404 recipient_not_found",
      ],
      [
        answer(`<html>${TOKEN}</html>`, 500),
        "the office refused the message: HTTP 500",
      ],
      [
        () => {
          const err = new Error(`connect to ${TOKEN}`, {
            cause: { code: "ECONNREFUSED" },
          });
          return Promise.reject(err);
        },
        "the office did not answer (ECONNREFUSED)",
      ],
      [
        () => Promise.reject(new TypeError(`fetch failed ${TOKEN}`)),
        "the office did not answer (TypeError)",
      ],
    ];
    for (const [office, message] of cases) {
      const got = await errorWith(office);
      expect(got).toBe(message);
      expect(got).not.toContain(TOKEN);
    }
  });

  test("a message goes to the office with the bearer token; the Director's names no target", async () => {
    const seen: { url: string; auth: string; body: unknown }[] = [];
    const fetch = ((url: string, init: RequestInit) => {
      seen.push({
        url,
        auth: (init.headers as Record<string, string>).authorization,
        body: JSON.parse(init.body as string),
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const send = appMessenger({ env: { ISOMUX_APP_TOKEN: TOKEN }, fetch });
    await send("agent-x", "hello");
    // The app's own agent is the Director: the office's default target.
    await send(DIRECTOR_AGENT_ID, "REVIEW: ...");
    expect(seen).toEqual([
      {
        url: `${OFFICE}/api/app/message`,
        auth: `Bearer ${TOKEN}`,
        body: { text: "hello", targetAgentId: "agent-x" },
      },
      {
        url: `${OFFICE}/api/app/message`,
        auth: `Bearer ${TOKEN}`,
        body: { text: "REVIEW: ..." },
      },
    ]);
  });

  test("no token: nothing is sent", async () => {
    let called = false;
    const send = appMessenger({
      env: {},
      fetch: (() => {
        called = true;
        return Promise.resolve(new Response("{}"));
      }) as unknown as typeof globalThis.fetch,
    });
    let message = "";
    await send("agent-x", "hi").catch((err: Error) => (message = err.message));
    expect(message).toBe("the app has no ISOMUX_APP_TOKEN");
    expect(called).toBe(false);
  });
});
