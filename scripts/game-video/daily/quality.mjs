/**
 * Measured checks on a rendered daily video, beside the director's own look
 * at the contact sheet (quality audit, info/daily-video-quality.md). The
 * renderer measures each render and the app judges the measures when it
 * lands; the check step does not finish an item whose render fails one.
 *
 *   loudness   each meme sound's own loudness in the final mix, and how
 *              far it stands over the music and clicks under it, as the
 *              renderer measured them (mix-loudness.mjs; Nil, 2026-10-26:
 *              "the baby cry and the initial shotgun, are a bit too loud").
 *   safeArea   each box the renderer measured in the page lies in its area
 *              (edl.mjs areaOf; Nil, 2026-11-05, C58): the board in
 *              BOARD_AREA (the frame's width, under the apps' top bar and
 *              over their caption zone), every text in TEXT_AREA and off
 *              the buttons on the right (BUTTONS_ZONE), the strip in
 *              STRIP_AREA.
 *   captionLines
 *              each caption beat (the caption and the payoff) is one line as
 *              the page wraps it (stage.html __captionText): a two-line beat
 *              makes the board smaller for the whole video, because the
 *              board gets the height the caption leaves and the caption
 *              keeps its taller beat's height (stage.html __fitWallz;
 *              measured 2026-10-26: 720 px against 785 px).
 *   silence    the gaps over the silence rules in the final track, as the
 *              render measured it (mix-loudness.mjs). A report for the
 *              director and the vet, never a failed check (Wall Game PM,
 *              2026-10-29): a gap can be the script's beat.
 */
import {
  BOARD_AREA,
  BUTTONS_ZONE,
  STRIP_AREA,
  TEXT_AREA,
  areaOf,
  underButtons,
} from "../edl.mjs";

/**
 * The loudness rule (Wall Game Director, 2026-10-26, rule A1). A meme
 * sound fails when its own loudest 400 ms in the final mix is over
 * MAX_MEME_LUFS. That level is what Nil's ear followed: too loud near -16
 * LUFS (N42PHQnw, -15.6 to -15.9), fine near -21 (the meme target since,
 * meme-sounds.mjs; today's renders -20.4 to -24).
 *
 * How far a meme stands over the bed (overLU: the music and the clicks
 * under it over the same 400 ms) is INFORMATION ONLY, in the note for the
 * director's ear. It moves with where the meme lands in the song, not with
 * the meme: measured 2026-10-26, a 0.6 s shift of the same VoSWbMDd video
 * moved the FAHHH from 2.9 to 13.8 LU over the bed, and a laugh that lands
 * in a rest of Tea For Two (the song near -45 LUFS at 19.5 s) stands 17 to
 * 37 LU over it. As a gate it would fail good videos by chance.
 *
 * The memes are measured in the mix BEFORE the master (mix-loudness.mjs
 * masterFilters, 2026-10-29), so the limit keeps its value and passes the
 * same mixes. The master's gain is not one offset: it is what each mix needs
 * to reach the feed level (VX edl-3j +11.8 dB), so a moved limit would pass
 * a different set of mixes for each video. RESULT.loudness.master gives it.
 */
export const MAX_MEME_LUFS = -18.5;

/**
 * @typedef {{ key: string, at: number, loudestAt: number, memeLufs: number,
 *   bedLufs: number | null, overLU: number | null, truePeakDbtp: number }} MemeLoudness
 */

const memeLine = (m) =>
  `${m.key} at ${m.at} s: ${m.memeLufs} LUFS, ` +
  (m.overLU === null
    ? "over silence"
    : `${m.overLU} LU over the bed (${m.bedLufs} LUFS)`) +
  `, true peak ${m.truePeakDbtp} dBTP`;

/**
 * The loudness verdict on the render's report (RESULT `loudness`):
 * `{memes: MemeLoudness[]}`, or `{error}` when the renderer could not
 * measure, or null when the video has no soundtrack. Only a report with its
 * memes passes, so a renderer that stops measuring, or a silent video,
 * cannot pass.
 * @param {{ memes?: MemeLoudness[], error?: string } | null | undefined} report
 */
export const loudnessVerdict = (report) => {
  if (!report?.memes) {
    return {
      ok: false,
      note: report?.error
        ? `the renderer could not measure the meme sounds: ${report.error}`
        : "the render reported no meme loudness (a silent video, or a render kit older than the measure: tell the Wall Game Director)",
    };
  }
  if (report.memes.length === 0) return { ok: true, note: "no meme sound" };
  const bad = report.memes.filter((m) => m.memeLufs > MAX_MEME_LUFS);
  const all = report.memes.map(memeLine).join("; ");
  return bad.length === 0
    ? { ok: true, note: all }
    : {
        ok: false,
        note: `${bad.map(memeLine).join("; ")}: a meme sound may be at most ${MAX_MEME_LUFS} LUFS; drop or change it (all: ${all})`,
      };
};

/** How a note names each area a box can be held to. */
const AREA_NAMES = new Map([
  [BOARD_AREA, "the board area"],
  [TEXT_AREA, "the text area"],
  [STRIP_AREA, "the strip area"],
]);

