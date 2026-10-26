/**
 * Event strips for the director (Nil, 2026-10-26: speed up the edits). For
 * each event of the edit list: four frames of the MP4 and a line that puts
 * each of its sounds against the moment its move lands. The director sees
 * "the bye plays as the mouse moves" here, not by hand with ffmpeg.
 *
 * The times come from the renderer's RESULT.timeline (videoTimeline in
 * timeline-frames.mjs, Video Editor (renderer), 2026-10-26), in seconds from
 * the first frame of the MP4:
 *   moves:  [{ply, at}]                    the first frame after the move
 *   events: [{index, ply, kind, start, end}]  index = position in edl.events
 *   sounds: [{name, role, start, event}]   event = an edl.events index or null
 * A move does not slide: the new position shows on one frame, so a move has
 * one time. The cold open is not in moves.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {{ ply: number, at: number }} TimelineMove
 * @typedef {{ index: number, ply: number, kind: string, start: number, end: number }} TimelineEvent
 * @typedef {{ name: string, role: string, start: number, event: number | null }} TimelineSound
 * @typedef {{ moves: TimelineMove[], events: TimelineEvent[], sounds: TimelineSound[] }} Timeline
 * @typedef {{ index: number, ply: number, frames: { t: number, label: string }[], lines: string[] }} StripRow
 */

const isTime = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const isIndex = (x) => Number.isInteger(x) && x >= 0;
const NAME = /^[a-z0-9_-]{1,40}$/;

/**
 * The timeline of a RESULT, with only the fields above, or null when it is
 * missing or not in that shape (a kit from before the timeline).
 * @returns {Timeline | null}
 */
export const timelineOf = (t) => {
  const ok =
    Array.isArray(t?.moves) &&
    Array.isArray(t.events) &&
    Array.isArray(t.sounds) &&
    t.moves.every((m) => isIndex(m?.ply) && isTime(m.at)) &&
    t.events.every(
      (e) =>
        isIndex(e?.index) &&
        isIndex(e.ply) &&
        NAME.test(e.kind ?? "") &&
        isTime(e.start) &&
        isTime(e.end),
    ) &&
    t.sounds.every(
      (s) =>
        NAME.test(s?.name ?? "") &&
        NAME.test(s.role ?? "") &&
        isTime(s.start) &&
        (s.event === null || isIndex(s.event)),
    );
  if (!ok) return null;
  return {
    moves: t.moves.map(({ ply, at }) => ({ ply, at })),
    events: t.events.map(({ index, ply, kind, start, end }) => ({
      index,
      ply,
      kind,
      start,
      end,
    })),
    sounds: t.sounds.map(({ name, role, start, event }) => ({
      name,
      role,
      start,
      event,
    })),
  };
};

const s2 = (t) => t.toFixed(2);
const signed = (d) => `${d >= 0 ? "+" : "-"}${Math.abs(d).toFixed(2)} s`;

/**
 * One row per event: its four frames (time order, each with a label) and
 * its text lines. The frames are 0.5 s before the move lands, the event's
 * start, the landing, and 0.5 s after the event's start; a time outside the
 * video is held to its first or last frame. The sounds of a row are the
 * event's own and every sound that starts on its move's landing frame (the
 * click). Each says how far its start is from the landing.
 * @param {Timeline} timeline
 * @param {number} durationSeconds
 * @returns {StripRow[]}
 */
