/**
 * A local page that turns a game URL into a downloadable video.
 *
 * Board task f89e649f. This is Nil's own tool, not a product surface: paste a
 * wallgame.io game link, wait, download an mp4. It is a thin wrapper around
 * scripts/game-video/render-game-video.mjs and owns no rendering logic of its
 * own.
 *
 * Run it through isomux, which allocates the port and keeps it alive:
 *   cwd     /home/nil/nil/wallgame
 *   command node scripts/game-video/app/server.mjs
 *
 * SIX THINGS THIS FILE IS CAREFUL ABOUT.
 *
 * 1. It never picks a port. PORT comes from isomux and the app refuses to
 *    start without it, rather than guessing one and colliding with something.
 *
 * 2. ONE RENDER AT A TIME, AND NO RENDER RUNS FOREVER. A render is a headless
 *    Chrome plus an ffmpeg; two at once is how this box gets an out-of-memory
 *    kill, and it has form for that. Requests queue and the page says where it
 *    is in the queue. Because the queue is one deep, a child that never exits
 *    used to block every other game for as long as the app lived, so every
 *    render now has a deadline - see RENDER_DEADLINE_MS.
 *
 * 3. It depends on nothing under tmp/. The renderer will fall back to a static
 *    ffmpeg in a scratch directory if it finds one, and that directory gets
 *    cleaned - so this app resolves ffmpeg itself, from PATH or a real
 *    dependency, and passes it explicitly. If neither exists it says so in
 *    plain words instead of failing somewhere deep in a filter graph.
 *
 * 4. Renders are CACHED BY GAME ID, and A FILE IN THE CACHE IS ALWAYS A WHOLE
 *    VIDEO. The renderer writes to a scratch file and the finished bytes are
 *    moved into place in one step, so a half-written mp4 from a failed ffmpeg
 *    can never be served as a cache hit and a re-render cannot destroy the
 *    good file it is replacing. Asking twice returns the file. Rendering again
 *    is a deliberate choice, because it costs a view on the real game - see
 *    the header of render-game-video.mjs.
 *
 * 5. EVERYTHING THE RENDERER SAYS IS UNTRUSTED TEXT. Its stdout carries the
 *    PLAYER DISPLAY NAMES of the game being rendered, and its stderr is
 *    whatever a failure printed. Both are shown on the page. The page builds
 *    every status box out of DOM nodes and textContent and uses innerHTML
 *    nowhere, so a player called `<img src=x onerror=...>` is read, not run.
 *    "It only listens on localhost" is not a reason to skip this.
 *
 * 6. WHAT ARRIVES FROM THE NETWORK IS CHECKED BEFORE IT IS USED. The game id
 *    reaches the filesystem and a child process, so it is matched against the
 *    two shapes that are meant to be typed here and nothing else, and the
 *    request body is read up to a limit rather than until it ends.
 */
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  createReadStream,
  statSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const RENDERER_DEFAULT = resolve(HERE, "../render-game-video.mjs");

/**
 * PLUMBING, for the tests rather than for a person - the same category as the
 * renderer's own --work and --ffmpeg, and nobody running this app types either
 * of these.
 *
 * server.test.ts points --renderer at a stub child, because the two failures
 * worth testing are ones the real renderer will not perform on demand: hanging
 * forever, and exiting with a half-written file. --deadline-ms exists for the
 * first of those, since a test cannot wait out the real twelve minutes.
 */
const plumbing = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 ? process.argv[at + 1] : undefined;
};

const RENDERER = plumbing("renderer")
  ? resolve(plumbing("renderer"))
  : RENDERER_DEFAULT;

/* ------------------------------------------------------------------ setup -- */

const PORT = Number(process.env.PORT);
if (!Number.isFinite(PORT) || PORT <= 0) {
  console.error(
    "PORT is not set. This app is meant to be registered with isomux, which " +
      "allocates the port:\n" +
      '  curl -s -X POST localhost:4000/api/apps ... -d \'{"name":"game-video",' +
      '"command":"node scripts/game-video/app/server.mjs","cwd":"~/nil/wallgame"}\'',
  );
  process.exit(2);
}

/**
 * Where renders live. Isomux supplies a directory that survives restarts; the
 * local fallback exists so the app can be run by hand while developing.
 */
