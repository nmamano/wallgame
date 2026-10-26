/**
 * The `state` of each Connect click on /daily/connect (connect.mjs). The
 * authorize URL carries it; the platform sends it back to the callback with
 * the code. A state is random (256 bits), works once, for 10 minutes, for
 * the platform it was made for and for the member who clicked. So a callback
 * that nobody here started, or a replay of an old one, is refused.
 *
 * States live in memory only: an app restart drops them, and a Connect that
 * was under way must be clicked again.
 */
import { createHash, randomBytes } from "node:crypto";

export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** A refusal whose message is safe to show: it holds no code and no token. */
export class ConnectRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ConnectRefused";
  }
}

/** The PKCE S256 challenge of `verifier` (RFC 7636 4.2). */
export const s256 = (verifier) =>
  createHash("sha256").update(verifier).digest("base64url");

export const connectStates = ({ now = () => Date.now() } = {}) => {
  /** @type {Map<string, {platform: string, memberId: string, verifier: string, createdAt: number, usedAt: number | null}>} */
  const states = new Map();
  const forget = () => {
    for (const [state, s] of states) {
      if (now() - s.createdAt > STATE_MAX_AGE_MS) states.delete(state);
    }
  };
  return {
    /**
     * A new state for `platform`, started by `memberId`. `verifier` is the
     * PKCE code verifier (RFC 7636: 43 to 128 characters; 64 here).
     */
    create(platform, memberId) {
      forget();
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(48).toString("base64url");
      states.set(state, {
        platform,
        memberId,
        verifier,
        createdAt: now(),
        usedAt: null,
      });
      return { state, verifier };
    },
    /** The state's record, used up; or ConnectRefused. */
    take(state, platform, memberId) {
      const s = typeof state === "string" ? states.get(state) : undefined;
      if (!s) {
        throw new ConnectRefused(
          "this Connect link is unknown or more than 10 minutes old: click Connect again",
        );
      }
      if (s.usedAt !== null) {
        throw new ConnectRefused(
          "this Connect link was already used: click Connect again",
        );
      }
      if (now() - s.createdAt > STATE_MAX_AGE_MS) {
        states.delete(state);
        throw new ConnectRefused(
          "this Connect link is more than 10 minutes old: click Connect again",
        );
      }
      if (s.platform !== platform) {
        throw new ConnectRefused(
          `this Connect link was made for ${s.platform}, not ${platform}`,
        );
      }
      if (s.memberId !== memberId) {
        throw new ConnectRefused(
          "this Connect link was started by another member: click Connect yourself",
        );
      }
      // Kept (as used) until it is old, so a replay gets the clear message.
      s.usedAt = now();
      return { verifier: s.verifier };
    },
  };
};
