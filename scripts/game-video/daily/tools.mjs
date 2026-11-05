/**
 * The director's tools (Wall Game Director, 2026-10-29: "each one below I
 * typed by hand several times"; Nil, 2026-10-29: a toolkit that keeps
 * growing as a byproduct of the work). Each one reads a video file and
 * writes only into TOOLS_DIR: a tile PNG, a crop, a few lines of sound
 * levels, or an A/B copy at feed level. None of them touches an item.
 *
 * crew.mjs runs them (scan, strip, crop, audio, fullcheck, loudness-ab);
 * the plans and the parsers of ffmpeg's output are pure, for the tests.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardGrid } from "../board-grid.mjs";
import { FRAME } from "../edl.mjs";
import {
  SILENCE_DETECT_SECONDS,
  SILENCE_FILTER,
  SILENCE_FLOOR_DBFS,
  parseSilences,
} from "../mix-loudness.mjs";

/** Where every tool writes. Never the app's folders. */
export const TOOLS_DIR = join(tmpdir(), "daily-tools");

/** Tiles per row of a scan: 7 tiles of 270 px fit a screen. */
const SCAN_COLUMNS = 7;
/** The most frames a strip takes: 24 of 200 px is a wide PNG already. */
export const STRIP_MOST = 24;
/** The feed's loudness (the platforms normalize to about -14 LUFS). */
export const FEED_LUFS = -14;

/** Run ffmpeg or ffprobe; stderr (where ffmpeg reports) or a throw. */
const run = (bin, args) => {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${bin} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    const last = (r.stderr ?? "").trim().split("\n").slice(-2).join(" ");
    throw new Error(`${bin} failed (exit ${r.status}): ${last}`);
  }
  return { stdout: r.stdout, stderr: r.stderr };
};
const ffmpeg = (args) =>
  run("ffmpeg", ["-nostdin", "-hide_banner", ...args]).stderr;

/**
 * The video's facts: duration, frame size and rate, codecs, the audio's
 * sample rate (null with no audio).
 */
export const probe = (video) => {
  const { stdout } = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate:format=duration",
    "-of",
    "json",
    video,
  ]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error(`${video} has no video stream`);
  const [num, den] = v.r_frame_rate.split("/").map(Number);
  return {
    duration: Number(info.format.duration),
    width: v.width,
    height: v.height,
    fps: den ? num / den : null,
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name ?? null,
    sampleRate: a ? Number(a.sample_rate) : null,
  };
};

const round = (x, places = 2) => Number(x.toFixed(places));

/**
 * The latest second a seek still finds a frame at: a frame and a half
 * before the end. The format's duration runs to the end of the last
 * frame (and of the sound), so a seek to the last 0.05 s of a 15 fps
 * video finds nothing, and ffmpeg then writes no file and exits 0.
 */
export const lastFrameAt = ({ duration, fps }) =>
  round(Math.max(0, duration - (fps ? 1.5 / fps : 0.1)));

/** One frame at second `at` through filter `vf` into `out`, or a throw. */
const frameAt = ({ video, at, vf, out }) => {
  ffmpeg([
    "-v",
    "error",
    "-y",
    "-ss",
    String(at),
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    vf,
    out,
  ]);
  if (!existsSync(out)) throw new Error(`the video has no frame at ${at} s`);
  return out;
};

/** A scan's tiles: one every `every` s from 0, in rows of SCAN_COLUMNS. */
export const scanPlan = (duration, every) => {
  if (!(every > 0)) throw new Error(`--every must be over 0, got ${every}`);
  const count = Math.max(1, Math.ceil(duration / every));
  const columns = Math.min(SCAN_COLUMNS, count);
  return {
    count,
    columns,
    rows: Math.ceil(count / columns),
    times: Array.from({ length: count }, (_, i) => round(i * every)),
  };
};

/**
 * A strip's frames: `fps` a second over [from, from + seconds), up to the
 * last frame a seek finds (`last`, lastFrameAt).
 */
export const stripTimes = (from, seconds, fps, last) => {
  if (!(from >= 0 && from <= last)) {
    throw new Error(`--from must be in 0..${last} s, got ${from}`);
  }
  if (!(seconds > 0))
    throw new Error(`--seconds must be over 0, got ${seconds}`);
  if (!(fps > 0)) throw new Error(`--fps must be over 0, got ${fps}`);
  const count = Math.round(seconds * fps);
  if (count < 1) throw new Error("the strip has no frame: give more --seconds");
  if (count > STRIP_MOST) {
    throw new Error(
      `${count} frames is too many for one strip (${STRIP_MOST} at most): give fewer --seconds or a lower --fps`,
    );
  }
  return Array.from({ length: count }, (_, i) => round(from + i / fps)).filter(
    (t) => t <= last,
  );
};