const DATA_DIR = process.env.ISOMUX_APP_DATA_DIR
  ? resolve(process.env.ISOMUX_APP_DATA_DIR)
  : resolve(HERE, "app-data");
if (!process.env.ISOMUX_APP_DATA_DIR) {
  console.warn(
    `ISOMUX_APP_DATA_DIR is not set; keeping renders in ${DATA_DIR}`,
  );
}
const RENDERS = join(DATA_DIR, "renders");
const WORK = join(DATA_DIR, "work");
mkdirSync(RENDERS, { recursive: true });
mkdirSync(WORK, { recursive: true });

/**
 * Find an ffmpeg that is NOT under tmp/.
 *
 * Re-checked on every request rather than cached at startup, so installing it
 * while the app is running is enough - no restart needed.
 */
const findFfmpeg = () => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return "ffmpeg";
  } catch {
    const dep = join(REPO, "node_modules/ffmpeg-static/ffmpeg");
    return existsSync(dep) ? dep : null;
  }
};

/* ------------------------------------------------------------------ jobs -- */

/**
 * The two things a person may paste: a bare game id, or the wallgame.io link
 * that contains one.
 *
 * This used to take the LAST PATH SEGMENT OF ANY STRING and accept it if the
 * segment looked like an id. Review found the hole on 2026-08-20:
 * `../../etc/passwd` came in as the id `passwd` and was queued as a real
 * render. The id is not inert - it becomes a filename under RENDERS, a
 * directory under WORK and an argument to a child process - so "there is
 * something id-shaped somewhere in this string" is the wrong question. The
 * right one is "is this string one of the two shapes we document", and
 * anything else is refused rather than salvaged.
 */
const GAME_ID = /^[A-Za-z0-9_-]{4,40}$/;
const GAME_HOSTS = new Set(["wallgame.io", "www.wallgame.io"]);
const parseGameId = (input) => {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  if (GAME_ID.test(trimmed)) return trimmed;

  // A link. The scheme is optional because "wallgame.io/game/X" is a
  // reasonable thing to paste out of an address bar.
  let url;
  try {
    url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    return null;
  }
  if (!GAME_HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "game") return null;
  return GAME_ID.test(parts[1]) ? parts[1] : null;
};

const ASPECTS = new Set(["fit", "square", "9x16"]);
const THEMES = new Set(["crisp", "default"]);

/** gameId -> {state, message, error, startedAt, options} */
const jobs = new Map();
const queue = [];
let running = null;

const metaPath = (id) => join(RENDERS, `${id}.json`);
const videoPath = (id) => join(RENDERS, `${id}.mp4`);

/**
 * Where a render writes while it is still a render.
 *
 * RENDERS holds finished videos and nothing else, which is what lets the cache
 * check stay as simple as "is the file there". The scratch file therefore
 * lives under WORK, beside the frame directory of the same job, and only ever
 * reaches RENDERS by rename - one filesystem operation that either happened or
 * did not. Both directories are under DATA_DIR, so the rename never crosses a
 * filesystem and never degrades into a copy.
 *
 * The counter is not decoration. A render that overran its deadline may still
 * be dying while the next attempt starts, and the two must not be handed the
 * same path to write.
 */
let renderSeq = 0;
const scratchVideoPath = (id, seq) => join(WORK, `${id}.render-${seq}.mp4`);
const scratchMetaPath = (id, seq) => join(WORK, `${id}.render-${seq}.json`);

const discard = (path) => {
  try {
    unlinkSync(path);
  } catch {
    /* it was never created, or is already gone */
  }
};

/**
 * How long one render may take before the app gives up on it.
 *
 * Measured 2026-08-20 on this box: game S8QCD3Z0, 37 plies, renders in 92 s
 * end to end - browser start, 38 board captures, ffmpeg mux. Twelve minutes is
 * nearly eight times that, which leaves room for a much longer game and for a
 * box that is busy, while still being a duration a person waiting on the page
 * would recognise as "this is not coming back".
 *
 * The value is a constant rather than a flag on purpose. It is not a per-render
 * choice: it exists so that ONE stuck child cannot hold the single-render queue
 * against every other game, which is what it did before this existed. The one
 * caller that may move it is the test that proves it works.
 */
