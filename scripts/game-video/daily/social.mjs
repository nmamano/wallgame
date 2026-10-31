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
import { CHECKPOINTS, checkpointAt } from "./post-stats.mjs";

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

const pt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
/**
 * "2026-10-31T16:00:00.000Z" -> "Oct 31, 9:00 AM PT": Nil lives on the US
 * west coast (Wall Game PM, 2026-10-31). A value with no time of day (a
 * date only, "2026-10-30") stays as it is.
 */
export const ptMinute = (iso) => {
  const ms = /T\d\d:\d\d/.test(String(iso)) ? Date.parse(iso) : NaN;
  return Number.isNaN(ms)
    ? String(iso)
    : `${pt.format(ms).replace(/\s/g, " ")} PT`;
};

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
  /**
   * Append today's count of each platform that has one, read today, and no
   * row today. A cached count read on an earlier day (X is cached 24 h)
   * writes no row: its day would be wrong (VR1, review 89 N1).
   */
  const record = (counts, nowMs = Date.now()) => {
    if (!counts) return;
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const have = new Set(
      read()
        .filter((r) => r.day === day)
        .map((r) => r.platform),
    );
    for (const [platform, c] of Object.entries(counts)) {
      if (
        typeof c?.followers === "number" &&
        String(c.at).slice(0, 10) === day &&
        !have.has(platform)
      ) {
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

/** The sum of the numbers that are there, or null when none is. */
const sumOf = (xs) => {
  const have = xs.filter((x) => typeof x === "number");
  return have.length ? have.reduce((a, b) => a + b, 0) : null;
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
  const weekAgo = Object.entries(counts).map(([p, c]) =>
    typeof c.followers === "number" ? ago(p, 7) : undefined,
  );
  return {
    // All accounts together, for the stats tracker's headline: now, and
    // the change in 7 days over the accounts that have a count both times.
    total: {
      now: sumOf(Object.values(counts).map((c) => c.followers)),
      week: sumOf(
        Object.values(counts).map((c, i) =>
          typeof c.followers === "number" && typeof weekAgo[i] === "number"
            ? c.followers - weekAgo[i]
            : null,
        ),
      ),
    },
    rows: Object.entries(counts).map(([p, c]) => ({
      platform: names[p] ?? p,
      now: c.followers ?? "-",
      day: delta(c.followers, ago(p, 1)),
      week: delta(c.followers, ago(p, 7)),
      note: c.error ?? "",
    })),
    note: `Counts cached 1 h (X: 24 h). History: one count a day${first ? ` since ${first}` : ""}.`,
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
        v: l ? ptMinute(l.utc) : "none yet",
        href: l ? https(l.url) : null,
      },
      { k: "Last dry run", v: d ? ptMinute(d.utc) : "none" },
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
    updated: ptMinute(data.updated),
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

const METRICS = /** @type {const} */ (["views", "likes", "comments", "shares"]);

/**
 * @typedef {{ day: string, key: string, views: number | null,
 *   likes: number | null, comments: number | null, shares: number | null,
 *   at: string }} PostStatsRow
 */

/**
 * The per-post history (post-stats.mjs): one row {day, key, views, likes,
 * comments, shares, at} per post per UTC day, the first numbers read that
 * day, in a JSONL file, as the follower history. `key` is
 * "<platform> <postId>".
 */
export const createPostStatsHistory = (path) => {
  /** @returns {PostStatsRow[]} */
  const read = () =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  /** Append today's numbers of each post read today with no row today. */
  const record = (numbers, nowMs = Date.now()) => {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const have = new Set(
      read()
        .filter((r) => r.day === day)
        .map((r) => r.key),
    );
    for (const [key, n] of Object.entries(numbers ?? {})) {
      if (String(n.at).slice(0, 10) !== day || have.has(key)) continue;
      const row = { day, key };
      for (const m of METRICS) row[m] = n[m] ?? null;
      appendFileSync(path, JSON.stringify({ ...row, at: n.at }) + "\n");
    }
  };
  return { read, record };
};

/**
 * @typedef {{ key: string, checkpoint: string, views: number | null,
 *   likes: number | null, comments: number | null, shares: number | null,
 *   at: string }} CheckpointRow
 */

/**
 * Each post's numbers at each checkpoint (post-stats.mjs CHECKPOINTS: 1 h,
 * 24 h, 7 d, ...): one row per post per checkpoint, the first numbers read
 * after the post passed it, in a JSONL file. `at` says when they were read.
 * @param {string} path
 */
export const createPostCheckpoints = (path) => {
  /** @returns {CheckpointRow[]} */
  const read = () =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  /**
   * @param {Record<string, any>} numbers keyed "<platform> <postId>"
   * @param {{ platform: string, postId: string, utc: string }[]} posts
   */
  const record = (numbers, posts) => {
    const have = new Set(read().map((r) => `${r.key}|${r.checkpoint}`));
    const utcOf = new Map(
      posts.map((p) => [`${p.platform} ${p.postId}`, p.utc]),
    );
    for (const [key, n] of Object.entries(numbers ?? {})) {
      const posted = Date.parse(utcOf.get(key) ?? "");
      const c = checkpointAt(Date.parse(n.at) - posted);
      if (!c || have.has(`${key}|${c.label}`)) continue;
      const row = { key, checkpoint: c.label };
      for (const m of METRICS) row[m] = n[m] ?? null;
      appendFileSync(path, JSON.stringify({ ...row, at: n.at }) + "\n");
      have.add(`${key}|${c.label}`);
    }
  };
  return { read, record };
};

/**
 * @typedef {{ views: number | null, likes: number | null,
 *   comments: number | null, shares: number | null }} PostNumbers
 */

/**
 * A video's name from its post text: the first line, up to " · " (the
 * sounds credit), without hashtags; null when nothing is left.
 * @param {string | null | undefined} caption
 */
export const videoName = (caption) => {
  const line = String(caption ?? "")
    .split("\n")[0]
    .split(" · ")[0]
    .replace(/#\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // By code point, so a cut never splits an emoji (VR1, review 119).
  const chars = [...line];
  return line
    ? chars.length > 80
      ? `${chars.slice(0, 79).join("")}…`
      : line
    : null;
};

/**
 * The stats tracker's per-post view (Nil, 2026-10-31): each posted video,
 * most recent first, with one row per platform (its link and numbers) and
 * its total; each platform's totals and their change over 1 and 7 days,
 * from the history.
 * @param {{ posts: any[], numbers: Record<string, any>, reads: Record<string, any>,
 *   history: PostStatsRow[], checkpoints: CheckpointRow[],
 *   names: Record<string, string>, nowMs: number, platforms: string[],
 *   note: string }} input
 */
export const postStatsView = ({
  posts,
  numbers,
  reads,
  history,
  checkpoints,
  names,
  nowMs,
  platforms,
  note,
}) => {
  const keyOf = (p) => `${p.platform} ${p.postId}`;
  /** @returns {PostNumbers} */
  const totals = (rows) => ({
    views: sumOf(rows.map((r) => r?.views)),
    likes: sumOf(rows.map((r) => r?.likes)),
    comments: sumOf(rows.map((r) => r?.comments)),
    shares: sumOf(rows.map((r) => r?.shares)),
  });
  // A platform's read error is in its row of "Posts by platform"; a
  // video's row only points there.
  const noteOf = (p) => {
    const n = numbers[keyOf(p)];
    if (n?.note) return n.note;
    if (n) return "";
    return reads[p.platform]?.error
      ? "no numbers: see Posts by platform"
      : "not read yet";
  };
  // A post's views at 1 h, 24 h and 7 d (its likes where it has no
  // views): "12 / 140 / -", so posts compare at the same age.
  const AGES = CHECKPOINTS.slice(0, 3).map((c) => c.label);
  const agesOf = (p) => {
    const rows = checkpoints.filter((r) => r.key === keyOf(p));
    const m = rows.some((r) => typeof r.views === "number") ? "views" : "likes";
    const at = (label) => rows.find((r) => r.checkpoint === label)?.[m];
    const text = AGES.map((label) => {
      const v = at(label);
      return typeof v === "number" ? v.toLocaleString("en-US") : "-";
    }).join(" / ");
    return rows.length && m === "likes" ? `${text} likes` : text;
  };
  const order = (p) => {
    const i = platforms.indexOf(p.platform);
    return i === -1 ? platforms.length : i;
  };
  // One video per item. A post from before items had ids (2026-10-28) goes
  // with the posts of the same video file, named by its game.
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const p of posts) {
    const id = p.itemId ?? p.videoSha256 ?? `${p.day} ${p.platform}`;
    groups.set(id, [...(groups.get(id) ?? []), p]);
  }
  const videos = [...groups.values()]
    .map((ps) => {
      /** @type {string} */
      const itemId =
        ps[0].itemId ?? (ps[0].gameId ? `game ${ps[0].gameId}` : ps[0].day);
      const caption =
        ps.find((p) => p.platform === "youtube")?.caption ??
        ps.find((p) => p.caption)?.caption;
      const rows = [...ps]
        .sort((a, b) => order(a) - order(b))
        .map((p) => ({
          // A post read without the insights permission has likes and
          // comments but no views (post-stats.mjs fallback, VR1 review 119
          // N1): its name says so, on a phone too.
          platform:
            (names[p.platform] ?? p.platform) +
            (numbers[keyOf(p)]?.note ? " (no views)" : ""),
          href: https(p.url),
          ...totals([numbers[keyOf(p)]]),
          at: numbers[keyOf(p)]?.at ?? null,
          ages: agesOf(p),
          note: noteOf(p),
        }));
      return {
        itemId,
        name: videoName(caption) ?? itemId,
        postedAt: ps.map((p) => p.utc).sort()[0],
        posted: ptMinute(ps.map((p) => p.utc).sort()[0]),
        rows,
        total: totals(rows),
      };
    })
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

  /**
   * The change of a platform's views and likes since the end of `days` ago,
   * over the posts that have a value now: a post's last row on or before
   * that day, or 0 for a post made after it. A post with neither is left
   * out of both sides. Views and likes only, so the line stays short.
   * @returns {{ views: number | null, likes: number | null }}
   */
  const change = (platform, days) => {
    const d = new Date(nowMs - days * 864e5).toISOString().slice(0, 10);
    /** @type {{ views: number | null, likes: number | null }} */
    const out = { views: null, likes: null };
    for (const m of /** @type {const} */ (["views", "likes"])) {
      let now = 0;
      let then = 0;
      let any = false;
      for (const p of posts.filter((q) => q.platform === platform)) {
        const v = numbers[keyOf(p)]?.[m];
        if (typeof v !== "number") continue;
        const before =
          p.utc.slice(0, 10) > d
            ? 0
            : history.filter((r) => r.key === keyOf(p) && r.day <= d).at(-1)?.[
                m
              ];
        if (typeof before !== "number") continue;
        now += v;
        then += before;
        any = true;
      }
      if (any) out[m] = now - then;
    }
    return out;
  };
  const signed = (n) => `${n >= 0 ? "+" : ""}${n.toLocaleString("en-US")}`;
  /** "+1,399 views, +58 likes", or "-" with no change to show. */
  const changeText = (c) =>
    [
      ...(c.views === null ? [] : [`${signed(c.views)} views`]),
      ...(c.likes === null ? [] : [`${signed(c.likes)} likes`]),
    ].join(", ") || "-";

  const platformRows = platforms.map((platform) => {
    const ps = posts.filter((p) => p.platform === platform);
    const t = totals(ps.map((p) => numbers[keyOf(p)]));
    const r = reads[platform];
    const week = change(platform, 7);
    return {
      platform: names[platform] ?? platform,
      posts: ps.length,
      ...t,
      day: changeText(change(platform, 1)),
      week: changeText(week),
      // The phone's short form: the views' change, or the likes' where the
      // platform gives no views.
      weekShort: changeText(
        week.views === null ? { ...week } : { views: week.views, likes: null },
      ),
      weekNumbers: week,
      // A read error; else a post's fallback note (no views: needs
      // reconnect); else when it was read.
      note:
        r?.error ??
        ps.map((p) => numbers[keyOf(p)]?.note).find(Boolean) ??
        (r ? `read ${ptMinute(r.at)}` : "not read yet"),
    };
  });
  const first = history[0]?.day;
  const readAt =
    Object.values(reads)
      .map((r) => r?.at)
      .filter((at) => typeof at === "string")
      .sort()
      .at(-1) ?? null;
  return {
    // The headline (Wall Game PM, 2026-10-31): the 7-day change of views
    // (each platform's own count, added: Growth warns they differ) and
    // likes, and the videos posted in 7 days.
    headline: {
      views: sumOf(platformRows.map((r) => r.weekNumbers.views)),
      likes: sumOf(platformRows.map((r) => r.weekNumbers.likes)),
      videos: videos.filter((v) => nowMs - Date.parse(v.postedAt) < 7 * 864e5)
        .length,
    },
    readAt: readAt && ptMinute(readAt),
    platforms: platformRows,
    total: totals(platformRows),
    videos,
    note: `${note} History: one row a day (UTC) per post${first ? ` since ${first}` : ""}. "-": the platform gives no such number.`,
  };
};