const inside = (box, area) =>
  box.x >= area.x &&
  box.y >= area.y &&
  box.x + box.w <= area.x + area.w &&
  box.y + box.h <= area.y + area.h;

const span = (b) => `x ${b.x}-${b.x + b.w}, y ${b.y}-${b.y + b.h}`;

/**
 * The safe-area verdict on the layout a render reported:
 * `{frame: {w, h}, boxes: {name: {x, y, w, h}}}`, measured in the page at
 * rest. Every daily render reports one, with the board in it; a render
 * without one fails, so a renderer that stops measuring cannot pass. Each
 * box is held to its own area (areaOf).
 * @param {{ frame?: { w: number, h: number },
 *           boxes?: Record<string, { x: number, y: number, w: number, h: number }> } | undefined} layout
 * @param {{ w: number, h: number }} frame
 */
export const safeAreaVerdict = (layout, frame) => {
  const fail = (note) => ({ ok: false, note });
  if (!layout?.boxes?.board) return fail("the render reported no layout");
  if (layout.frame?.w !== frame.w || layout.frame?.h !== frame.h) {
    return fail(
      `the frame is ${layout.frame?.w}x${layout.frame?.h}, not ${frame.w}x${frame.h}`,
    );
  }
  const boxes = Object.entries(layout.boxes);
  const outside = boxes.filter(([name, box]) => !inside(box, areaOf(name)));
  const under = boxes.filter(([name, box]) => underButtons(name, box));
  if (outside.length || under.length) {
    return fail(
      [
        ...outside.map(([name, box]) => {
          const area = areaOf(name);
          return `${name} (${span(box)}) is outside ${AREA_NAMES.get(area)} (${span(area)})`;
        }),
        ...under.map(
          ([name, box]) =>
            `${name} (${span(box)}) is under the apps' buttons (${span(BUTTONS_ZONE)})`,
        ),
      ].join("; "),
    );
  }
  // One clause per area, in the order its first box was measured.
  const byArea = new Map();
  for (const [name] of boxes) {
    const area = areaOf(name);
    byArea.set(area, [...(byArea.get(area) ?? []), name]);
  }
  return {
    ok: true,
    note: [...byArea]
      .map(
        ([area, names]) => `${names.join(", ")} inside ${AREA_NAMES.get(area)}`,
      )
      .join("; "),
  };
};

/**
 * One line per caption beat, inside its box. `layout.captionText` is the
 * renderer's measure of each beat, { caption?, payoff? } of { lines, width }
 * with the widest line in px; `layout.boxes` has a box of the same name. One
 * long word cannot wrap: it stays one line and runs past the box (Worker 2,
 * 2026-10-26: 31 W's measured 1 line, 1743 px in a 918 px slot), so the
 * width counts too. A render that did not measure fails, as safeArea does.
 */
export const captionLinesVerdict = (layout) => {
  const beats = layout?.captionText;
  if (!beats) {
    return {
      ok: false,
      note: "the render reported no caption line count; the render kit may be older than the measure, so sync it (Wall Game Director)",
    };
  }
  const entries = Object.entries(beats);
  if (entries.length === 0) return { ok: true, note: "no caption" };
  const said = ([name, b]) =>
    `${name} ${b.lines} line${b.lines === 1 ? "" : "s"}, ${b.width} of ${layout.boxes?.[name]?.w ?? "?"} px`;
  const bad = entries.filter(([name, b]) => {
    const box = layout.boxes?.[name]?.w;
    return b.lines !== 1 || !box || b.width > box;
  });
  return bad.length === 0
    ? { ok: true, note: entries.map(said).join("; ") }
    : {
        ok: false,
        note: `${bad.map(said).join("; ")}: each beat must be one line inside its box; shorten it, direct again and render`,
      };
};

/**
 * The silence report (RESULT `silence`): `{floorDbfs, gaps, over}`, or
 * `{error}`. Always ok when measured; `warn` when a gap breaks a rule. A
 * render that did not measure fails, as the other measures do (a render
 * kit older than the measure).
 * @param {{ floorDbfs?: number, gaps?: { start: number, end: number,
 *   seconds: number }[], over?: { start: number, end: number,
 *   seconds: number, rule: number }[], error?: string } | null | undefined} report
 */
export const silenceVerdict = (report) => {
  if (!report?.over) {
    return {
      ok: false,
      note: report?.error
        ? `the renderer could not measure the silences: ${report.error}`
        : "the render reported no silence measure (a silent video, or a render kit older than the measure: sync it)",
    };
  }
  if (report.over.length === 0) {
    return {
      ok: true,
      note: `no gap over the rules (under ${report.floorDbfs} dBFS)`,
    };
  }
  return {
    ok: true,
    warn: true,
    note: `${report.over.map((g) => `${g.start}-${g.end} s: ${g.seconds} s, over ${g.rule} s`).join("; ")} (under ${report.floorDbfs} dBFS); the vet judges each`,
  };
};
