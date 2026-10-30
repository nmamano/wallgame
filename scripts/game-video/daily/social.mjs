/**
 * The review page's "Social" tab (Nil, 2026-10-30: "can we merge the 2
 * apps, the one with the social connections and the feed?"): what the app
 * wallgame-social (~/nil/growth/tools/wallgame-social/server.mjs) showed,
 * moved into this app. Per platform: its status, account, login and
 * credentials holder, 2FA, how it posts, the poster's mode now and why,
 * the secret NAMES it needs, its last post and dry run, owners, profile
 * tune-up and next steps; the steps that need Nil; how the accounts work;
 * and the follower counts with their history.
 *
 * Sources, read on each request: Wall Game Growth's platforms.json (Growth
 * keeps it; this app only reads it), and this app's own state: the posting
 * modes, the post logs and the follower counts. No secret value is read or
 * shown, only secret names.
 *
 * socialView builds a plain view model; the page draws it as text
 * (review.mjs: no innerHTML), and a link only to an https address.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How often the app records the follower history with no visitor: 1 h. */
export const FOLLOWER_RECORD_MS = 60 * 60 * 1000;

/** Wall Game Growth's platform file (Growth keeps it). */
export const PLATFORMS_FILE = join(
  homedir(),
  "nil/growth/data/wallgame/platforms.json",
);

/** Each status as shown: its label and its colour. */
const STATUS = {
  live: ["Live", "#1a7f37"],
  ready: ["Keys missing", "#9a6700"],
  setup: ["Setup in progress", "#0969da"],
  blocked: ["Blocked", "#cf222e"],
  skipped: ["Skipped", "#6e7781"],
};

/** The status shown: the file's, but "live" when the app posts live. */
const effective = (p, mode) =>
  p.status === "skipped" ? "skipped" : mode === "live" ? "live" : p.status;

const lastBy = (rows, id) => rows.filter((r) => r.platform === id).at(-1);

/** "2026-10-30T09:16:00.000Z" -> "2026-10-30 09:16 UTC". */
const utcMinute = (iso) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** @typedef {{ day: string, platform: string, followers: number, at: string }} FollowerRow */
/** @typedef {{ k: string, v: string, href?: string | null, codes?: string[] }} SocialRow */
/**
 * @typedef {{ id: string, name: string, status: { label: string, color: string },
 *   rows: SocialRow[], profile: { k: string, v: string, tone: string }[],
 *   next: { who: string, what: string, nil: boolean }[], asks: string[] }} SocialCard
 */

/** An address the page may link to: https only. */
const https = (url) =>
  typeof url === "string" && /^https:\/\//.test(url) ? url : null;

/**
 * The follower history (Nil, 2026-10-28: "a dashboard tracking followers
 * on each platform"): one row {day, platform, followers, at} per platform
 * per UTC day, the first count read that day, in a JSONL file.
 */
export const createFollowerHistory = (path) => {
  /** @returns {FollowerRow[]} */
  const read = () =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  /** Append today's count of each platform that has one and no row today. */
  const record = (counts, nowMs = Date.now()) => {
    if (!counts) return;
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const have = new Set(
      read()
        .filter((r) => r.day === day)
        .map((r) => r.platform),
    );
    for (const [platform, c] of Object.entries(counts)) {
      if (typeof c?.followers === "number" && !have.has(platform)) {
        appendFileSync(
          path,
          JSON.stringify({ day, platform, followers: c.followers, at: c.at }) +
            "\n",
        );
      }
    }
  };
  return { read, record };
};

/**
 * The followers box: each platform's count now and its change over 1 and 7
 * days, from the history (the last row on or before that day).
 */
const followersBox = (counts, history, names, nowMs) => {
  if (!counts) return null;
  const ago = (platform, days) => {
    const d = new Date(nowMs - days * 864e5).toISOString().slice(0, 10);
    return history.filter((r) => r.platform === platform && r.day <= d).at(-1)
      ?.followers;
  };
  const delta = (now, then) =>
    typeof now === "number" && typeof then === "number"
      ? (now - then >= 0 ? "+" : "") + (now - then)
      : "-";
  const first = history[0]?.day;
  return {
    rows: Object.entries(counts).map(([p, c]) => ({
      platform: names[p] ?? p,
      now: c.followers ?? "-",
      day: delta(c.followers, ago(p, 1)),
      week: delta(c.followers, ago(p, 7)),
      note: c.error ?? "",
    })),
    note: `Counts cached 1 h. History: one count a day${first ? ` since ${first}` : ""}.`,
  };
};