const RENDER_DEADLINE_MS = Number(plumbing("deadline-ms") ?? 12 * 60 * 1000);

/** Time between asking a child to stop and insisting. */
const KILL_GRACE_MS = 10 * 1000;

const readMeta = (id) => {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf8"));
  } catch {
    return null;
  }
};

/**
 * Run one render to completion, to failure, or to its deadline.
 *
 * The renderer's own stdout is the progress: each line it prints is a real
 * step, so the newest one becomes the message the page shows. On failure the
 * child's stderr is kept and returned verbatim - a bad id, a game that does
 * not exist and a missing ffmpeg are three different problems and "something
 * went wrong" would hide which. BOTH ARE UNTRUSTED and the page treats them as
 * text; see point 5 in the header.
 *
 * SUCCESS IS THE RENAME, not the exit code. A renderer that exits 0 having
 * written nothing, and an ffmpeg that dies part way leaving a truncated file,
 * both used to end with something at the cached path that the next request
 * would serve as a finished video.
 *
 * The deadline kills the whole PROCESS GROUP, not the child. The child is a
 * node process that itself spawns Chrome and ffmpeg, and signalling only the
 * parent would leave those two holding the memory this app queues renders to
 * protect. `detached` puts them all in one group so one signal reaches all of
 * them.
 *
 * After the kill this still WAITS for close before it lets the queue move on.
 * A child that survived SIGKILL would hold the queue - but starting a second
 * render next to a first that is still alive is the out-of-memory kill this
 * box has form for, and that is the worse of the two. Waiting is deliberate.
 */
const runRender = (id, options) =>
  new Promise((done) => {
    const job = jobs.get(id);
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      job.state = "error";
      job.error =
        "ffmpeg is not installed on this machine, and this app deliberately " +
        "does not use the scratch copy under tmp/. Install it (apt install " +
        "ffmpeg) and press render again - no restart needed.";
      return done();
    }

    const generation = ++renderSeq;
    const scratch = scratchVideoPath(id, generation);
    const scratchMeta = scratchMetaPath(id, generation);
    discard(scratch);
    discard(scratchMeta);

    const args = [
      RENDERER,
      "--game",
      id,
      "--out",
      scratch,
      "--work",
      join(WORK, id),
      "--ffmpeg",
      ffmpeg,
      "--seconds-per-move",
      String(options.secondsPerMove),
      "--aspect",
      options.aspect,
      "--board-theme",
      options.boardTheme,
    ];
    if (!options.music) args.push("--no-music");

    job.state = "rendering";
    job.message = "starting the browser";
    const child = spawn(process.execPath, args, { cwd: REPO, detached: true });

    /** Signal the child and everything it started. */
    const stopGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };

    let expired = false;
    let insist = null;
    const deadline = setTimeout(() => {
      expired = true;
      stopGroup("SIGTERM");
      insist = setTimeout(() => stopGroup("SIGKILL"), KILL_GRACE_MS);
    }, RENDER_DEADLINE_MS);

    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const lines = String(chunk).trim().split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) job.message = last.replace(/^\[video\]\s*/, "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    /**
     * A job settles once. A child that fails to spawn emits BOTH `error` and
     * `close`, and without this the close handler would overwrite "could not
     * be started" - the message that says what is wrong - with "exited with
     * code null and said nothing". It also puts the timer cleanup on every
     * exit path rather than only on close.
     */
    let settled = false;
    const finish = () => {
      clearTimeout(deadline);
      if (insist) clearTimeout(insist);
      settled = true;
      done();
    };

    const fail = (reason) => {
      if (settled) return;
      discard(scratch);
      discard(scratchMeta);
      job.state = "error";
      job.error = reason;
      finish();
    };

    child.on("error", (err) =>
      fail(`the renderer could not be started: ${String(err?.message ?? err)}`),
    );

    child.on("close", (code) => {
      if (settled) return;

      if (expired) {
        const minutes = Math.round(RENDER_DEADLINE_MS / 60000);
        return fail(
          `this render was still going after ${minutes} minutes, so it was ` +
            `stopped and the queue moved on. Nothing was saved. If the game ` +
            `is a very long one, try again with a smaller seconds per move.`,
        );
      }
      if (code !== 0) {
        return fail(
          stderr.trim().split("\n").slice(-12).join("\n") ||
            `the renderer exited with code ${code} and said nothing`,
        );
      }
      if (!existsSync(scratch) || statSync(scratch).size === 0) {
        return fail(
          "the renderer reported success but left no video. Nothing was " +
            "saved, and any video already made for this game was kept.",
        );
      }

      /*
        Publish, VIDEO FIRST.

        An earlier version wrote the metadata straight to its final path before
        renaming the video, on the reasoning that a metadata file with no video
        beside it can never be read. That reasoning died the moment a failed
        re-render started keeping the old video: on a forced re-render there IS
        an old video, so writing the new metadata first and then failing the
        rename left Nil's existing video described by the bytes, options and
        timestamp of the render that did not happen.

        So both files are staged, and the video rename is the commit point:

          rename video   fails -> old video AND old metadata are untouched
          rename meta    fails -> the new video is live, so the old metadata
                                  now describes the wrong generation and is
                                  removed rather than left to lie. The page
                                  then says "Ready" without a size, which is
                                  missing information rather than false
                                  information.
      */
      try {
        const meta = {
          gameId: id,
          options,
          bytes: statSync(scratch).size,
          renderedAt: new Date().toISOString(),
        };
        writeFileSync(scratchMeta, JSON.stringify(meta, null, 2));
        renameSync(scratch, videoPath(id));
        try {
          renameSync(scratchMeta, metaPath(id));
        } catch {
          discard(metaPath(id));
        }
        job.state = "done";
        job.message = "ready";
        job.meta = meta;
        finish();
      } catch (err) {
        discard(scratchMeta);
        fail(
          `the video was made but could not be saved: ${String(err?.message ?? err)}`,
        );
      }
    });
  });

