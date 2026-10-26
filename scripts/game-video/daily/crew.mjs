/**
 * The crew lead's commands for one daily video. Each one is a step of the
 * cycle in routes.mjs; the app keeps the record and refuses a step out of
 * order, so a session that starts cold can run `status` and go on.
 *
 *   node scripts/game-video/daily/crew.mjs <command> [--day YYYY-MM-DD]
 *
 *   status                         where today's cycle is
 *   facts --report F [--top N]     the candidates' facts, to write the on-video
 *                                  caption from
 *   pick --report F [--rank N] [--style S] [--replace]
 *                                  today's candidate. No post text: Wall Game
 *                                  Growth writes it (copy). A day has one
 *                                  cycle: --replace starts over a day that has
 *                                  one (only on purpose, e.g. after the member
 *                                  rejected its video)
 *   storyboard [--edl F]           one image of every position of the picked
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
 *   direct --edl F [--claim-risk-ok K,K]
 *                                  the director's edit decision list for the
 *                                  picked game (scripts/game-video/edl.mjs);
 *                                  `status` names the default ending.
 *                                  --claim-risk-ok accepts those sounds with
 *                                  a high claim risk on purpose (only when
 *                                  Nil asks for one)
 *   render [--wait] [--force]      a 4090 render of the list; --wait polls until
 *                                  it ends. A second render of a game needs
 *                                  --force: each render adds one view to the
 *                                  real game.
 *   preview --plies FROM..TO [--edl F]
 *                                  a few seconds of the video: those plies of
 *                                  the day's edit list (or of F, a list for
 *                                  the day's game), rendered on the 4090 from
 *                                  the game's capture, so no view. It needs
 *                                  the game's first render (which saves the
 *                                  capture). Prints the MP4's path. A preview
 *                                  changes nothing in the cycle and can never
 *                                  be checked, asked or posted. For the
 *                                  PICTURE only: its music starts at its first
 *                                  frame
 *   sheet                          the contact sheet's path and its stills, in
 *                                  order: look at the PNG before `check`.
 *                                  Also the event strips (strips.mjs): each
 *                                  event's sounds against its move's
 *                                  landing, and a PNG of four frames per
 *                                  event (in /tmp/daily-strips)
 *   check --sheet SHA --verdicts F the director's verdict on each still, as
 *                                  [{"ply","kind","ok","note"}]: ok only when
 *                                  the still shows what the cue is for (a FAHHH
 *                                  or zoom shows the save wall). The ask needs
 *                                  every still ok.
 *   copy --day D --file F --copy-version V
 *                                  Wall Game Growth's copy block for the day:
 *                                  five lines, "X:", "YouTube title:",
 *                                  "YouTube description:", "TikTok:",
 *                                  "Instagram:", each the exact text that
 *                                  posts (copy.mjs). V names Growth's copy
 *                                  style (e.g. growth-copy-1). Allowed until
 *                                  the ask opens; a new block replaces the old
 *   ask --agent <your agent id> [--reopen]
 *                                  open the Isomux ask with the MP4 and the
 *                                  stored copy block for APPROVER_MEMBER
 *                                  (it refuses without a block). After a
 *                                  rejection of the text only, a new block
 *                                  and `ask` again: the same video, no new
 *                                  render; --reopen opens the
 *                                  day's open ask again for that member, gives
 *                                  the app the new id and withdraws the old one
 *   answer --agent <id> --ask <askId> --decision approve|reject
 *          --approver <member> --reply <the member's reply, verbatim>
 *                                  pass the member's answer to the app; the
 *                                  cycle is found by the ask, so no --day. An
 *                                  approval prints the APPROVED PACKAGE that
 *                                  the director sends to Wall Game Growth
 *   post --day D [--confirm-not-posted x|youtube|tiktok|instagram|facebook|
 *                 bluesky|threads|mastodon]
 *                                  (Wall Game Growth) post the approved block:
 *                                  X, YouTube, the TikTok draft and the
 *                                  Instagram Reel (dry-run without keys)
 *   log [--dry-run]                the post log
 *   ship --to <hash>               release a commit that is on main: run
 *                                  from the release checkout, it moves that
 *                                  checkout to <hash>, syncs and checks the
 *                                  4090 kit and restarts the app
 *                                  (daily/ship.mjs), stopping at the first
 *                                  failure. It never pushes or merges
 *
 * The ask goes to APPROVER_MEMBER. Only an agent can open one (an app
 * token is refused there), which is why this runs as the crew lead and uses
 * ISOMUX_AGENT_TOKEN. `ask` sends the app the video hash and posting modes
 * that the ask shows, and withdraws the ask if the app no longer agrees.
 *
 * READING THE ANSWER (the crew lead's rule). The office closes an ask in three
 * ways, and only one is an approval:
 *   "[Reply to your ask <id>: ...]" whose text is the Approve option
 *        -> answer --decision approve --reply "<that text>"
 *   any other reply text                    -> --decision reject, reply as given
 *   "Dismissed your ask" or "is now task"   -> --decision reject
 * `answer` checks that the ask is closed, but a closed ask is not proof of a
 * yes: the decision is the crew lead's reading of the member's message.
 *
 * AFTER AN UNCERTAIN POST. If a platform's final request got no clear answer,
 * `post` refuses that platform. Look at the account (X profile, YouTube Studio,
 * the TikTok inbox, the Instagram profile).
 * Only when the post is not there, run post again with --confirm-not-posted.
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
import { createHash } from "node:crypto";
import { candidateFromReport } from "./candidate.mjs";
import { dailySeatColors } from "../edl.mjs";
import { ship } from "./ship.mjs";
import { stripPlan, writeStrips } from "./strips.mjs";
import { SHORTS_TAG, copyLines, copySha256, postTexts } from "./copy.mjs";

const OFFICE = "http://localhost:4000";
/** This file's place in a checkout, for the commands another agent runs. */
const CREW_IN_CHECKOUT = "scripts/game-video/daily/crew.mjs";
const STORYBOARD = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../storyboard.ts",
);
/** By full path, as nightly-candidates.sh: a unit's PATH has no bun. */
const BUN = join(homedir(), ".bun/bin/bun");
/** About 40 times the 3 s of a 27-ply storyboard (2026-10-26). */
const STORYBOARD_TIMEOUT_MS = 120_000;
const APP_NAME = "game-video";
/**
 * Who answers the daily ask. An ask goes to the agent's manager unless it
 * names a member, and the Director's manager (Isomuxer 3 since 2026-10-26)
 * is an inbox that nobody reads.
 */
