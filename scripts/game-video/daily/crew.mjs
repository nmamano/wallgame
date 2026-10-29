/**
 * The crew lead's commands for the daily videos. Each video is an item
 * (store.mjs): a game, an edit list, a render, a check and Growth's copy
 * block. A finished item with a fresh block goes to Nil's review on the
 * app's /review page; an approved item posts at the next slot. Each command
 * is a step in routes.mjs; the app keeps the record and refuses a step out
 * of order, so a session that starts cold can run `status` and go on.
 *
 *   node scripts/game-video/daily/crew.mjs <command> [options]
 *
 * Every production command names its item with --item <id> (v-<day>-<n>).
 *
 *   status [--item ID]             every item in work, by state, with the
 *                                  counts; with --item, that one item
 *                                  (whatever its state)
 *   feedback [--last N]            Nil's last N review actions (default 10),
 *                                  with his notes, verbatim. Read it before
 *                                  you direct
 *   facts --report F [--top N]     the candidates' facts, to write the on-video
 *                                  caption from
 *   pick --report F [--rank N | --game ID] [--style S]
 *                                  a new item: a game by rank in report F,
 *                                  or by id (--game) from any day's report.
 *                                  Prints its id. No post text: Wall Game
 *                                  Growth writes it (copy)
 *   pick --from ID [--style S]     a new item with the game of item ID, which
 *                                  Nil discarded: carry-over. A game posts
 *                                  once: pick refuses a game with an item
 *                                  approved, posting, posted or post-failed,
 *                                  and names one in work or in review
 *   storyboard --item ID [--edl F] one image of every position of the item's
 *                                  game (scripts/game-video/storyboard.ts, on
 *                                  this box: no 4090, no view of the game).
 *                                  Open it before you write the edit list.
 *                                  With --edl, it checks the list against the
 *                                  game and marks each event on its ply.
 *   sounds                         the meme sounds by family, with Nil's
 *                                  preference: best, ok or disliked, which he
 *                                  sets by ear on the app's /daily/sounds
 *                                  page. Prefer best, then ok; `direct`
 *                                  allows a disliked one and names it. A
 *                                  sound with a high claim risk is listed
 *                                  last, and `direct` refuses it
 *   direct --item ID --edl F [--claim-risk-ok K,K]
 *                                  the director's edit decision list for the
 *                                  item's game (scripts/game-video/edl.mjs);
 *                                  `status` names the default ending.
 *                                  --claim-risk-ok accepts those sounds with
 *                                  a high claim risk on purpose (only when
 *                                  Nil asks for one). A finished item goes
 *                                  back to draft
 *   render --item ID [--wait] [--force] [--live]
 *                                  a 4090 render of the item's list; --wait
 *                                  polls until it ends. When the 4090 has the
 *                                  game's capture the render reads it: no
 *                                  view. Otherwise (or with --live) it
 *                                  captures live, which adds one view to the
 *                                  real game, so a second live render of a
 *                                  game the same UTC day needs --force. Use
 *                                  --live when the renderer cannot use the
 *                                  capture (its line says so).
 *   preview --item ID --plies FROM..TO [--edl F]
 *                                  a few seconds of the video: those plies of
 *                                  the item's edit list (or of F, a list for
 *                                  its game), rendered on the 4090 from the
 *                                  game's capture, so no view. It needs the
 *                                  game's first render (which saves the
 *                                  capture). Prints the MP4's path. A preview
 *                                  changes nothing in the item and can never
 *                                  be checked, reviewed or posted. For the
 *                                  PICTURE only: its music starts at its first
 *                                  frame
 *   sheet --item ID                the contact sheet's path and its stills, in
 *                                  order: look at the PNG before `check`.
 *                                  Also the event strips (strips.mjs): each
 *                                  event's sounds against its move's
 *                                  landing, and a PNG of four frames per
 *                                  event (in /tmp/daily-strips)
 *   check --item ID --sheet SHA --verdicts F
 *                                  the director's verdict on each still, as
 *                                  [{"ply","kind","ok","note"}]: ok only when
 *                                  the still shows what the cue is for (a FAHHH
 *                                  or zoom shows the save wall). Every still
 *                                  ok (and every measure) finishes the item
 *   vet --item ID --video SHA --reviewer "<who>" --verdict pass|fail
 *       (--notes "<text>" | --notes-file F)
 *                                  the independent review of the item's
 *                                  FINAL video, after its check passed: a
 *                                  fresh reviewer that did not make it
 *                                  (Wall Game Director, 2026-10-28). SHA is
 *                                  the video the reviewer watched (the
 *                                  current one). `copy` refuses the item
 *                                  until the latest vet of its current
 *                                  video passes. Prints the record with the
 *                                  video's length and its effect and
 *                                  overlay counts. Sends no message
 *   copy --item ID --file F --copy-version V
 *                                  (Wall Game Growth) the copy block for the
 *                                  item's video: one line per platform, each
 *                                  the exact text that posts (copy.mjs). V
 *                                  names Growth's copy style (e.g.
 *                                  growth-copy-1). The block is for the
 *                                  item's current video: a render that makes
 *                                  other bytes leaves it stale. A new block
 *                                  replaces the old until Nil approves
 *   drop --item ID --why "<reason>"
 *                                  stop an item Nil has not reviewed (a game
 *                                  that does not make a video): discarded,
 *                                  with your reason
 *   queue --review-target N        (Growth or the director) how many items
 *                                  Growth wants in review (Growth,
 *                                  2026-10-28: 3, growing to 10); the
 *                                  review page and `status` show it
 *   post --item ID [--confirm-not-posted x,bluesky]
 *                                  (Growth) retry a post-failed item after
 *                                  the cause is fixed: only the platforms of
 *                                  its slot that did not post. A platform
 *                                  whose post may exist needs a check of the
 *                                  account, then --confirm-not-posted. Slots
 *                                  post approved items on their own; a retry
 *                                  uses no slot
 *   log [--dry-run]                the post log
 *   auth-check --platform x|instagram
 *                                  READ-ONLY: does the platform accept the
 *                                  app's credentials? X: the key pair alone
 *                                  (status only), yes/no facts on each
 *                                  key's shape, then GET /2/users/me with
 *                                  the connected account (handle, access
 *                                  level). Instagram: the account a post
 *                                  would go to. Posts nothing and prints
 *                                  no secret value
 *   ship --to <hash>               release a commit that is on main: run
 *                                  from the release checkout, it moves that
 *                                  checkout to <hash>, syncs and checks the
 *                                  4090 kit and restarts the app
 *                                  (daily/ship.mjs), stopping at the first
 *                                  failure. It never pushes or merges
 *
 * The app is found through the office's app registry (name game-video), or
 * given with --app http://127.0.0.1:<port>.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateFromReport } from "./candidate.mjs";
import { dailySeatColors } from "../edl.mjs";
import { ship } from "./ship.mjs";
import { stripPlan, writeStrips } from "./strips.mjs";
import { copyLines } from "./copy.mjs";
import { quoteLines } from "./quote.mjs";
import { noStoryLine } from "./post-instagram.mjs";

const OFFICE = "http://localhost:4000";
const STORYBOARD = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../storyboard.ts",
);
/** By full path, as nightly-candidates.sh: a unit's PATH has no bun. */
const BUN = join(homedir(), ".bun/bin/bun");
/** About 40 times the 3 s of a 27-ply storyboard (2026-10-26). */
const STORYBOARD_TIMEOUT_MS = 120_000;
const APP_NAME = "game-video";

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const has = (name) => argv.includes(`--${name}`);

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const office = async (method, path, { body, type } = {}) => {
  const token = process.env.ISOMUX_AGENT_TOKEN;
  if (!token) die("ISOMUX_AGENT_TOKEN is not set; run this as an Isomux agent");
  const res = await fetch(`${OFFICE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(type && { "content-type": type }),
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const appBase = async () => {
  if (flag("app")) return flag("app");
  const { status, body } = await office("GET", `/api/apps/${APP_NAME}`);
  if (status !== 200) die(`cannot find the ${APP_NAME} app (HTTP ${status})`);
  return `http://127.0.0.1:${body.port}`;
};

const appTry = async (method, path, body) => {
  const res = await fetch(`${await appBase()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, json: await res.json() };
};

const app = async (method, path, body) => {
  const { ok, status, json } = await appTry(method, path, body);
  if (!ok) die(`${method} ${path}: ${json.error ?? status}`);
  return json;
};

/** The item a production command works on: --item <id>. */
const itemFlag = () =>
  flag("item") ??
  die("name the item: --item <id> (crew.mjs status lists them)");

/** One item, whatever its state. */
const itemNamed = (id) =>
  app("GET", `/api/daily/item?id=${encodeURIComponent(id)}`);

/**
 * The day's candidate report. The timer writes <day>.json, or <day>.skip with
 * the reason it found no candidates (nightly-candidates.sh).
 */
const readReport = (path) => {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const reportDay = basename(path).replace(/\.json$/, "");
  const skip = path.replace(/\.json$/, ".skip");
  if (skip !== path && existsSync(skip)) {
    die(`no candidates for ${reportDay}: ${readFileSync(skip, "utf8").trim()}`);
  }
  die(
    `no candidates for ${reportDay}: neither ${path} nor a .skip file exists`,
  );
};

/** The app's measures of a render (quality.mjs), one line each. */
const measureLines = (quality) =>
  Object.entries(quality ?? {}).map(
    ([name, m]) => `  measure ${name}: ${m.ok ? "ok" : "FAILED"} - ${m.note}`,
  );

/**
 * A warning when the video posts no Instagram Story (Wall Game Director,
 * 2026-10-29): the line Nil sees next to Approve. Not a measure: it does
 * not fail the check, and the video posts everywhere else.
 */
export const storyWarning = (video) => {
  const line = video && noStoryLine(video);
  return line ? [`  WARNING ${line}`] : [];
};

/** One item, in lines: its game, list, render, check, block and reviews. */
const itemLines = (k, progress = null) => {
  const g = k.candidate;
  const lines = [
    "",
    `ITEM ${k.id}: ${k.state}${k.reviewState ? ` (${k.reviewState})` : ""}, ${k.stage ?? ""}`,
    `game ${g.gameId}: ${g.seats.map((x) => x.name).join(" vs ")}, ${g.movesCount} plies`,
    ...g.facts,
    ...k.reviews.flatMap((r) => [
      `Nil ${r.action} at ${r.at}${r.notes ? ", notes verbatim:" : ""}`,
      ...(r.notes ? quoteLines(r.notes, "  ") : []),
    ]),
  ];
  if (k.edl) {
    lines.push(
      `edit list ${k.edl.sha256.slice(0, 12)}:`,
      ...k.edl.summary.map((l) => `  ${l}`),
    );
  } else {
    lines.push("no edit list yet");
  }
  if (k.render) {
    lines.push(
      k.render.error
        ? `render ${k.render.jobId}: FAILED ${k.render.error}`
        : k.render.video
          ? `render ${k.render.jobId}: ${k.render.video.path} (${k.render.video.bytes} bytes, sha256 ${k.render.video.sha256.slice(0, 12)}), sheet ${k.render.sheet.path}`
          : `render ${k.render.jobId}: running - ${progress ?? "queued"}`,
      ...measureLines(k.render.quality),
      ...storyWarning(k.render.video),
    );
  }
  if (k.check) {
    lines.push(
      `contact sheet check: ${k.check.ok ? "all ok" : "FAILED"}`,
      ...k.check.verdicts.map(
        (v) => `  ply ${v.ply} ${v.kind}: ${v.ok ? "ok" : "BAD"} - ${v.note}`,
      ),
    );
  }
  if (k.vet !== undefined && k.render?.video) {
    lines.push(
      k.vet
        ? `independent review: ${k.vet.verdict.toUpperCase()} by ${k.vet.reviewer} at ${k.vet.at} (video ${k.vet.videoSha256.slice(0, 12)})${k.vet.verdict === "pass" ? "" : " (copy refuses)"}`
        : `independent review: none for this video (copy refuses)`,
    );
  }
  lines.push(
    ...(k.copy
      ? [
          `copy block (${k.copy.block.version})${k.staleCopy ? `: STALE - ${k.staleCopy}` : ""}:`,
          ...copyLines(k.copy.block).map((l) => `  ${l}`),
        ]
      : ["no copy block from Wall Game Growth yet"]),
  );
  for (const [p, r] of Object.entries(k.posts)) {
    lines.push(
      `${p}: ${r.ok ? `${r.mode} ${r.postId} ${r.url}` : `FAILED ${r.error ?? "pending"}`}`,
    );
  }
  return lines;
};

const summary = (s) => {
  const c = s.counts;
  return [
    `modes ${Object.entries(s.modes)
      .map(([p, m]) => `${p}=${m}`)
      .join(" ")}`,
    `items: draft ${c.draft}, revise ${c.revise}, in review ${c.inReview} (target ${s.reviewTarget}), waiting for copy ${c.waitingCopy}, approved ${c.approved}, posting ${c.posting}, post failed ${c.postFailed}, posted ${c.posted}, discarded ${c.discarded}`,
    `default ending ${s.suggestedEnding}; last posted music ${s.lastMusic?.join(", ") ?? "none"}`,
    ...s.items.flatMap((k) => itemLines(k, k.renderProgress)),
  ].join("\n");
};

const state = () => app("GET", "/api/daily/state");

/** The state's line for one item: the items in work carry what is derived. */
const itemSummary = async (id) => {
  const s = await state();
  const k = s.items.find((x) => x.id === id) ?? (await itemNamed(id));
  return itemLines(k, k.renderProgress).join("\n");
};

/**
 * An item's latest vet, with what its notes can be checked against: the
 * video's length and how many of each effect kind and overlay asset the
 * edit list has (Wall Game Director, 2026-10-28).
 */
export const vetLines = (item) => {
  const v = item.vets.at(-1);
  const count = (keys) =>
    Object.entries(keys.reduce((n, k) => ({ ...n, [k]: (n[k] ?? 0) + 1 }), {}))
      .map(([k, n]) => `${k} ${n}`)
      .join(", ") || "none";
  const events = item.edl.doc.events;
  return [
    `${item.id}: vet ${v.verdict.toUpperCase()} by ${v.reviewer} at ${v.at}, video ${v.videoSha256.slice(0, 12)}`,
    `  video length: ${item.render.video.durationSeconds ?? "?"} s`,
    `  effects: ${count(events.filter((e) => e.kind !== "overlay").map((e) => e.kind))}`,
    `  overlays: ${count(events.filter((e) => e.kind === "overlay").map((e) => e.asset))}`,
    "  notes:",
    ...quoteLines(v.notes, "  "),
  ];
};

/**
 * One row of Nil's feedback, in lines: a review action, or (before the
 * review queue) his answer to a daily ask.
 */
export const feedbackLines = (r) =>
  r.itemId
    ? [
        `${r.itemId} (game ${r.gameId}): ${r.action} by ${r.by} at ${r.utc}, video ${String(r.videoSha256).slice(0, 12)}, edit list ${String(r.edlSha256).slice(0, 12)}`,
        ...(r.notes
          ? ["  notes, verbatim:", ...quoteLines(r.notes, "  ")]
          : ["  notes: (none)"]),
      ]
    : [
        `${r.day} ask ${r.askId}: ${r.picked ? `${r.picked} picked` : "none picked"} by ${r.approver} at ${r.utc}`,
        ...(r.recommended
          ? [`  you recommended ${r.recommended.label}: ${r.recommended.why}`]
          : []),
        ...r.offered.map(
          (o) =>
            `  ${o.label}: game ${o.gameId}, edit list ${String(o.edlSha256).slice(0, 12)}, video ${String(o.videoSha256).slice(0, 12)}, caption ${JSON.stringify(o.caption)}`,
        ),
        ...(r.reply === null
          ? ["  reply: (none)"]
          : ["  reply, verbatim:", ...quoteLines(r.reply, "  ")]),
      ];

const commands = {
  async status() {
    if (flag("item")) return console.log(await itemSummary(flag("item")));
    console.log(summary(await state()));
  },

  /**
   * Each family's moment and sounds: best, then ok, then disliked, then the
   * ones with a high claim risk (with their level). A source note (a claim
   * risk, a weaker source) follows its key in brackets.
   */
  async sounds() {
    const sounds = await app("GET", "/api/daily/sounds");
    for (const family of new Set(sounds.map((x) => x.family))) {
      const members = sounds.filter((x) => x.family === family);
      const names = (choice) =>
        members
          .filter((x) => x.choice === choice && !x.claimRisk)
          .map((x) => (x.note ? `${x.key} [${x.note}]` : x.key))
          .join(", ") || "-";
      const risky = members
        .filter((x) => x.claimRisk)
        .map((x) => `${x.key} (${x.choice}) [${x.note}]`);
      console.log(
        `${family} (${members[0].moment ?? "no moment"}): best ${names("best")}; ok ${names("ok")}; disliked ${names("disliked")}${risky.length ? `; claim risk, refused: ${risky.join(", ")}` : ""}`,
      );
    }
    for (const x of sounds.filter((s) => s.defaultFor)) {
      console.log(
        `${x.key} is the default on ${x.defaultFor}; name another with vsSound or finishSound in the list`,
      );
    }
  },

  /** The top candidates in plain words. Nothing here is posted. */
  facts() {
    const path = flag("report") ?? die("facts needs --report <file>");
    const report = readReport(path);
    const top = Number(flag("top") ?? 5);
    const count = Math.min(top, report.ranked?.length ?? 0);
    if (!count) die("the report ranks no game");
    console.log(
      "A caption calls the human bro and the AI the bot, never a player's name (Nil, 2026-10-26; the style is in DIRECTOR.md). Each seat's colour in the video follows its name.\n",
    );
    for (let rank = 1; rank <= count; rank++) {
      let c;
      try {
        c = candidateFromReport(report, rank);
      } catch (err) {
        console.log(`rank ${rank}: not usable - ${err.message}\n`);
        continue;
      }
      // The renderer's rule (dailySeatColors): an AI is red; two humans are
      // red for seat 1 and blue for seat 2. Two bots are never a candidate.
      const colors = dailySeatColors(
        Object.fromEntries(
          c.seats.map((s) => [s.playerOrder, s.kind === "official bot"]),
        ),
      );
      const colorName = (s) =>
        colors[s.playerOrder] === "red" ? "Red" : "Blue";
      console.log(
        `rank ${rank}: ${c.seats.map((s) => `${s.name} (${s.kind}, ${colorName(s)})`).join(" vs ")}, ${c.variant}, ${c.movesCount} plies`,
      );
      for (const f of c.facts) console.log(`  ${f}`);
      // For the edit list: 0-based plies, cells after the ply, and the walls
      // that caused the jump (marked *) in the notation a zoom frame takes.
      const walls = (ws) =>
        (ws ?? []).map((w) => `${w.notation}${w.cause ? "*" : ""}`).join(" ");
      for (const b of c.beats) {
        console.log(
          `  director, close call: danger ply ${b.danger.ply} (${b.hunter.type} ${b.danger.hunterCell}, ${b.prey.type} ${b.danger.preyCell}); ` +
            `save ply ${b.save.ply} walls ${walls(b.save.walls)} (walk ${b.save.walkBefore} to ${b.save.walk}; ${b.prey.type} ${b.save.preyCell} safe from this ply)`,
        );
      }
      for (const e of c.escapes) {
        console.log(
          `  director, escape ply ${e.ply} (${e.prey.type} ${e.preyFrom} -> ${e.preyCell}, walk ${e.walkBefore} to ${e.walk}; ${e.hunter.type} at ${e.hunterCell})`,
        );
      }
      for (const p of c.picks) {
        console.log(
          `  director, wall jump: ply ${p.ply} ${p.notation}, walls ${walls(p.walls)}`,
        );
      }
      console.log("");
    }
  },

  async pick() {
    if (has("caption") || has("title")) {
      die(
        "pick takes no --caption or --title: Wall Game Growth writes the post text (copy)",
      );
    }
    let item;
    if (flag("from")) {
      if (flag("report")) die("pick takes --report or --from, not both");
      item = await app("POST", "/api/daily/pick", {
        carriedFrom: flag("from"),
        style: flag("style"),
      });
    } else {
      const path =
        flag("report") ?? die("pick needs --report <file> (or --from <item>)");
      const report = readReport(path);
      const gameId = flag("game");
      if (gameId && flag("rank")) die("pick takes --rank or --game, not both");
      const rank = Number(flag("rank") ?? 1);
      // Send only the chosen entry: the full report holds every position's
      // score. --game takes a game by id, from any day's report.
      const slim = {
        kind: report.kind,
        createdAt: report.createdAt,
        ranked: gameId
          ? (report.ranked ?? []).filter((e) => e.gameId === gameId)
          : report.ranked?.slice(0, rank),
      };
      item = await app("POST", "/api/daily/pick", {
        report: slim,
        reportFile: basename(path),
        ...(gameId ? { gameId } : { rank }),
        style: flag("style"),
      });
    }
    console.log(`picked: ${item.id}`);
    for (const o of item.sameGame) {
      console.log(
        `NOTE: another video of this game is ${o.id} (${o.state}); only one of them can be approved`,
      );
    }
    console.log(await itemSummary(item.id));
  },

  /**
   * The director records the independent review of the item's final video:
   * who, pass or fail, and the notes. `copy` and review need a pass.
   */
  async vet() {
    const id = itemFlag();
    const videoSha256 =
      flag("video") ?? die("vet needs --video <sha256 of the MP4 reviewed>");
    const reviewer =
      flag("reviewer") ?? die('vet needs --reviewer "<who reviewed it>"');
    const verdict = flag("verdict") ?? die("vet needs --verdict pass|fail");
    const file = flag("notes-file");
    if (file && !existsSync(file)) die(`vet: no file ${resolve(file)}`);
    const notes =
      (file ? readFileSync(file, "utf8") : flag("notes")) ??
      die('vet needs --notes "<text>" or --notes-file <file>');
    const item = await app("POST", "/api/daily/vet", {
      item: id,
      videoSha256,
      reviewer,
      verdict,
      notes,
    });
    console.log(vetLines(item).join("\n"));
  },

  /** Run by Wall Game Growth: its copy block for an item's video. */
  async copy() {
    const id = itemFlag();
    const path = flag("file") ?? die("copy needs --file <the copy block>");
    const copyVersion =
      flag("copy-version") ??
      die(
        "copy needs --copy-version <Growth's copy style, e.g. growth-copy-1>",
      );
    if (!existsSync(path)) die(`copy: no file ${resolve(path)}`);
    await app("POST", "/api/daily/copy", {
      item: id,
      text: readFileSync(path, "utf8"),
      copyVersion,
    });
    console.log(await itemSummary(id));
  },

  async render() {
    const id = itemFlag();
    const { jobId } = await app("POST", "/api/daily/render", {
      item: id,
      force: has("force"),
      live: has("live"),
    });
    console.log(`render ${jobId} queued`);
    if (!has("wait")) return;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const k = await itemNamed(id);
      if (k.render?.jobId !== jobId || k.render.finishedAt) {
        return console.log(await itemSummary(id));
      }
    }
  },

  async preview() {
    const plies = flag("plies") ?? die("preview needs --plies FROM..TO");
    const path = flag("edl");
    const { previewId } = await app("POST", "/api/daily/preview", {
      item: itemFlag(),
      plies,
      ...(path && { edl: JSON.parse(readFileSync(path, "utf8")) }),
    });
    console.log(`preview ${previewId} queued`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const p = await app(
        "GET",
        `/api/daily/preview?id=${encodeURIComponent(previewId)}`,
      );
      if (p.state === "failed") die(`preview failed: ${p.error}`);
      if (p.state === "done") {
        return console.log(
          `preview of plies ${p.plies}: ${p.video.path} (${p.video.durationSeconds ?? "?"} s, ${(p.video.bytes / 1e6).toFixed(1)} MB). Not the item's video: the item did not change.`,
        );
      }
    }
  },

  async direct() {
    const id = itemFlag();
    const path = flag("edl") ?? die("direct needs --edl <edl.json>");
    await app("POST", "/api/daily/direct", {
      item: id,
      edl: JSON.parse(readFileSync(path, "utf8")),
      claimRiskOk: flag("claim-risk-ok")?.split(",") ?? [],
    });
    console.log(await itemSummary(id));
  },

  async queue() {
    const n = Number(flag("review-target"));
    if (!Number.isInteger(n)) die("queue needs --review-target <N>");
    const q = await app("POST", "/api/daily/queue", { reviewTarget: n });
    console.log(`review target: ${q.reviewTarget}`);
  },

  async post() {
    const id = itemFlag();
    const confirmNotPosted = flag("confirm-not-posted")?.split(",") ?? [];
    const r = await app("POST", "/api/daily/post", {
      itemId: id,
      confirmNotPosted,
    });
    console.log(`${id}: ${r.kind}`);
    for (const p of r.platforms) {
      const x = r.posts[p];
      console.log(
        `  ${p}: ${x?.ok ? `posted ${x.url ?? x.postId ?? ""}`.trim() : x?.uncertain || x?.pending ? `UNCERTAIN (${x.error ?? "no answer"})` : `failed (${x?.error ?? "not tried"})`}`,
      );
    }
    for (const [p, why] of Object.entries(r.notApplicable ?? {})) {
      console.log(`  ${p}: not applicable (${why})`);
    }
  },

  async drop() {
    const id = itemFlag();
    const why = flag("why") ?? die('drop needs --why "<reason>"');
    await app("POST", "/api/daily/drop", { item: id, why });
    console.log(`${id} dropped: ${why}`);
  },

  async storyboard() {
    const c = await itemNamed(itemFlag());
    // A new folder per run: nothing that exists is written over.
    const dir = mkdtempSync(join(tmpdir(), `wallgame-storyboard-${c.id}-`));
    const candidate = join(dir, "candidate.json");
    writeFileSync(candidate, JSON.stringify(c.candidate));
    const run = spawnSync(
      BUN,
      [
        STORYBOARD,
        "--candidate",
        candidate,
        "--out",
        join(dir, `${c.candidate.gameId}.png`),
        ...(flag("edl") ? ["--edl", resolve(flag("edl"))] : []),
      ],
      {
        encoding: "utf8",
        timeout: STORYBOARD_TIMEOUT_MS,
        // SIGTERM: playwright then closes the Chrome it started.
        killSignal: "SIGTERM",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const line = run.stdout
      ?.split("\n")
      .reverse()
      .find((l) => l.startsWith("RESULT "));
    if (run.status !== 0 || !line) {
      die(
        `the storyboard failed (exit ${run.status}${run.signal ? `, ${run.signal}` : ""}): ${(run.error?.message ?? run.stderr ?? "").trim().split("\n").slice(-10).join("\n") || "no RESULT line"}`,
      );
    }
    const result = JSON.parse(line.slice("RESULT ".length));
    console.log(
      `storyboard: ${result.png} (${result.plies} plies). Open it before you write the edit list.`,
    );
  },

  async ship() {
    const passed = await ship({
      office,
      appBase: await appBase(),
      appName: APP_NAME,
      to: flag("to") ?? die("ship needs --to <a commit on main>"),
      say: (line) => console.log(line),
    });
    if (!passed) process.exit(1);
  },

  async sheet() {
    const c = await itemNamed(itemFlag());
    const sheet = c.render?.sheet ?? die(`${c.id} has no contact sheet yet`);
    console.log(`contact sheet: ${sheet.path}`);
    console.log(`  sha256 ${sheet.sha256} (give it to check --sheet)`);
    sheet.stills.forEach((x, i) =>
      console.log(
        `  still ${i + 1}: ply ${x.ply} ${x.kind}${x.sound ? ` + ${x.sound}` : ""}`,
      ),
    );
    // The event strips: when each sound starts against its move's landing,
    // and four frames around each event (strips.mjs). Made once per render.
    const timeline = c.render.timeline;
    if (!timeline) {
      console.log("event strips: none (this render has no timeline)");
    } else {
      const plan = stripPlan(timeline, c.render.video.durationSeconds ?? 0);
      for (const row of plan) {
        for (const line of row.lines) console.log(`  ${line}`);
      }
      const out = join(tmpdir(), "daily-strips", `${c.render.jobId}.png`);
      if (!existsSync(out)) {
        mkdirSync(dirname(out), { recursive: true });
        await writeStrips({ mp4: c.render.video.path, plan, out });
      }
      console.log(`event strips: ${out} (open it with the sheet)`);
    }
    // A failed measure fails the check whatever the stills show, so the
    // director sees it before writing verdicts.
    for (const l of measureLines(c.render.quality)) console.log(l);
    for (const l of storyWarning(c.render.video)) console.log(l);
  },

  async check() {
    const path =
      flag("verdicts") ?? die("check needs --verdicts <file>: one per still");
    // The sheet the director looked at, as `sheet` printed it: the app
    // refuses the check if the current render has another sheet.
    const sheetSha256 =
      flag("sheet") ?? die("check needs --sheet <sha256 that `sheet` printed>");
    const id = itemFlag();
    await app("POST", "/api/daily/check", {
      item: id,
      sheetSha256,
      stills: JSON.parse(readFileSync(path, "utf8")),
    });
    console.log(await itemSummary(id));
  },

  /**
   * Nil's feedback, oldest first: read the recent rows before you direct.
   * A row is a review action; the rows from before the review queue are
   * his answers to the daily asks.
   */
  async feedback() {
    const last = Number(flag("last") ?? 10);
    const rows = await app("GET", `/api/daily/feedback?last=${last}`);
    if (rows.length === 0) return console.log("no feedback yet");
    for (const r of rows) console.log(feedbackLines(r).join("\n"));
  },

  async log() {
    const rows = await app(
      "GET",
      `/api/daily/post-log${has("dry-run") ? "?dryRun=1" : ""}`,
    );
    for (const r of rows) console.log(JSON.stringify(r));
    if (!rows.length) console.log("(empty)");
  },

  async "auth-check"() {
    const platform = flag("platform");
    if (platform !== "x" && platform !== "instagram")
      die("auth-check needs --platform x|instagram");
    const r = await app(
      "GET",
      `/api/daily/auth-check?platform=${encodeURIComponent(platform)}`,
    );
    if (r.missing.length) console.log(`missing: ${r.missing.join(", ")}`);
    if (r.shape) {
      for (const [name, f] of Object.entries(r.shape)) {
        console.log(
          `${name}: ${f.set ? "set" : "NOT SET"}${f.whitespaceAtAnEnd ? ", WHITESPACE AT AN END" : ""}`,
        );
      }
    }
    if (r.app) {
      console.log(
        `x key pair: HTTP ${r.app.status} (${r.app.ok ? "valid" : "NOT accepted"})`,
      );
    }
    if (!r.result) {
      console.log(`${platform}: not called (its own secrets are missing)`);
      return;
    }
    console.log(`${platform}: ${JSON.stringify(r.result)}`);
  },
};

if (import.meta.main) {
  if (!commands[command]) die(`commands: ${Object.keys(commands).join(", ")}`);
  await commands[command]();
}