/**
 * The Social tab's view model.
 * @param {{ data: any, modes: Record<string, string>, reasons: Record<string, string[]>, live: any[], dry: any[], followers: Record<string, any> | null, history: any[], nowMs: number }} input
 */
export const socialView = ({
  data,
  modes,
  reasons,
  live,
  dry,
  followers,
  history,
  nowMs,
}) => {
  /** @type {any[]} Growth's file: its shape is Growth's. */
  const ps = data.platforms;
  const counted = ps.filter((p) => p.status !== "skipped");
  const statusOf = (p) => effective(p, modes[p.id]);
  const nilSteps = ps.flatMap((p) =>
    (p.next ?? [])
      .filter((n) => n.nil)
      .map((n) => ({ platform: p.name, what: n.what, asks: p.asks ?? [] })),
  );
  /** @returns {SocialCard} */
  const card = (p) => {
    const st = statusOf(p);
    const [label, color] = STATUS[st] ?? [st, "#6e7781"];
    const l = lastBy(live, p.id);
    const d = lastBy(dry, p.id);
    const mode = modes[p.id];
    /** @type {{ k: string, v: string, href?: string | null, codes?: string[] }[]} */
    const rows = [
      { k: "Account", v: p.handle ?? "", href: https(p.url) },
      { k: "Login", v: p.login ?? "" },
      { k: "Password / credentials", v: p.credentials ?? "" },
      { k: "2FA", v: p.twoFactor ?? "" },
      { k: "How it posts", v: p.publish ?? "" },
      {
        k: "Poster mode now",
        v: !mode
          ? "unknown"
          : mode === "dry-run"
            ? `dry-run (nothing is posted: ${(reasons[p.id] ?? ["reason unknown"]).join("; ")})`
            : mode,
      },
      {
        k: "Keys (secret names on the game-video app)",
        v: (p.keys ?? []).length ? "" : "-",
        codes: p.keys ?? [],
      },
      { k: "Profile link", v: p.profileLink ?? "" },
      {
        k: "Last post",
        v: l ? utcMinute(l.utc) : "none yet",
        href: l ? https(l.url) : null,
      },
      { k: "Last dry run", v: d ? utcMinute(d.utc) : "none" },
      {
        k: "Owners",
        v: Object.entries(p.owners ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
      },
      ...(p.blockedBy ? [{ k: "Blocked by", v: p.blockedBy }] : []),
      ...(p.notes ? [{ k: "Notes", v: p.notes }] : []),
    ];
    return {
      id: p.id,
      name: p.name,
      status: { label, color },
      rows,
      profile: Object.entries(p.profile ?? {}).map(([k, v]) => ({
        k,
        v: String(v),
        tone: String(v).startsWith("ok")
          ? "ok"
          : String(v).startsWith("n/a")
            ? "muted"
            : "todo",
      })),
      next: (p.next ?? []).map((n) => ({
        who: n.who,
        what: n.what,
        nil: !!n.nil,
      })),
      asks: p.asks ?? [],
    };
  };
  const count = (s) => counted.filter((p) => statusOf(p) === s).length;
  return {
    updated: data.updated,
    updatedBy: data.updatedBy,
    stats: [
      {
        value: `${counted.filter((p) => modes[p.id] === "live").length} / ${counted.length}`,
        label: "platforms posting live",
      },
      { value: String(count("setup")), label: "in setup" },
      { value: String(count("blocked")), label: "blocked" },
      { value: String(nilSteps.length), label: "steps that need Nil" },
    ],
    followers: followersBox(
      followers,
      history,
      Object.fromEntries(ps.map((p) => [p.id, p.name])),
      nowMs,
    ),
    nilSteps,
    flow: data.flow,
    root: data.root,
    roles: data.roles,
    cards: ps.map(card),
    brand: data.brand ?? null,
    later: data.later,
    log: data.log,
  };
};