const APPROVER_MEMBER = "Nil";

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

const day = flag("day");

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

const summary = (s) => {
  const c = s.cycle;
  const lines = [
    `day ${s.day}: ${c ? c.state : "no cycle"}   modes ${Object.entries(s.modes)
      .map(([p, m]) => `${p}=${m}`)
      .join(" ")}`,
  ];
  if (!c) return lines.join("\n");
  const k = c.candidate;

  lines.push(
    `game ${k.gameId}: ${k.seats.map((x) => x.name).join(" vs ")}, ${k.movesCount} plies`,
    ...k.facts,
    ...(c.copy
      ? [
          `copy block (${c.copy.version}):`,
          ...copyLines(c.copy).map((l) => `  ${l}`),
        ]
      : ["no copy block from Wall Game Growth yet"]),
  );
  if (c.edl) {
    lines.push(
      `edit list ${c.edl.sha256.slice(0, 12)}:`,
      ...c.edl.summary.map((l) => `  ${l}`),
    );
  } else {
    lines.push(
      `no edit list yet; default ending ${s.suggestedEnding}; last posted music ${s.lastMusic ?? "none"}`,
    );
  }
  if (c.render) {
    lines.push(
      c.render.error
        ? `render ${c.render.jobId}: FAILED ${c.render.error}`
        : c.render.video
          ? `render ${c.render.jobId}: ${c.render.video.path} (${c.render.video.bytes} bytes, sha256 ${c.render.video.sha256.slice(0, 12)}), sheet ${c.render.sheet.path}`
          : `render ${c.render.jobId}: running - ${s.renderProgress ?? "queued"}`,
      ...measureLines(c.render.quality),
    );
  }
  if (c.check) {
    lines.push(
      `contact sheet check: ${c.check.ok ? "all ok" : "FAILED"}`,
      ...c.check.verdicts.map(
        (v) => `  ply ${v.ply} ${v.kind}: ${v.ok ? "ok" : "BAD"} - ${v.note}`,
      ),
    );
  }
  if (c.approval) {
    lines.push(
      `ask ${c.approval.askId}: ${c.approval.decision ? `${c.approval.decision === "approve" ? "approved" : "rejected"} by ${c.approval.approver}` : "waiting"}`,
    );
  }
  for (const [p, r] of Object.entries(c.posts)) {
    lines.push(
      `${p}: ${r.ok ? `${r.mode} ${r.postId} ${r.url}` : `FAILED ${r.error}`}`,
    );
  }
  return lines.join("\n");
};

const state = () => app("GET", `/api/daily/state${day ? `?day=${day}` : ""}`);