/** One at a time. See the header. */
const pump = async () => {
  if (running || queue.length === 0) return;
  running = queue.shift();
  const job = jobs.get(running);
  try {
    await runRender(running, job.options);
  } catch (err) {
    job.state = "error";
    job.error = String(err?.message ?? err);
  }
  running = null;
  for (const [, j] of jobs) {
    if (j.state === "queued")
      j.message = `waiting - ${queue.indexOf(j.gameId) + 1} ahead`;
  }
  pump();
};

const enqueue = (id, options) => {
  jobs.set(id, {
    gameId: id,
    state: "queued",
    message:
      queue.length === 0 && !running
        ? "next"
        : `waiting, ${queue.length + 1} in the queue`,
    error: null,
    options,
  });
  queue.push(id);
  pump();
};

/* ------------------------------------------------------------------ page -- */

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wall Game video</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f1c; color: #e2e8f0;
         margin: 0; padding: 40px 20px; display: flex; justify-content: center; }
  main { width: 100%; max-width: 620px; }
  h1 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
  p.sub { color: #94a3b8; margin: 0 0 24px; font-size: 14px; }
  label { display: block; font-size: 13px; color: #94a3b8; margin: 14px 0 4px; }
  input[type=text], select, input[type=number] {
    width: 100%; padding: 10px 12px; font-size: 15px; border-radius: 8px;
    border: 1px solid #334155; background: #121a2e; color: #e2e8f0; box-sizing: border-box; }
  .row { display: flex; gap: 12px; } .row > div { flex: 1; }
  button { margin-top: 20px; width: 100%; padding: 12px; font-size: 15px; font-weight: 700;
    border: 0; border-radius: 8px; background: #ff8c42; color: #1a1005; cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
  #out { margin-top: 24px; font-size: 14px; line-height: 1.5; }
  .box { padding: 14px; border-radius: 8px; background: #121a2e; border: 1px solid #334155; }
  .err { border-color: #7f1d1d; background: #1c0f13; white-space: pre-wrap;
         font-family: ui-monospace, monospace; font-size: 12px; }
  a.dl { display: inline-block; margin-top: 10px; color: #ff8c42; font-weight: 700; }
  .muted { color: #64748b; font-size: 12px; margin-top: 18px; }
</style></head>
<body><main>
  <h1>Wall Game video</h1>
  <p class="sub">Paste a game link. One render at a time.</p>

  <label for="game">Game URL or id</label>
  <input type="text" id="game" placeholder="https://wallgame.io/game/S8QCD3Z0" autofocus />

  <div class="row">
    <div><label for="spm">Seconds per move</label>
      <input type="number" id="spm" value="0.8" min="0.05" max="10" step="0.05" /></div>
    <div><label for="aspect">Shape</label>
      <select id="aspect">
        <option value="fit">Fit the content</option>
        <option value="square">Square</option>
        <option value="9x16">Tall (Shorts, TikTok)</option>
      </select></div>
  </div>
  <div class="row">
    <div><label for="music">Music</label>
      <select id="music"><option value="on">On (random track)</option>
        <option value="off">Off</option></select></div>
    <div><label for="theme">Board theme</label>
      <select id="theme"><option value="crisp">Crisp</option>
        <option value="default">Default</option></select></div>
  </div>

  <button id="go">Make the video</button>
  <div id="out"></div>
  <p class="muted">A render loads the real replay page once, which adds one view
    to that game's count. Asking again returns the file already made; use
    re-render only when you want different settings.</p>
</main>
<script>
  // NOTHING HERE MAY USE innerHTML. The progress message is the renderer's
  // stdout, which names the two PLAYERS of the game being rendered, and the
  // error is a child process's stderr. A player can choose their display name.
  // Every string that came from the server is put on the page as text.
  const $ = (id) => document.getElementById(id);
  const out = $("out");
  let timer = null;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const show = (node) => { out.replaceChildren(node); };
  const link = (text, onClick) => {
    const a = el("a", "dl", text);
    a.href = "#";
    a.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
    return a;
  };

  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = null;
    $("go").disabled = false;
  };

  const readyBox = (id, meta) => {
    const box = el("div", "box",
      meta ? "Ready - " + (meta.bytes / 1e6).toFixed(1) + " MB" : "Ready");
    const download = el("a", "dl", "Download " + id + ".mp4");
    download.href = "/api/video?game=" + encodeURIComponent(id);
    download.download = id + ".mp4";
    box.append(el("br"), download, el("br"),
      link("Re-render with these settings", () => rerender(id)));
    return box;
  };

  const poll = async (id) => {
    const r = await fetch("/api/status?game=" + encodeURIComponent(id));
    const s = await r.json();
    if (s.state === "done") {
      stopPolling();
      show(readyBox(id, s.meta));
    } else if (s.state === "error") {
      stopPolling();
      show(el("div", "box err", s.error || "unknown error"));
    } else {
      show(el("div", "box",
        (s.state === "queued" ? "Queued" : "Rendering") + " - " + (s.message || "")));
    }
  };

  const start = async (force) => {
    const body = {
      game: $("game").value, secondsPerMove: Number($("spm").value),
      aspect: $("aspect").value, music: $("music").value === "on",
      boardTheme: $("theme").value, force: Boolean(force),
    };
    $("go").disabled = true;
    show(el("div", "box", "Asking..."));
    const r = await fetch("/api/render", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const s = await r.json();
    if (!r.ok) {
      $("go").disabled = false;
      return show(el("div", "box err", s.error || "could not start"));
    }
    if (timer) clearInterval(timer);
    poll(s.gameId);
    timer = setInterval(() => poll(s.gameId), 1500);
  };

  const rerender = (id) => { $("game").value = id; start(true); };
  $("go").onclick = () => start(false);
  $("game").addEventListener("keydown", (e) => { if (e.key === "Enter") start(false); });
</script></body></html>`;

/* ---------------------------------------------------------------- routing -- */

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * The form's request is about 150 bytes. This is not a tuning knob: it is here
 * because the body was previously read until the sender chose to stop, and an
 * unbounded string is a way to grow this process until the box's out-of-memory
 * killer picks something - which on this box is usually not the guilty
 * process.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The body, or null if the sender went over the limit.
 *
 * Reading stops at the limit but the socket is left alone: destroying it here
 * loses the race against the 413, and the sender then sees a dropped
 * connection instead of the reason. The caller answers first and hangs up
 * after.
 */
const readBody = async (req) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * The pace the renderer will accept. The bounds and the sentence that reports
 * them are the same two numbers, because they drifted apart once already: the
 * check allowed anything above zero while the message promised a floor of
 * 0.05, and review got 0.01 accepted and queued on 2026-08-20.
 */
const MIN_SECONDS_PER_MOVE = 0.05;
const MAX_SECONDS_PER_MOVE = 10;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  if (req.method === "POST" && url.pathname === "/api/render") {
    const raw = await readBody(req);
    if (raw === null) {
      res.writeHead(413, {
        "content-type": "application/json",
        connection: "close",
      });
      res.end(
        JSON.stringify({
          error: "that request was far larger than this page ever sends",
        }),
      );
      return;
    }
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "that request was not valid JSON" });
    }

    const id = parseGameId(body.game);
    if (!id) {
      return json(res, 400, {
        error:
          "that does not look like a game link or id. Expected something like " +
          "https://wallgame.io/game/S8QCD3Z0 or just S8QCD3Z0.",
      });
    }
    const secondsPerMove = Number(body.secondsPerMove);
    if (
      !Number.isFinite(secondsPerMove) ||
      secondsPerMove < MIN_SECONDS_PER_MOVE ||
      secondsPerMove > MAX_SECONDS_PER_MOVE
    ) {
      return json(res, 400, {
        error: `seconds per move must be between ${MIN_SECONDS_PER_MOVE} and ${MAX_SECONDS_PER_MOVE}`,
      });
    }
    const aspect = ASPECTS.has(body.aspect) ? body.aspect : "fit";
    const boardTheme = THEMES.has(body.boardTheme) ? body.boardTheme : "crisp";
    const options = {
      secondsPerMove,
      aspect,
      music: body.music !== false,
      boardTheme,
    };

    /*
      AN ACTIVE RENDER OUTRANKS THE CACHE, and this order is the whole point.

      The cache check used to come first and install a fresh `done` entry in
      the jobs map whenever a video existed. A forced re-render leaves the old
      video in place on purpose, so during one of those a plain request for the
      same game found that old file and REPLACED the live job entry. The render
      kept going against the object it had captured, while the page reported
      "already rendered" throughout - and went on reporting it after the new
      video had landed, because nothing put the real job back.

      So the active job is answered before the cache is consulted, for a forced
      request as well as a plain one: whichever arrives second joins the render
      already in flight rather than starting or masking one.
    */
    const current = jobs.get(id);
    if (
      current &&
      (current.state === "queued" || current.state === "rendering")
    ) {
      return json(res, 200, { gameId: id, alreadyRunning: true });
    }

    // Cached, unless a re-render was asked for.
    if (!body.force && existsSync(videoPath(id))) {
      jobs.set(id, {
        gameId: id,
        state: "done",
        message: "already rendered",
        meta: readMeta(id),
      });
      return json(res, 200, { gameId: id, cached: true });
    }
    // A re-render deliberately does NOT delete the current video first. The
    // old file stays readable and downloadable for the whole render and is
    // replaced only when a new one exists; a render that fails costs nothing.

    enqueue(id, options);
    return json(res, 200, { gameId: id });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const id = parseGameId(url.searchParams.get("game"));
    if (!id) return json(res, 400, { error: "no game id" });
    const job = jobs.get(id);
    if (job) {
      return json(res, 200, {
        state: job.state,
        message: job.message ?? null,
        error: job.error ?? null,
        meta: job.meta ?? null,
      });
    }
    if (existsSync(videoPath(id))) {
      return json(res, 200, {
        state: "done",
        message: "already rendered",
        meta: readMeta(id),
      });
    }
    return json(res, 404, {
      state: "unknown",
      error: "no render for that game",
    });
  }

  if (req.method === "GET" && url.pathname === "/api/video") {
    const id = parseGameId(url.searchParams.get("game"));
    if (!id || !existsSync(videoPath(id))) {
      return json(res, 404, { error: "no video for that game yet" });
    }
    const file = videoPath(id);
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": statSync(file).size,
      "content-disposition": `attachment; filename="${id}.mp4"`,
    });
    return createReadStream(file).pipe(res);
  }

  json(res, 404, { error: "no such path" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`game-video app listening on ${PORT}`);
  console.log(`renders kept in ${RENDERS}`);
  const ffmpeg = findFfmpeg();
  console.log(
    ffmpeg
      ? `ffmpeg: ${ffmpeg}`
      : "ffmpeg: NOT FOUND. The page will load and every render will fail with " +
          "that message until it is installed. This app will not use the scratch " +
          "copy under tmp/, which gets cleaned.",
  );
});