export const stripPlan = (timeline, durationSeconds) => {
  const last = Math.max(0, durationSeconds - 0.04);
  const clamp = (t) => Math.min(Math.max(t, 0), last);
  return timeline.events.map((e) => {
    const at = timeline.moves.find((m) => m.ply === e.ply)?.at ?? null;
    const frames = (
      at === null
        ? [
            [e.start - 0.5, "0.5 s before the event"],
            [e.start, "event starts"],
            [e.start + 0.5, "0.5 s after the event starts"],
            [e.end, "event ends"],
          ]
        : [
            [at - 0.5, "0.5 s before the move"],
            [e.start, "event starts"],
            [at, "move lands"],
            [e.start + 0.5, "0.5 s after the event starts"],
          ]
    )
      .map(([t, label]) => ({
        t: clamp(t),
        label: `${s2(clamp(t))} s ${label}`,
      }))
      .sort((a, b) => a.t - b.t);
    const sounds = timeline.sounds
      .filter(
        (s) =>
          s.event === e.index ||
          (at !== null && s.event === null && Math.abs(s.start - at) < 0.005),
      )
      .map((s) =>
        at === null
          ? `${s.name} (${s.role}) starts ${s2(s.start)} s`
          : `${s.name} (${s.role}) starts ${s2(s.start)} s, ${signed(s.start - at)} from the landing`,
      );
    return {
      index: e.index,
      ply: e.ply,
      frames,
      lines: [
        `event ${e.index}: ply ${e.ply} ${e.kind}, ${s2(e.start)}-${s2(e.end)} s; ${at === null ? "no move in the video for this ply" : `the move lands ${s2(at)} s`}`,
        sounds.length ? `sounds: ${sounds.join("; ")}` : "sounds: none",
      ],
    };
  });
};

/** The width of one frame in a strip. */
const FRAME_WIDTH = 270;
/** The Chrome that storyboard.ts lays its page out with, on this box. */
const CHROME = "/usr/bin/google-chrome";

const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Writes the strips of `plan` as one PNG at `out`: a row per event, its text
 * above its four frames. ffmpeg only cuts the frames; Chrome lays out the
 * page (the static ffmpeg on this box has no text filter). Throws with
 * ffmpeg's last line on a failure.
 */
export const writeStrips = async ({ mp4, plan, out, ffmpeg = "ffmpeg" }) => {
  const work = mkdtempSync(join(tmpdir(), "strips-"));
  const frame = (t, name) => {
    const png = join(work, name);
    const r = spawnSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-ss",
        String(t),
        "-i",
        mp4,
        "-frames:v",
        "1",
        "-vf",
        `scale=${FRAME_WIDTH}:-2`,
        png,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0 || !existsSync(png)) {
      throw new Error(
        `ffmpeg at ${t} s: ${(r.stderr || `exit ${r.status}`).trim().split("\n").at(-1)}`,
      );
    }
    return `data:image/png;base64,${readFileSync(png).toString("base64")}`;
  };
  try {
    const rows = plan.map(
      (row, r) => `<section>
  ${row.lines.map((l, i) => `<p class="l${i}">${esc(l)}</p>`).join("")}
  <div class="frames">${row.frames
    .map(
      (f, i) =>
        `<figure><img src="${frame(f.t, `r${r}f${i}.png`)}"><figcaption>${esc(f.label)}</figcaption></figure>`,
    )
    .join("")}</div>
</section>`,
    );
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #111; color: #eee; font: 15px sans-serif; width: max-content; }
  section { padding: 8px; border-bottom: 2px solid #333; }
  p { margin: 2px 0; } .l0 { font-weight: bold; font-size: 17px; } .l1 { color: #fde68a; }
  .frames { display: flex; gap: 4px; margin-top: 6px; }
  figure { margin: 0; width: ${FRAME_WIDTH}px; }
  img { display: block; width: ${FRAME_WIDTH}px; }
  figcaption { font-size: 13px; padding: 2px 0; }
</style></head><body>${rows.join("")}</body></html>`;
    // Loaded here, so the app can import timelineOf without Playwright.
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const page = await browser.newPage({
        viewport: { width: 400, height: 300 },
      });
      await page.setContent(html, { waitUntil: "load" });
      const body = await page.locator("body").boundingBox();
      await page.setViewportSize({
        width: Math.ceil(body?.width ?? 400),
        height: 300,
      });
      await page.screenshot({ path: out, fullPage: true });
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
};
