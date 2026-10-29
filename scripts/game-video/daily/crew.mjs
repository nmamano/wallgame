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
 *   direct --item ID --edl F [--claim-risk-ok K,K] [--no-lint]
 *                                  the director's edit decision list for the
 *                                  item's game (scripts/game-video/edl.mjs);
 *                                  `status` names the default ending.
 *                                  It lints the list first and stores it
 *                                  only when nothing stops it (R1).
 *                                  --claim-risk-ok accepts those sounds with
 *                                  a high claim risk on purpose (only when
 *                                  Nil asks for one). --no-lint stores
 *                                  without the lint, only when the 4090
 *                                  cannot lint. A finished item goes back to
 *                                  draft
 *   lint --item ID [--edl F] [--claim-risk-ok K,K]
 *                                  every fault of the item's list (or of F)
 *                                  at once, with ply and second: the app's
 *                                  checks and the renderer's, composed from
 *                                  the 4090's capture with no image (about
 *                                  2 s there, no view). STOP stops the list;
 *                                  WARN and NOTE are for you to read. Exits
 *                                  1 when something stops it. A game with
 *                                  no capture yet gets the app's checks
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
 *   preview --item ID --plies FROM..TO [--edl F]...
 *                                  a few seconds of the video: those plies of
 *                                  the item's edit list (or of F, a list for
 *                                  its game), rendered on the 4090 from the
 *                                  game's capture, so no view. It needs the
 *                                  game's first render (which saves the
 *                                  capture). Prints the MP4's path. A preview
 *                                  changes nothing in the item and can never
 *                                  be checked, reviewed or posted. For the
 *                                  PICTURE only: its music starts at its first
 *                                  frame. With several --edl (variants of
 *                                  the game's list), all are queued first,
 *                                  then each prints when it is done
 *   preview --item ID --draft [--plies FROM..TO] [--edl F]...
 *                                  a QUICK LOOK: the same video at 15 fps and
 *                                  540x960, not checked frame by frame, in
 *                                  about 15 s for a whole video on the
 *                                  4090. Without --plies, the whole list,
 *                                  its music where the video plays it. For
 *                                  timing and story; a clean quick look is
 *                                  not a clean render (its 15 fps can miss
 *                                  what the render stops)
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
 *   script --item ID [--edl F] [--out F]
 *                                  phase 1 (SCRIPT.md): the draft of the
 *                                  item's script, from the list (F or the
 *                                  stored one), its lint (each ply's
 *                                  second) and the game's facts, in a new
 *                                  file (default /tmp/daily-scripts)
 *   script-review-prompt --item ID --script F [--edl F]
 *                                  SCRIPT-REVIEW.md and its inputs (the
 *                                  script, a storyboard, the facts, the
 *                                  list, the other videos of the batch, a
 *                                  NOTES file), ready to paste into a fresh
 *                                  reviewer
 *   script-review --item ID --script F --reviewer "<who>" --verdict pass|fail
 *       --notes-file F             record the script review. `render`
 *                                  refuses the item until the latest one
 *                                  since its pick or Nil's last revise
 *                                  passes
 *   vet-prompt --item ID           VET-BRIEF.md and the item's inputs (video
 *                                  and sha256, sheet, strips, the stored
 *                                  list in a file, a storyboard, the
 *                                  players and colours, the game's facts,
 *                                  Nil's revise notes, the approved script
 *                                  and its review notes, a NOTES file and
 *                                  a scratch folder), ready to paste into a
 *                                  fresh reviewer
 *
 * THE DIRECTOR'S TOOLS read one video, V = --item ID (the item's current
 * video), --preview ID (a preview or quick look) or --video FILE, and write
 * only in /tmp/daily-tools. They change no item.
 *   scan V [--every S]             one PNG of a frame every S s (1.5) of the
 *                                  whole video: the narrative timing
 *   strip V --from T --seconds D [--fps F]
 *                                  one PNG of the frames of T..T+D at F a
 *                                  second (4): a beat, an overlay's life
 *   crop V --at T --box X,Y,W,H    one full-size crop of the frame at T s:
 *                                  does a mark touch a wall or a pawn?
 *   audio V [--from T --seconds D] every silence, the loudness and true
 *                                  peak; with a range, the peak of each
 *                                  0.1 s too
 *   fullcheck V                    codec, size, fps and length, the first
 *                                  and last frames in one PNG, and the
 *                                  short-term loudness of each second
 *   loudness-ab V [--target L]     a copy at feed level (-14 LUFS) to
 *                                  compare by ear: never an item's video
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
import { validateEdl } from "../edl.mjs";
import { ship } from "./ship.mjs";
import { stripPlan, writeStrips } from "./strips.mjs";
import { copyLines } from "./copy.mjs";
import { quoteLines } from "./quote.mjs";
import { noStoryLine } from "./post-instagram.mjs";
import { lintReport, lintStops } from "./lint.mjs";
import * as tools from "./tools.mjs";
import { currentScriptReview } from "./store.mjs";
import {
  batchLines,
  directorLines,
  scriptDraft,
  seatColors,
} from "./script.mjs";
import { timelineOf } from "./strips.mjs";