/** Each platform's key in the posting modes, and its name in the ask. */
const PLATFORM_NAMES = [
  ["x", "X"],
  ["youtube", "YouTube"],
  ["tiktok", "TikTok"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["bluesky", "Bluesky"],
  ["threads", "Threads"],
  ["mastodon", "Mastodon"],
];

/**
 * What each platform was given to post, from the approved block, as one
 * line per platform: "<mode> <Platform>: <text>". The posters send it
 * unchanged (posters.test.ts and daily.test.ts check the requests).
 */
export const postedTexts = (c) => {
  const t = postTexts(c.approval.copy);
  return PLATFORM_NAMES.filter(([p]) => c.posts[p]).map(([p, name]) => {
    const text =
      p === "youtube"
        ? `title ${JSON.stringify(t.youtubeTitle)}, description ${JSON.stringify(t.youtubeDescription)}`
        : p === "tiktok"
          ? `${JSON.stringify(t.tiktok)} (not sent: Nil pastes it in the inbox draft)`
          : JSON.stringify(t[p]);
    return `${c.posts[p].mode} ${name}: ${text}`;
  });
};

/** The ask's text: everything Nil needs to decide without opening anything. */
export const askText = (c, modes, videoSha256) => {
  const dry = Object.values(modes).every((m) => m === "dry-run");
  const live = PLATFORM_NAMES.filter(([p]) => modes[p] === "live").map(
    ([, name]) => name,
  );
  // A new block after a text-only rejection: the ask Nil rejected, which
  // is the current approval until the new ask is recorded, or the last
  // earlier ask when this one is opened again.
  const earlier =
    c.state === "rejected"
      ? c.approval
      : c.approval?.sameVideoAs
        ? c.earlierAsks?.at(-1)
        : null;
  return [
    `Daily Wall Game video for ${c.day}.${dry ? " DRY RUN: nothing will be posted." : ""}`,
    ...(earlier
      ? [
          `SAME VIDEO as ask ${earlier.askId} (sha256 ${earlier.videoSha256.slice(0, 12)}), ${earlier.reply === null ? "which you dismissed without a reply" : `which you rejected with: "${earlier.reply}"`}. Only the post text is new.`,
        ]
      : []),
    "",
    "WHAT GOES OUT (the video is attached).",
    `Post text (by Growth, ${c.copy.version}):`,
    ...copyLines(c.copy),
    `The app adds "${SHORTS_TAG.trim()}" to the YouTube title.`,
    // Whether it goes out for real is the main fact of the approval.
    ...(live.length
      ? [`LIVE on ${live.join(", ")}: this posts for real on approval.`]
      : []),
    `Posting mode: ${PLATFORM_NAMES.map(([p, name]) => `${name} ${modes[p]}`).join(", ")}.`,
    modes.tiktok === "live"
      ? "TikTok: open the inbox draft, paste the TikTok line, tap Post."
      : "TikTok: dry run, no draft.",
    "",
    "FOR YOU ONLY, NOT POSTED:",
    `${c.candidate.seats.map((x) => x.name).join(" vs ")}, ${c.candidate.movesCount} plies, game ${c.candidate.gameId}.`,
    `Video: ${(c.render.video.bytes / 1e6).toFixed(1)} MB, sha256 ${videoSha256.slice(0, 12)}, style ${c.render.effect ?? "-"}, ending ${c.render.ending}, sounds ${c.render.sound ?? "-"}, music ${c.render.music ?? "-"}.`,
    "Director's edit list:",
    ...c.edl.summary.map((l) => `- ${l}`),
    `Contact sheet (attached), checked by the director:`,
    ...c.check.verdicts.map((v) => `- ply ${v.ply} ${v.kind}: ${v.note}`),
    "",
    "Approve to post it as shown. Reject, and say what to change, to stop it.",
  ].join("\n");
};

/**
 * What the director forwards to Wall Game Growth after Nil's yes: Growth
 * posts exactly this. Everything comes from the app's record of the
 * approval, not from the director's memory. `releaseCrew` is crew.mjs in
 * the checkout that the app runs from (its registered cwd, which `ship`
 * keeps on the release checkout): Growth never runs a worktree's code.
 */
export const approvedPackage = (c, releaseCrew) => {
  const a = c.approval;
  return [
    `APPROVED PACKAGE, day ${c.day}`,
    `Video: ${c.render.video.path}`,
    `Video sha256: ${a.videoSha256}`,
    `Copy block as approved (${a.copy.version}, copy sha256 ${copySha256(a.copy)}):`,
    ...copyLines(a.copy),
    `Ask: ${a.askId}, approved by ${a.approver} at ${a.answeredAt}`,
    `${a.approver}'s reply, verbatim: ${a.reply}`,
    `Post it with: node ${releaseCrew} post --day ${c.day}`,
  ].join("\n");
};

const commands = {
  async status() {
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
    const path = flag("report") ?? die("pick needs --report <file>");
    const report = readReport(path);
    const rank = Number(flag("rank") ?? 1);
    // Send only the chosen entry: the full report holds every position's score.
    const slim = {
      kind: report.kind,
      createdAt: report.createdAt,
      ranked: report.ranked?.slice(0, rank),
    };
    await app("POST", "/api/daily/pick", {
      day,
      report: slim,
      rank,
      style: flag("style"),
      replace: has("replace"),
    });
    console.log(summary(await state()));
  },

  /** Run by Wall Game Growth: its copy block for the day's posts. */
  async copy() {
    if (!day) die("copy needs --day: the cycle's day");
    const path = flag("file") ?? die("copy needs --file <the copy block>");
    const copyVersion =
      flag("copy-version") ??
      die(
        "copy needs --copy-version <Growth's copy style, e.g. growth-copy-1>",
      );
    if (!existsSync(path)) die(`copy: no file ${resolve(path)}`);
    await app("POST", "/api/daily/copy", {
      day,
      text: readFileSync(path, "utf8"),
      copyVersion,
    });
    console.log(summary(await state()));
  },

  async render() {
    const { jobId } = await app("POST", "/api/daily/render", {
      day,
      force: has("force"),
    });
    console.log(`render ${jobId} queued`);
    if (!has("wait")) return;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await state();
      if (s.cycle.state !== "rendering") return console.log(summary(s));
    }
  },

  async preview() {
    const plies = flag("plies") ?? die("preview needs --plies FROM..TO");
    const path = flag("edl");
    const { previewId } = await app("POST", "/api/daily/preview", {
      day,
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
          `preview of plies ${p.plies}: ${p.video.path} (${p.video.durationSeconds ?? "?"} s, ${(p.video.bytes / 1e6).toFixed(1)} MB). Not the day's video: the cycle did not change.`,
        );
      }
    }
  },

  async direct() {
    const path = flag("edl") ?? die("direct needs --edl <edl.json>");
    await app("POST", "/api/daily/direct", {
      day,
      edl: JSON.parse(readFileSync(path, "utf8")),
      claimRiskOk: flag("claim-risk-ok")?.split(",") ?? [],
    });
    console.log(summary(await state()));
  },

  async storyboard() {
    const c = (await state()).cycle ?? die("pick a game first");
    // A new folder per run: nothing that exists is written over.
    const dir = mkdtempSync(join(tmpdir(), `wallgame-storyboard-${c.day}-`));
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
    const c = (await state()).cycle;
    const sheet = c?.render?.sheet ?? die("there is no contact sheet yet");
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
  },

  async check() {
    const path =
      flag("verdicts") ?? die("check needs --verdicts <file>: one per still");
    // The sheet the director looked at, as `sheet` printed it: the app
    // refuses the check if the current render has another sheet.
    const sheetSha256 =
      flag("sheet") ?? die("check needs --sheet <sha256 that `sheet` printed>");
    const c = (await state()).cycle;
    await app("POST", "/api/daily/check", {
      day: c?.day ?? die("there is no cycle"),
      sheetSha256,
      stills: JSON.parse(readFileSync(path, "utf8")),
    });
    console.log(summary(await state()));
  },

  async ask() {
    const agent = flag("agent") ?? die("ask needs --agent <your agent id>");
    const reopen = has("reopen");
    const s = await state();
    const c = s.cycle;
    // --reopen: the day's ask is open but went to the wrong inbox; the same
    // ask opens again for APPROVER_MEMBER, and the app takes its id.
    const replaces = reopen ? c?.approval?.askId : undefined;
    if (reopen) {
      if (c?.state !== "asked" || !replaces)
        die(
          `ask --reopen needs an open ask; the cycle is ${c?.state ?? "missing"}`,
        );
      const old = await office("GET", `/api/agents/${agent}/asks/${replaces}`);
      if (old.status === 404)
        die(
          `ask ${replaces} is not open: it was answered or closed, so run answer instead`,
        );
      if (old.status !== 200)
        die(
          `cannot read ask ${replaces} (HTTP ${old.status}): only the agent that opened it can reopen it, with its own token and --agent`,
        );
    } else if (c?.state !== "checked" && c?.state !== "rejected")
      die(
        `ask needs a rendered video whose contact sheet the director checked, or a rejected ask and a new copy block; the cycle is ${c?.state ?? "missing"}`,
      );
    if (!c.copy)
      die(
        "ask needs Wall Game Growth's copy block: send Growth the copy request, and Growth runs crew.mjs copy",
      );
    // The hash of the bytes that the ask attaches, not of the record.
    const videoSha256 = createHash("sha256")
      .update(readFileSync(c.render.video.path))
      .digest("hex");
    if (videoSha256 !== c.render.video.sha256) {
      die("the video file does not match its record; render again");
    }
    const opened = await office("POST", `/api/agents/${agent}/asks`, {
      type: "application/json",
      body: JSON.stringify({
        text: askText(c, s.modes, videoSha256),
        member: APPROVER_MEMBER,
        options: ["Approve", "Reject"],
        readFiles: [c.render.video.path, c.render.sheet.path],
      }),
    });
    if (opened.status !== 201)
      die(
        `the ask was refused: HTTP ${opened.status} ${JSON.stringify(opened.body)}`,
      );
    const recorded = await appTry("POST", "/api/daily/ask", {
      day: c.day,
      askId: opened.body.id,
      modes: s.modes,
      videoSha256,
      // The block that askText printed, from the same state.
      copySha256: copySha256(c.copy),
      ...(replaces && { replacesAskId: replaces }),
    });
    if (!recorded.ok) {
      // The ask shows something the app no longer agrees with: withdraw it.
      await office("DELETE", `/api/agents/${agent}/asks/${opened.body.id}`);
      die(`ask withdrawn: ${recorded.json.error}`);
    }
    console.log(
      `ask ${opened.body.id} opened for ${opened.body.member ?? "the manager"}`,
    );
    if (replaces) {
      // The app now answers only to the new id, so the old ask is noise.
      const gone = await office(
        "DELETE",
        `/api/agents/${agent}/asks/${replaces}`,
      );
      console.log(
        gone.status === 204
          ? `ask ${replaces} withdrawn`
          : `ask ${replaces} could not be withdrawn (HTTP ${gone.status}); the app no longer takes its answer`,
      );
    }
  },

  async answer() {
    const agent = flag("agent") ?? die("answer needs --agent <your agent id>");
    const askId = flag("ask") ?? die("answer needs --ask <askId>");
    const decision = flag("decision");
    if (decision !== "approve" && decision !== "reject")
      die("--decision is approve or reject");
    const approver =
      flag("approver") ?? die("answer needs --approver <member name>");
    const reply = flag("reply");
    if (decision === "approve" && !reply) {
      die("an approval needs --reply with the member's reply, verbatim");
    }
    // The package names the app's own checkout; find it before the answer
    // changes anything.
    const registered = await office("GET", `/api/apps/${APP_NAME}`);
    if (registered.status !== 200)
      die(`cannot find the ${APP_NAME} app (HTTP ${registered.status})`);
    const releaseCrew = join(registered.body.cwd, CREW_IN_CHECKOUT);
    // An open ask has no answer yet; 404 is how the office says it closed.
    const open = await office("GET", `/api/agents/${agent}/asks/${askId}`);
    if (open.status === 200)
      die(`ask ${askId} is still open; wait for the member's reply`);
    if (open.status !== 404)
      die(`cannot check ask ${askId}: HTTP ${open.status}`);
    const cycle = await app("POST", "/api/daily/answer", {
      askId,
      decision,
      approver,
      reply,
    });
    console.log(summary(await app("GET", `/api/daily/state?day=${cycle.day}`)));
    if (cycle.state === "approved") {
      console.log(
        `\nSend this to Wall Game Growth as it is:\n\n${approvedPackage(cycle, releaseCrew)}`,
      );
    }
  },

  async post() {
    if (!day) die("post needs --day: the cycle's day, which `answer` printed");
    const confirm = flag("confirm-not-posted");
    await app("POST", "/api/daily/post", {
      day,
      confirmNotPosted: confirm ? [confirm] : [],
    });
    const s = await state();
    console.log(summary(s));
    console.log("");
    console.log(postedTexts(s.cycle).join("\n"));
  },

  async log() {
    const rows = await app(
      "GET",
      `/api/daily/post-log${has("dry-run") ? "?dryRun=1" : ""}`,
    );
    for (const r of rows) console.log(JSON.stringify(r));
    if (!rows.length) console.log("(empty)");
  },
};

if (import.meta.main) {
  if (!commands[command]) die(`commands: ${Object.keys(commands).join(", ")}`);
  await commands[command]();
}