/** "X,Y,W,H" in the video's pixels, inside its frame. */
export const cropBox = (text, { width, height }) => {
  const parts = String(text ?? "").split(",");
  const [x, y, w, h] = parts.map(Number);
  if (parts.length !== 4 || ![x, y, w, h].every(Number.isInteger)) {
    throw new Error(`--box is X,Y,W,H in whole pixels, got ${text}`);
  }
  if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) {
    throw new Error(`--box ${text} is not inside the ${width}x${height} frame`);
  }
  return { x, y, w, h };
};

const isRect = (r) =>
  ["x", "y", "width", "height"].every((k) => Number.isFinite(r?.[k]));

/**
 * The renderer's RESULT.layout.grid ({clip, first, last, cols, rows}, css
 * px of the full FRAME, board-grid.mjs's shape), or null: a style other
 * than wallz has none, and a kit from before it sends none.
 */
export const gridOf = (g) =>
  isRect(g?.clip) &&
  isRect(g.first) &&
  isRect(g.last) &&
  Number.isInteger(g.cols) &&
  Number.isInteger(g.rows) &&
  g.cols >= 2 &&
  g.rows >= 2
    ? { clip: g.clip, first: g.first, last: g.last, cols: g.cols, rows: g.rows }
    : null;

/**
 * The events that move the board for all or part of their span: a zoom
 * (and its lead push), a freeze (the camera pushes in) and a blunder (the
 * board shakes over its first half second; the whole span, to be safe).
 */
const MOVES_BOARD = ["zoom", "freeze", "blunder"];

/**
 * Why the board is not at rest at second `at`, or null. The grid holds
 * only at rest (Video Reviewer 1, 2026-10-29): an event of MOVES_BOARD,
 * the ending from the last move on (it moves or scales the board, or
 * shakes it on a capture, and RESULT.timeline has no span for it; Video
 * Reviewer 2, 2026-10-29), and a cold open, a zoom before the first move.
 */
export const boardMoved = (timeline, at, { coldOpen }) => {
  const inside = timeline.events.find(
    (e) => MOVES_BOARD.includes(e.kind) && at >= e.start && at <= e.end,
  );
  if (inside) {
    return `${at} s is inside the ${inside.kind} on ply ${inside.ply} (${inside.start}-${inside.end} s)`;
  }
  const last = Math.max(...timeline.moves.map((m) => m.at));
  if (at >= last) {
    return `${at} s is at or after the last move (${last} s): the ending moves the board`;
  }
  const first = timeline.moves[0]?.at;
  if (coldOpen && first !== undefined && at < first) {
    return `${at} s is before the first move (${first} s), and the list has a cold open (a zoom)`;
  }
  return null;
};

/**
 * The crop box around a cell ("e7": column a.., row 1 at the bottom, as
 * the lint names cells) with `radius` cells on each side, cut at the
 * board's edge: whole pixels of a video of `width` x `height`. The grid is
 * in px of the full FRAME, so a draft video (half size) scales it.
 */
