/**
 * The platform tokens that /daily/connect stores (connect.mjs), one file for
 * each platform: <data>/daily/tokens/<platform>.json, mode 0600, in a 0700
 * directory. This is the only place a token lives. No secret seeds it, and no
 * token is read from the environment (Wall Game PM, 2026-10-26: one flow).
 *
 * A record holds what the platform gave at connect time and what the posters
 * renew later. Only the fields in PUBLIC_FIELDS may leave this module for a
 * page or a log; `status` gives exactly those.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{
 *   connectedAt: string,
 *   connectedBy: string,
 *   scopes: string[],
 *   account: { id: string | null, name: string | null },
 *   accessToken?: string,
 *   accessExpiresAt?: string | null,
 *   refreshToken?: string,
 *   refreshExpiresAt?: string | null,
 *   refreshedAt?: string | null,
 *   triedAt?: string | null,
 * }} TokenRecord
 */

/** What a page may show of a record. No token, ever. */
export const PUBLIC_FIELDS = [
  "connectedAt",
  "connectedBy",
  "scopes",
  "account",
  "accessExpiresAt",
  "refreshExpiresAt",
  "refreshedAt",
];

export const openTokenStore = (dir) => {
  const path = (platform) => join(dir, `${platform}.json`);

  /** @returns {TokenRecord | null} */
  const read = (platform) => {
    if (!existsSync(path(platform))) return null;
    try {
      return JSON.parse(readFileSync(path(platform), "utf8"));
    } catch {
      // Never quote the file: it holds tokens.
      throw new Error(
        `the ${platform} token file cannot be read: connect ${platform} again on /daily/connect`,
      );
    }
  };

  /** @param {TokenRecord} record */
  const write = (platform, record) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const part = `${path(platform)}.part`;
    writeFileSync(part, JSON.stringify(record), { mode: 0o600 });
    // `mode` applies only when the file is new; a .part left by a crash
    // keeps its old mode, so set it again.
    chmodSync(part, 0o600);
    renameSync(part, path(platform));
  };

  return {
    read,
    write,
    /** Change some fields of a connected platform. */
    update(platform, patch) {
      const record = read(platform);
      if (!record) throw new Error(`${platform} is not connected`);
      write(platform, { ...record, ...patch });
    },
    /** True only for a record that Connect wrote. */
    connected: (platform) => {
      try {
        return typeof read(platform)?.connectedAt === "string";
      } catch {
        return false;
      }
    },
    /**
     * The record without its tokens, or {error} if the file is unreadable or
     * Connect did not write it (the same test as `connected`).
     */
    status(platform) {
      let record;
      try {
        record = read(platform);
      } catch (err) {
        return { error: String(err?.message ?? err) };
      }
      if (!record) return null;
      // The removed seed stores used these same file names
      // ({seedSha256, refreshToken, savedAt} and {seedSha256, token, ...}).
      if (typeof record.connectedAt !== "string") {
        return {
          error: `the ${platform} token file is from before Connect: connect ${platform} again on /daily/connect`,
        };
      }
      return Object.fromEntries(
        PUBLIC_FIELDS.filter((k) => k in record).map((k) => [k, record[k]]),
      );
    },
  };
};
