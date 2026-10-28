/**
 * The app's own messages to office agents (the Isomux apps reference): POST
 * /api/app/message on the office with the app's token, from the server
 * only. With no `targetAgentId` the office sends to the app's own agent,
 * which for this app is the Wall Game Director that made it (GET
 * /api/apps: createdByAgentId). With `targetAgentId` it also checks that
 * the app's owner has a live agent that may reach the target, and refuses
 * (403) otherwise (isomux server/routes/handlers/apps.ts). So a message to
 * the Director names no target: it arrives even when that check fails
 * (Video Reviewer 2, 2026-10-28).
 *
 * The token never leaves this process: it is read from the environment
 * that the office gives the app, sent only to the office on this box, and
 * never in a reply, a page or a log line.
 */

/** The office on this box; apps reach it directly, as crew.mjs does. */
export const OFFICE = "http://127.0.0.1:4000";

/** The Wall Game Director: it owns the daily videos and reads Nil's notes. */
export const DIRECTOR_AGENT_ID = "agent-1792978164138-sta1";

/**
 * A sender of agent messages: `send(targetAgentId, text)` resolves when the
 * office took the message and throws (an Error with no token in it) when
 * it did not.
 * @param {{ env: Record<string, string | undefined>,
 *   fetch?: typeof globalThis.fetch }} deps
 */
export const appMessenger = ({ env, fetch = globalThis.fetch }) => {
  return async (targetAgentId, text) => {
    const token = env.ISOMUX_APP_TOKEN;
    if (!token) throw new Error("the app has no ISOMUX_APP_TOKEN");
    let res;
    try {
      res = await fetch(`${OFFICE}/api/app/message`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          targetAgentId === DIRECTOR_AGENT_ID
            ? { text }
            : { text, targetAgentId },
        ),
      });
    } catch (err) {
      throw new Error(
        `the office did not answer (${err?.cause?.code ?? err?.name ?? "error"})`,
      );
    }
    if (!res.ok) {
      // The office's error code only: its body could echo the request.
      let code = "";
      try {
        code = String((await res.json())?.error ?? "");
      } catch {
        /* no JSON */
      }
      throw new Error(
        `the office refused the message: HTTP ${res.status}${/^[\w.-]{1,64}$/.test(code) ? ` ${code}` : ""}`,
      );
    }
  };
};