export const cellBox = (cell, radius, grid, { width, height }) => {
  const m = /^([a-z])([0-9]{1,2})$/.exec(String(cell ?? ""));
  const g = boardGrid(grid);
  const col = m ? m[1].charCodeAt(0) - 97 : -1;
  const row = m ? g.rows - Number(m[2]) : -1;
  if (col < 0 || col >= g.cols || row < 0 || row >= g.rows) {
    throw new Error(
      `--cell is a cell of the ${g.cols}x${g.rows} board, a1 to ${String.fromCharCode(96 + g.cols)}${g.rows}, got ${cell}`,
    );
  }
  if (!(Number.isInteger(radius) && radius >= 0)) {
    throw new Error(`--radius is a whole number of cells, got ${radius}`);
  }
  const scale = width / FRAME.w;
  if (Math.abs(height / FRAME.h - scale) > 0.01) {
    throw new Error(
      `the ${width}x${height} video is not ${FRAME.w}x${FRAME.h} or a scale of it`,
    );
  }
  const { clip } = grid;
  const px = (u) => (clip.x + g.x(u) * clip.width) * scale;
  const py = (v) => (clip.y + g.y(v) * clip.height) * scale;
  const x0 = Math.max(0, Math.floor(px(Math.max(0, col - radius))));
  const y0 = Math.max(0, Math.floor(py(Math.max(0, row - radius))));
  const x1 = Math.min(width, Math.ceil(px(Math.min(g.cols, col + radius + 1))));
  const y1 = Math.min(
    height,
    Math.ceil(py(Math.min(g.rows, row + radius + 1))),
  );
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/**
 * ametadata's print lines as [time, value] pairs: each frame prints its
 * pts_time, then the key's value ("-inf" for digital silence).
 */
export const metadataSeries = (stderr, key) => {
  const out = [];
  let at = null;
  for (const line of stderr.split("\n")) {
    const t = /pts_time:([-\d.]+)/.exec(line);
    if (t) at = Number(t[1]);
    const v = new RegExp(`${key.replaceAll(".", "\\.")}=(-?inf|[-\\d.]+)`).exec(
      line,
    );
    if (v && at !== null) {
      out.push([at, v[1].endsWith("inf") ? -Infinity : Number(v[1])]);
      at = null;
    }
  }
  return out;
};

/**
 * The short-term loudness at each whole second, from [time, LUFS] pairs.
 * Short-term covers the 3 s before its time, and ebur128 gives a floor
 * value (about -121) until it has 3 s, so the list starts at 3 s.
 */
export const shortTermPerSecond = (series) => {
  const perSecond = new Map();
  for (const [t, v] of series) {
    const s = Math.floor(t + 1e-6);
    if (s >= 3 && !perSecond.has(s)) perSecond.set(s, v);
  }
  return [...perSecond];
};

/** ebur128's summary: integrated LUFS and true peak (dBFS). */
export const loudnessSummary = (stderr) => {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const i = /I:\s+([-\d.]+) LUFS/.exec(summary);
  const p = /Peak:\s+(-?inf|[-\d.]+) dBFS/.exec(summary);
  if (!i) throw new Error("ffmpeg gave no integrated loudness");
  return {
    lufs: Number(i[1]),
    truePeak: p ? (p[1].endsWith("inf") ? -Infinity : Number(p[1])) : null,
  };
};

const db = (x) => (x === -Infinity ? "-inf" : x.toFixed(1));

/** The gain that brings `lufs` to `target`, in dB. */
export const feedGain = (lufs, target = FEED_LUFS) => round(target - lufs, 1);

/** How many runs' folders TOOLS_DIR keeps (an A/B copy is about 8 MB). */
const RUNS_KEPT = 30;

/** A run's folder: its name, a dash and mkdtemp's 6 characters. */
const RUN_FOLDER = /^.+-[A-Za-z0-9]{6}$/;

/**
 * A new folder in TOOLS_DIR for one run, named after what it reads. The
 * oldest run folders over RUNS_KEPT go first; nothing else in TOOLS_DIR is
 * deleted. TOOLS_DIR must be a real folder of this user, not a link, as
 * render-4090.mjs's ssh socket folder.
 */
const workDir = (name) => {
  mkdirSync(TOOLS_DIR, { recursive: true, mode: 0o700 });
  const own = lstatSync(TOOLS_DIR);
  if (!own.isDirectory() || own.uid !== process.getuid?.()) {
    throw new Error(`${TOOLS_DIR} is not a folder of this user`);
  }
  const runs = readdirSync(TOOLS_DIR)
    .filter((f) => RUN_FOLDER.test(f))
    .map((f) => ({
      path: join(TOOLS_DIR, f),
      stat: lstatSync(join(TOOLS_DIR, f)),
    }))
    .filter((r) => r.stat.isDirectory())
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  for (const old of runs.slice(0, Math.max(0, runs.length - RUNS_KEPT + 1))) {
    rmSync(old.path, { recursive: true, force: true });
  }
  return mkdtempSync(join(TOOLS_DIR, `${name}-`));
};

/** One tile PNG of the whole video: a frame every `every` s. */
export const scan = ({ video, name, every }) => {
  const info = probe(video);
  const plan = scanPlan(info.duration, every);
  const out = join(workDir(name), "scan.png");
  ffmpeg([
    "-v",
    "error",
    "-y",
    "-i",
    video,
    "-vf",
    `fps=1/${every},scale=270:480,tile=${plan.columns}x${plan.rows}:padding=4:color=white`,
    "-frames:v",
    "1",
    out,
  ]);
  return [
    `scan: ${out}`,
    `  ${plan.count} tiles, ${plan.columns} a row, one every ${every} s of ${round(info.duration)} s: tile k (from 0, by rows) is at about k x ${every} s`,
  ];
};

/** One PNG of the frames of [from, from + seconds) at `fps`. */
export const strip = ({ video, name, from, seconds, fps }) => {
  const info = probe(video);
  const times = stripTimes(from, seconds, fps, lastFrameAt(info));
  const out = join(workDir(name), `strip-${from}s.png`);
  ffmpeg([
    "-v",
    "error",
    "-y",
    "-ss",
    String(from),
    "-t",
    // Only the frames that exist: a strip past the end is cut there.
    String(round(times.length / fps, 3)),
    "-i",
    video,
    "-vf",
    `fps=${fps},scale=200:356,tile=${times.length}x1:padding=3:color=white`,
    "-frames:v",
    "1",
    out,
  ]);
  if (!existsSync(out)) throw new Error(`the video has no frame at ${from} s`);
  return [
    `strip: ${out}`,
    `  ${times.length} frames at ${times.join(" ")} s${times.length < Math.round(seconds * fps) ? " (the video ends there)" : ""}`,
  ];
};

/**
 * One full-size crop of the frame at second `at`: of `box` ("X,Y,W,H"), or
 * around `cell` ({cell, radius, grid, timeline, coldOpen}, from the item's
 * render) when the board is at rest there.
 * @param {{ video: string, name: string, at: number, box?: string,
 *   cell?: { cell: string, radius: number, grid: any, timeline: any,
 *   coldOpen: boolean } }} o
 */
export const crop = ({ video, name, at, box, cell }) => {
  const info = probe(video);
  const last = lastFrameAt(info);
  if (!(at >= 0 && at <= last)) {
    throw new Error(`--at must be in 0..${last} s, got ${at}`);
  }
  let b;
  if (cell) {
    const moved = boardMoved(cell.timeline, at, cell);
    if (moved)
      throw new Error(`${moved}: --cell holds only at rest; use --box`);
    b = cellBox(cell.cell, cell.radius, cell.grid, info);
  } else {
    b = cropBox(box, info);
  }
  const out = frameAt({
    video,
    at,
    vf: `crop=${b.w}:${b.h}:${b.x}:${b.y}`,
    out: join(workDir(name), `crop-${at}s.png`),
  });
  return [
    `crop: ${out}`,
    `  ${b.w}x${b.h} at ${b.x},${b.y} of the ${info.width}x${info.height} frame, t=${at} s${cell ? ` (${cell.cell}, radius ${cell.radius}; --box ${b.x},${b.y},${b.w},${b.h})` : ""}`,
  ];
};

/**
 * The sound of a range (or of the whole video): every gap, the loudness
 * and true peak, and with a range the peak of each 0.1 s.
 * @param {{ video: string, from?: number, seconds?: number }} options
 */
export const audio = ({ video, from, seconds }) => {
  const info = probe(video);
  if (!info.sampleRate) return ["audio: the video has no sound"];
  const ranged = from !== undefined;
  if (ranged && !(from >= 0 && seconds > 0)) {
    throw new Error(
      "audio needs --from T (0 or more) with --seconds D (over 0)",
    );
  }
  const start = ranged ? from : 0;
  const end = ranged ? Math.min(info.duration, from + seconds) : info.duration;
  const window = ranged ? ["-ss", String(from), "-t", String(seconds)] : [];
  // One 0.1 s window is a tenth of the sample rate (4410 at 44.1 kHz).
  const tenth = Math.round(info.sampleRate / 10);
  const filters = [
    SILENCE_FILTER,
    "ebur128=peak=true",
    ...(ranged
      ? [
          `asetnsamples=n=${tenth}`,
          "astats=metadata=1:reset=1",
          "ametadata=print:key=lavfi.astats.Overall.Peak_level",
        ]
      : []),
  ];
  const stderr = ffmpeg([
    "-nostats",
    ...window,
    "-i",
    video,
    "-af",
    filters.join(","),
    "-f",
    "null",
    "-",
  ]);
  const lines = [
    `audio of ${ranged ? `${round(start)}-${round(end)} s` : `the whole video (${round(end)} s)`}:`,
  ];
  const { lufs, truePeak } = loudnessSummary(stderr);
  lines.push(
    `  loudness ${lufs.toFixed(1)} LUFS, true peak ${truePeak === null ? "?" : db(truePeak)} dBFS`,
  );
  const gaps = parseSilences(stderr, end - start).map((g) => ({
    ...g,
    start: round(g.start + start),
    end: round(g.end + start),
  }));
  lines.push(
    gaps.length
      ? `  silence (under ${SILENCE_FLOOR_DBFS} dBFS for ${SILENCE_DETECT_SECONDS} s or more): ${gaps.map((g) => `${g.start}-${g.end} (${g.seconds} s)`).join(", ")}`
      : `  no silence of ${SILENCE_DETECT_SECONDS} s or more`,
  );
  if (ranged) {
    const peaks = metadataSeries(stderr, "lavfi.astats.Overall.Peak_level");
    // Ten a line: one line a second.
    for (let i = 0; i < peaks.length; i += 10) {
      const row = peaks.slice(i, i + 10);
      lines.push(
        `  peak dBFS from ${round(start + row[0][0], 1)} s, each 0.1 s: ${row.map(([, v]) => db(v)).join(" ")}`,
      );
    }
  }
  return lines;
};

/**
 * The checks of a final file: codec, size, rate and length; the first and
 * last frames in one PNG; the short-term loudness of each second.
 */
export const fullcheck = ({ video, name }) => {
  const info = probe(video);
  const d = info.duration;
  const last = lastFrameAt(info);
  // The opening (the walks and the names) and the end; the last one is
  // the video's last frame.
  const times = [0.05, 2.0, 3.6, 4.05, d - 3, d - 2, d - 1, d - 0.6, d]
    .map((t) => round(Math.min(t, last)))
    .filter((t, i, all) => t >= 0 && all.indexOf(t) === i);
  const dir = workDir(name);
  const frames = times.map((t, i) =>
    frameAt({ video, at: t, vf: "scale=300:-2", out: join(dir, `f${i}.png`) }),
  );
  const out = join(dir, "frames.png");
  ffmpeg([
    "-v",
    "error",
    "-y",
    ...frames.flatMap((f) => ["-i", f]),
    "-filter_complex",
    frames.length > 1 ? `hstack=inputs=${frames.length}` : "null",
    out,
  ]);
  for (const f of frames) rmSync(f);
  const lines = [
    `fullcheck: ${info.videoCodec} ${info.width}x${info.height} at ${info.fps === null ? "?" : round(info.fps, 3)} fps, ${round(d)} s, audio ${info.audioCodec ?? "none"}${info.sampleRate ? ` ${info.sampleRate} Hz` : ""}`,
    `  start and end frames: ${out}`,
    `  frames at ${times.join(" ")} s`,
  ];
  if (info.sampleRate) {
    const stderr = ffmpeg([
      "-nostats",
      "-i",
      video,
      "-af",
      "ebur128=metadata=1,ametadata=print:key=lavfi.r128.S",
      "-f",
      "null",
      "-",
    ]);
    lines.push(
      `  short-term LUFS each second, from 3 s (each covers the 3 s before it): ${shortTermPerSecond(
        metadataSeries(stderr, "lavfi.r128.S"),
      )
        .map(([s, v]) => `${s}s:${v === -Infinity ? "-inf" : Math.round(v)}`)
        .join(" ")}`,
    );
  }
  return lines;
};

/**
 * A copy at feed level, to compare by ear with the video as it is: the
 * gain to FEED_LUFS, a limiter, then its own loudness and true peak. The
 * copy is never an item's video: it stays in TOOLS_DIR.
 */
export const loudnessAb = ({ video, name, target = FEED_LUFS }) => {
  const info = probe(video);
  if (!info.sampleRate) throw new Error("the video has no sound");
  const measure = (file) =>
    loudnessSummary(
      ffmpeg([
        "-nostats",
        "-i",
        file,
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
      ]),
    );
  const before = measure(video);
  const gain = feedGain(before.lufs, target);
  const out = join(workDir(name), "feed-level.mp4");
  ffmpeg([
    "-v",
    "error",
    "-y",
    "-i",
    video,
    "-c:v",
    "copy",
    "-af",
    `volume=${gain}dB,alimiter=limit=0.84:level=false:attack=2:release=60,aresample=44100`,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    out,
  ]);
  const after = measure(out);
  return [
    `loudness-ab: ${out} (an A/B copy, never an item's video)`,
    `  as it is: ${before.lufs.toFixed(1)} LUFS, true peak ${before.truePeak === null ? "?" : db(before.truePeak)} dBFS`,
    `  the copy: ${gain >= 0 ? "+" : ""}${gain} dB, then the limiter: ${after.lufs.toFixed(1)} LUFS, true peak ${after.truePeak === null ? "?" : db(after.truePeak)} dBFS`,
  ];
};