const OFFICE = "http://localhost:4000";
const HERE = dirname(fileURLToPath(import.meta.url));
const STORYBOARD = resolve(HERE, "../storyboard.ts");
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
/** Every value of a flag that may repeat, in order. */
const flagsAll = (name) =>
  argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));

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

/**
 * Lint `edl` (or the item's stored list when it is undefined): queue it in
 * the app, wait, print the report and give the record. A list the app
 * refuses outright (not a list, another game) dies with why.
 */
const lintOf = async (item, edl, claimRiskOk) => {
  const rec = await lintRecord(item, edl, claimRiskOk, (line) =>
    console.log(line),
  );
  if (rec.state === "failed") {
    die(
      `lint ${rec.lintId} failed: ${rec.error}; with the 4090 down, direct --no-lint stores without it`,
    );
  }
  console.log([...lintReport(rec), ...timingLines(rec.timings)].join("\n"));
  return rec;
};

/**
 * Queue a lint of `edl` (or the item's stored list) and wait for its end:
 * the record, done or failed. `say` gets each wait reason once. A list the
 * app refuses outright dies with why.
 */
const lintRecord = async (item, edl, claimRiskOk, say) => {
  const posted = await appTry("POST", "/api/daily/lint", {
    item,
    ...(edl !== undefined && { edl }),
    claimRiskOk,
  });
  if (!posted.ok) {
    die(
      `POST /api/daily/lint: ${posted.json.error ?? posted.status}; with the 4090 down, direct --no-lint stores without it`,
    );
  }
  const { lintId } = posted.json;
  let said = null;
  for (;;) {
    const rec = await app(
      "GET",
      `/api/daily/lint?id=${encodeURIComponent(lintId)}`,
    );
    if (rec.state === "failed" || rec.state === "done") return rec;
    if (rec.state === "queued" && rec.progress && rec.progress !== said) {
      say(`lint ${lintId}: ${rec.progress}`);
      said = rec.progress;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
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

/**
 * How long a render or preview took, by step (render-4090.mjs timings), in
 * one line; none for a render from before the timings.
 */
export const timingLines = (t) => {
  if (!t) return [];
  const steps = ["check", "send", "start", "render", "fetch", "cleanup"]
    .filter((k) => typeof t[k] === "number")
    .map((k) => `${k} ${t[k]}`)
    .join(", ");
  const renderer = t.renderer
    ? `; renderer: ${Object.entries(t.renderer)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`
    : "";
  return [
    `  times (s): ${[steps, `total ${t.total}`].filter(Boolean).join("; ")}, ${t.workers} worker${t.workers === 1 ? "" : "s"}${renderer}`,
  ];
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
      ...timingLines(k.render.timings),
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
    `default ending ${s.suggestedEnding}; last posted music ${s.lastMusic?.length ? s.lastMusic.join(", ") : "none"}`,
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

/**
 * The seats as the video shows them, with each seat's colour. The
 * renderer's rule (dailySeatColors): an AI is red; two humans are red for
 * seat 1 and blue for seat 2. Two bots are never a candidate.
 */
const seatsLine = (c) => {
  const colors = seatColors(c);
  return c.seats
    .map(
      (s) =>
        `${s.name} (${s.kind}, ${colors[s.playerOrder] === "red" ? "Red" : "Blue"})`,
    )
    .join(" vs ");
};

/** The storyboard PNG of item `c` (marked by the list at `edl`, if any). */
const storyboardOf = (c, edl) => {
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
      ...(edl ? ["--edl", edl] : []),
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
  return JSON.parse(line.slice("RESULT ".length));
};

/**
 * The event strips of item `c`'s render (strips.mjs): its lines, and the
 * PNG, made once per render. null when the render has no timeline.
 */
const stripsOf = async (c) => {
  const timeline = c.render.timeline;
  if (!timeline) return null;
  const plan = stripPlan(timeline, c.render.video.durationSeconds ?? 0);
  const out = join(tmpdir(), "daily-strips", `${c.render.jobId}.png`);
  if (!existsSync(out)) {
    mkdirSync(dirname(out), { recursive: true });
    await writeStrips({ mp4: c.render.video.path, plan, out });
  }
  return { lines: plan.flatMap((row) => row.lines), path: out };
};

/**
 * The video a tool reads: the item's current video (--item), a preview or
 * quick look (--preview), or a file (--video). Its path, and a name for
 * the tool's folder.
 */
const toolVideo = async () => {
  const given = ["item", "preview", "video"].filter((f) => flag(f));
  if (given.length !== 1) {
    die("name one video: --item ID, --preview ID or --video FILE");
  }
  if (flag("item")) {
    const c = await itemNamed(flag("item"));
    const path =
      c.render?.video?.path ?? die(`${c.id} has no video yet: render it`);
    if (!existsSync(path)) die(`${c.id}'s video ${path} is not there`);
    return { video: path, name: c.id };
  }
  if (flag("preview")) {
    const id = flag("preview");
    const p = await app(
      "GET",
      `/api/daily/preview?id=${encodeURIComponent(id)}`,
    );
    if (p.state !== "done") die(`preview ${id} is ${p.state}, not done`);
    return { video: p.video.path, name: id };
  }
  const path = resolve(flag("video"));
  if (!existsSync(path)) die(`no file ${path}`);
  return { video: path, name: basename(path).replace(/\.[^.]*$/, "") };
};

/** A number flag, or `fallback` when it is not given. */
const numberFlag = (name, fallback) => {
  const text = flag(name);
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) die(`--${name} is a number, got ${text}`);
  return n;
};

/** Run one tool; its lines, or its fault as one line and exit 1. */
const runTool = async (fn, options) => {
  try {
    console.log(fn({ ...(await toolVideo()), ...options }).join("\n"));
  } catch (err) {
    die(`${command}: ${err.message}`);
  }
};

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
      console.log(
        `rank ${rank}: ${seatsLine(c)}, ${c.variant}, ${c.movesCount} plies`,
      );
      for (const f of c.facts) console.log(`  ${f}`);
      // For the edit list: 0-based plies, cells after the ply, and the walls
      // that caused the jump (marked *) in the notation a zoom frame takes.
      for (const l of directorLines(c)) console.log(`  ${l}`);
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
    // The app is on this box: a read each second costs nothing and saves
    // the director up to a poll's wait (Wall Game Director, 2026-10-29).
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const k = await itemNamed(id);
      if (k.render?.jobId !== jobId || k.render.finishedAt) {
        return console.log(await itemSummary(id));
      }
    }
  },

  /**
   * One preview, or one for each --edl (variants of one game, Wall Game
   * Director, 2026-10-29: try 3-5 ideas at once and pick). All are queued
   * first, so the 4090 never waits for the director between them; then
   * each prints as it is done, in the order given. A list that the app
   * refuses (a typo in a variant) prints why and the others go on.
   */
  async preview() {
    const draft = has("draft");
    const plies =
      flag("plies") ??
      (draft ? undefined : die("preview needs --plies FROM..TO, or --draft"));
    const kind = draft ? "quick look" : "preview";
    const item = itemFlag();
    const paths = flagsAll("edl");
    const lists = paths.length
      ? paths.map((path) => ({
          path,
          edl: JSON.parse(readFileSync(path, "utf8")),
        }))
      : [{ path: null, edl: null }];
    const queued = [];
    let failed = 0;
    for (const { path, edl } of lists) {
      const name = path ? ` (${basename(path)})` : "";
      const { ok, status, json } = await appTry("POST", "/api/daily/preview", {
        item,
        ...(plies !== undefined && { plies }),
        ...(edl && { edl }),
        ...(draft && { draft }),
      });
      if (!ok) {
        console.error(`${kind}${name} refused: ${json.error ?? status}`);
        failed += 1;
        continue;
      }
      console.log(`${kind} ${json.previewId} queued${name}`);
      queued.push({ previewId: json.previewId, path });
    }
    for (const { previewId, path } of queued) {
      let said = null;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const p = await app(
          "GET",
          `/api/daily/preview?id=${encodeURIComponent(previewId)}`,
        );
        const name = path ? ` (${basename(path)})` : "";
        // A queued preview that waits for the 4090 says why, once a reason.
        if (p.state === "queued" && p.progress && p.progress !== said) {
          console.log(`${kind} ${previewId}${name}: ${p.progress}`);
          said = p.progress;
        }
        if (p.state === "failed") {
          console.error(`${kind} ${previewId}${name} failed: ${p.error}`);
          failed += 1;
          break;
        }
        if (p.state === "done") {
          const of = p.plies ? `plies ${p.plies}` : "the whole list";
          console.log(
            [
              `${kind} of ${of}${name}: ${p.video.path} (${p.video.durationSeconds ?? "?"} s, ${(p.video.bytes / 1e6).toFixed(1)} MB${draft ? ", 15 fps, 540x960" : ""}). Not the item's video: the item did not change.${draft ? " A clean quick look is not a clean render." : ""}`,
              ...timingLines(p.timings),
            ].join("\n"),
          );
          break;
        }
      }
    }
    if (failed) die(`${failed} of ${lists.length} ${kind}s failed`);
  },

  async direct() {
    const id = itemFlag();
    const path = flag("edl") ?? die("direct needs --edl <edl.json>");
    const edl = JSON.parse(readFileSync(path, "utf8"));
    const claimRiskOk = flag("claim-risk-ok")?.split(",") ?? [];
    const noLint = process.argv.includes("--no-lint");
    // R1: a list that cannot render is never stored.
    const linted = noLint ? null : await lintOf(id, edl, claimRiskOk);
    if (linted && lintStops(linted).length) {
      die(`${basename(path)} is not stored: the lint stops it (see above)`);
    }
    await app("POST", "/api/daily/direct", {
      item: id,
      edl,
      claimRiskOk,
      ...(linted ? { lint: linted.lintId } : { noLint: true }),
    });
    console.log(await itemSummary(id));
  },

  async lint() {
    const id = itemFlag();
    const path = flag("edl");
    const rec = await lintOf(
      id,
      path ? JSON.parse(readFileSync(path, "utf8")) : undefined,
      flag("claim-risk-ok")?.split(",") ?? [],
    );
    if (lintStops(rec).length) process.exitCode = 1;
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
    const result = storyboardOf(c, flag("edl") && resolve(flag("edl")));
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
    const strips = await stripsOf(c);
    if (!strips) {
      console.log("event strips: none (this render has no timeline)");
    } else {
      for (const line of strips.lines) console.log(`  ${line}`);
      console.log(`event strips: ${strips.path} (open it with the sheet)`);
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

  /*
    The director's tools (tools.mjs): each reads one video (--item ID, the
    item's current video; --preview ID; or --video FILE) and writes only in
    /tmp/daily-tools. None of them changes an item.
  */
  async scan() {
    await runTool(tools.scan, { every: numberFlag("every", 1.5) });
  },

  async strip() {
    await runTool(tools.strip, {
      from: numberFlag("from") ?? die("strip needs --from T (s)"),
      seconds: numberFlag("seconds") ?? die("strip needs --seconds D"),
      fps: numberFlag("fps", 4),
    });
  },

  async crop() {
    await runTool(tools.crop, {
      at: numberFlag("at") ?? die("crop needs --at T (s)"),
      box: flag("box") ?? die("crop needs --box X,Y,W,H (video pixels)"),
    });
  },

  async audio() {
    await runTool(tools.audio, {
      from: numberFlag("from"),
      seconds: numberFlag("seconds"),
    });
  },

  async fullcheck() {
    await runTool(tools.fullcheck, {});
  },

  async "loudness-ab"() {
    await runTool(tools.loudnessAb, {
      target: numberFlag("target", tools.FEED_LUFS),
    });
  },

  /**
   * Phase 1 (SCRIPT.md): the draft of the item's script, for the director
   * to complete. From the list (--edl F, or the stored one) and its lint,
   * which gives each ply's second when the renderer reports its timeline.
   * Writes a new file; never one that exists.
   */
  async script() {
    const c = await itemNamed(itemFlag());
    const out = resolve(
      flag("out") ?? join(tmpdir(), "daily-scripts", `${c.id}.script.txt`),
    );
    if (existsSync(out)) {
      die(`${out} exists: complete it, or give --out for a new file`);
    }
    let edl = c.edl?.doc ?? null;
    if (flag("edl")) {
      const checked = validateEdl(
        JSON.parse(readFileSync(flag("edl"), "utf8")),
      );
      if (!checked.ok) die(`--edl: ${checked.errors.join("; ")}`);
      edl = checked.edl;
    }
    let timeline = null;
    let timesNote = "no list yet: give --edl to get each ply's second";
    if (edl) {
      const rec = await lintRecord(
        c.id,
        flag("edl") ? edl : undefined,
        [],
        (line) => console.log(line),
      );
      timeline = rec.state === "done" ? timelineOf(rec.lint?.timeline) : null;
      timesNote = timeline
        ? "from the lint of this list"
        : rec.state !== "done"
          ? `the lint failed (${rec.error}), so no times`
          : rec.skipped
            ? `no times: ${rec.skipped}`
            : "no times: the render kit's lint gives no timeline yet";
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      scriptDraft({ item: c, edl, timeline, timesNote }) + "\n",
    );
    console.log(
      `script draft: ${out}\n  complete every <...> and ? and tick the checklist, then: script-review-prompt --item ${c.id} --script ${out}`,
    );
  },

  /**
   * The script review brief (SCRIPT-REVIEW.md) and its inputs, ready to
   * paste into a fresh reviewer: the script, a storyboard, the facts, the
   * list, the other videos of the batch and a NOTES file.
   */
  async "script-review-prompt"() {
    const c = await itemNamed(itemFlag());
    const script = resolve(
      flag("script") ?? die("script-review-prompt needs --script <file>"),
    );
    if (!existsSync(script)) die(`no file ${script}`);
    const scratch = mkdtempSync(join(tmpdir(), `daily-script-review-${c.id}-`));
    let edl = null;
    if (flag("edl")) edl = resolve(flag("edl"));
    else if (c.edl) {
      edl = join(scratch, "edl.json");
      writeFileSync(edl, c.edl.text);
    }
    const board = storyboardOf(c, edl ?? undefined);
    const { items } = await app("GET", "/api/daily/state");
    console.log(
      [
        readFileSync(join(HERE, "SCRIPT-REVIEW.md"), "utf8")
          .replace(/^<!--[\s\S]*?-->\n+/, "")
          .trimEnd(),
        "",
        `## Your task: item ${c.id}, game ${c.gameId}`,
        `- SCRIPT: ${script}`,
        `- STORYBOARD: ${board.png} (${board.plies} plies)`,
        `- LIST: ${edl ?? "none yet (the script comes first)"}`,
        `- RULES: ${join(HERE, "DIRECTOR.md")}`,
        `- PLAYERS: ${seatsLine(c.candidate)}`,
        "- FACTS (plies 0-based in the director lines):",
        ...c.candidate.facts.map((f) => `  - ${f}`),
        ...directorLines(c.candidate).map((l) => `  - ${l}`),
        "- BATCH (the other videos in draft or review):",
        ...batchLines(items, c.id).map((l) => `  ${l}`),
        `- NOTES: ${join(scratch, "notes.txt")} (write your findings here)`,
      ].join("\n"),
    );
  },

  /**
   * Record the script review: the script file, the verdict and the notes.
   * `render` needs the latest one since the pick or the last revise to
   * pass.
   */
  async "script-review"() {
    const id = itemFlag();
    const read = (name) => {
      const path = resolve(
        flag(name) ?? die(`script-review needs --${name} <file>`),
      );
      if (!existsSync(path)) die(`script-review: no file ${path}`);
      return readFileSync(path, "utf8");
    };
    const script = read("script");
    const notes = read("notes-file");
    const reviewer =
      flag("reviewer") ??
      die('script-review needs --reviewer "<who reviewed it>"');
    const verdict =
      flag("verdict") ?? die("script-review needs --verdict pass|fail");
    const item = await app("POST", "/api/daily/script-review", {
      item: id,
      script,
      reviewer,
      verdict,
      notes,
    });
    const r = item.scriptReviews.at(-1);
    console.log(
      `${id}: script review ${r.verdict} by ${r.reviewer}, script ${r.scriptSha256.slice(0, 12)}. ${r.verdict === "pass" ? "The item may render." : "No render until a review of a fixed script passes."}`,
    );
  },

  /**
   * The vet brief (VET-BRIEF.md) and the item's inputs, ready to paste
   * into a fresh reviewer: it reads the final video, so the item needs one.
   */
  async "vet-prompt"() {
    const c = await itemNamed(itemFlag());
    const video = c.render?.video ?? die(`${c.id} has no video yet: render it`);
    const sheet = c.render.sheet ?? die(`${c.id} has no contact sheet yet`);
    const scratch = mkdtempSync(join(tmpdir(), `daily-vet-${c.id}-`));
    const edl = join(scratch, "edl.json");
    writeFileSync(edl, c.edl.text);
    const strips = await stripsOf(c);
    const board = storyboardOf(c, edl);
    const revises = c.reviews.filter((r) => r.action === "revise");
    // The approved story (phase 1): the render vet checks the video
    // against it, not the story itself.
    const script = currentScriptReview(c);
    const scriptFile = join(scratch, "script.txt");
    const scriptNotes = join(scratch, "script-review.txt");
    if (script) {
      writeFileSync(scriptFile, script.script);
      writeFileSync(scriptNotes, script.notes);
    }
    console.log(
      [
        readFileSync(join(HERE, "VET-BRIEF.md"), "utf8")
          .replace(/^<!--[\s\S]*?-->\n+/, "")
          .trimEnd(),
        "",
        `## Your task: item ${c.id}, game ${c.gameId}`,
        `- VIDEO: ${video.path} (sha256 ${video.sha256}, ${video.durationSeconds ?? "?"} s)`,
        `- SHEET: ${sheet.path}`,
        `- STRIPS: ${strips ? strips.path : "none (this render has no timeline)"}`,
        `- EDL: ${edl} (the stored list, sha256 ${c.edl.sha256})`,
        `- STORYBOARD: ${board.png} (${board.plies} plies)`,
        script
          ? `- SCRIPT: ${scriptFile} (the approved script, ${script.verdict} by ${script.reviewer} at ${script.at}; its review notes: ${scriptNotes})`
          : "- SCRIPT: none recorded (this item rendered before phase 1)",
        `- RULES: ${join(HERE, "DIRECTOR.md")}`,
        `- PLAYERS: ${seatsLine(c.candidate)}`,
        "- THE GAME (the winner and how):",
        ...c.candidate.facts.map((f) => `  - ${f}`),
        revises.length
          ? "- NIL'S REVISE NOTES, word for word:"
          : "- NIL'S REVISE NOTES: none",
        ...revises.map((r) => `  - ${r.at}: ${JSON.stringify(r.notes ?? "")}`),
        `- NOTES: ${join(scratch, "notes.txt")} (write your findings here)`,
        `- SCRATCH: ${scratch} (your frames and files)`,
      ].join("\n"),
    );
  },
};

if (import.meta.main) {
  if (!commands[command]) die(`commands: ${Object.keys(commands).join(", ")}`);
  await commands[command]();
}
