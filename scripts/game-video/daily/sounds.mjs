/**
 * Nil's listening page for the meme sounds, at /daily/sounds, and his keep or
 * drop choice for each one.
 *
 * Board task e8d26610. Agents cannot hear, so meme-sounds.mjs holds several
 * candidates per family and Nil picks by ear. The page plays each clip at the
 * gain a video gives it (memeGain), not as uploaded: the uploads differ by
 * 29 dB, and a choice made at the wrong level is a choice about the wrong
 * sound.
 *
 * The choices are one file in the app's data dir, daily/sound-picks.json. A
 * sound with no choice is "not heard yet". The director uses kept sounds, and
 * POST /api/daily/direct refuses a list that names a dropped one (routes.mjs).
 *
 * TWO SOUNDS ARE DEFAULTS. The VS card and the finish play
 * DEFAULT_SLOT_SOUNDS (edl.mjs) unless the director's list names its own
 * (vsSound, finishSound). The page labels those rows. A Drop is allowed:
 * the direct step then refuses a list that keeps a dropped default, so the
 * director names a kept sound for that slot (Wall Game PM, 2026-10-26).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEME_SOUNDS,
  MEME_FAMILIES,
  MEME_SOURCE_NOTES,
  memeFamily,
  memeGain,
  memeLevel,
} from "../meme-sounds.mjs";
import { DEFAULT_SLOT_SOUNDS } from "../edl.mjs";
import { writeAtomic, StepRefused } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEME_DIR = resolve(HERE, "../../../assets/meme-sounds");

/** What the page calls each slot of DEFAULT_SLOT_SOUNDS. */
const SLOT_NAMES = { vsSound: "the VS card", finishSound: "the finish" };

/**
 * key -> the slots it is the default of, in words ("the VS card and the
 * finish"), for the keys that are a default.
 * @returns {Record<string, string>}
 */
export const defaultSlots = () => {
  /** @type {Record<string, string[]>} */
  const slots = {};
  for (const [slot, key] of Object.entries(DEFAULT_SLOT_SOUNDS)) {
    slots[key] = [...(slots[key] ?? []), SLOT_NAMES[slot]];
  }
  return Object.fromEntries(
    Object.entries(slots).map(([key, names]) => [key, names.join(" and ")]),
  );
};

export const CHOICES = ["keep", "drop"];

const known = (key) => Object.hasOwn(MEME_SOUNDS, key);

/** The choices, kept in `<root>/sound-picks.json`. */
export const openSoundPicks = (root) => {
  const path = join(root, "sound-picks.json");

  /**
   * key -> {choice, at}. A key no longer in the table is left out.
   * @returns {Record<string, { choice: string, at: string }>}
   */
  const read = () => {
    if (!existsSync(path)) return {};
    const all = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries(Object.entries(all).filter(([k]) => known(k)));
  };

  /** Set a choice, or clear it with null (back to "not heard yet"). */
  const set = (key, choice) => {
    if (typeof key !== "string" || !known(key)) {
      throw new StepRefused(`sound ${JSON.stringify(key)} is not known`);
    }
    if (choice !== null && !CHOICES.includes(choice)) {
      throw new StepRefused(`a choice is ${CHOICES.join(", ")} or null`);
    }
    const picks = read();
    if (choice === null) delete picks[key];
    else picks[key] = { choice, at: new Date().toISOString() };
    writeAtomic(path, JSON.stringify(picks, null, 2) + "\n");
    return picks;
  };

  const dropped = () =>
    Object.entries(read())
      .filter(([, p]) => p.choice === "drop")
      .map(([k]) => k);

  return { path, read, set, dropped };
};

/**
 * Every sound, in table order, with its level in a video, its choice, its
 * source note and the slots it is the default of, if any.
 */
export const soundList = (picks, dir = MEME_DIR, defaults = defaultSlots()) =>
  Object.entries(MEME_SOUNDS).map(([key, { lufs, truePeak }]) => {
    const family = memeFamily(key);
    return {
      key,
      family,
      moment: MEME_FAMILIES[family] ?? null,
      lufs,
      truePeak,
      gain: memeGain(key),
      level: memeLevel(key),
      choice: picks[key]?.choice ?? null,
      note: MEME_SOURCE_NOTES[key] ?? null,
      defaultFor: defaults[key] ?? null,
      file: existsSync(join(dir, `${key}.mp3`)),
    };
  });

/** The clip's path, or null for a key that is not in the table. */
export const soundFile = (key, dir = MEME_DIR) =>
  typeof key === "string" && known(key) ? join(dir, `${key}.mp3`) : null;

export const SOUNDS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wall Game meme sounds</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f1c; color: #e2e8f0;
         margin: 0; padding: 28px 16px; display: flex; justify-content: center; }
  main { width: 100%; max-width: 760px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 22px 0 8px; color: #cbd5e1; }
  .sub { color: #94a3b8; font-size: 13px; margin: 0 0 16px; }
  .box { padding: 6px 14px; border-radius: 8px; background: #121a2e; border: 1px solid #334155;
         font-size: 14px; line-height: 1.5; }
  .row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #1e293b; }
  .row:last-child { border-bottom: 0; }
  .key { font-family: ui-monospace, monospace; min-width: 96px; }
  .lvl { color: #94a3b8; font-size: 12px; flex: 1; }
  button { padding: 5px 12px; font-size: 13px; font-weight: 700; border-radius: 6px; cursor: pointer;
           border: 1px solid #334155; background: #0b1222; color: #e2e8f0; }
  button.play { background: #ff8c42; color: #1a1005; border-color: #ff8c42; min-width: 64px; }
  button.keep.on { background: #166534; border-color: #22c55e; }
  button.drop.on { background: #7f1d1d; border-color: #ef4444; }
  .err { color: #fca5a5; font-size: 12px; }
  .note { display: block; font-size: 12px; color: #fbbf24; }
  .slot { display: block; font-size: 12px; color: #93c5fd; }
  button[disabled] { opacity: .4; cursor: default; }
  a { color: #ff8c42; } .muted { color: #64748b; font-size: 12px; }
</style></head>
<body><main>
  <h1>Meme sounds</h1>
  <p class="sub">Each sound plays at its level in a video. Keep the ones the director may use.
    <a href="/daily">Daily video</a></p>
  <div id="sum" class="muted"></div>
  <div id="list"></div>
  <p class="muted">The level is the loudest 400 ms after the video's gain, in LUFS.
    The music and moves sat near -22 in a render measured 2026-10-26. A video plays the scared sounds and the VS card 3 dB lower.</p>
<script>
  // Built with textContent only, as on the other pages of this app.
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag);
    if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };

  let ctx = null, playing = null;
  const buffers = new Map();
  const play = async (s, button) => {
    // A browser starts audio only after a click, so the context starts here.
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    if (playing) { playing.stop(); }
    let buf = buffers.get(s.key);
    if (!buf) {
      const r = await fetch("/api/daily/sounds/file?key=" + encodeURIComponent(s.key));
      if (!r.ok) { button.textContent = "missing"; return; }
      try { buf = await ctx.decodeAudioData(await r.arrayBuffer()); }
      catch { button.textContent = "error"; return; }
      buffers.set(s.key, buf);
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const gain = ctx.createGain(); gain.gain.value = s.gain;
    src.connect(gain).connect(ctx.destination);
    src.onended = () => { if (playing === src) playing = null; };
    playing = src; src.start();
  };

  const choose = async (key, choice) => {
    const r = await fetch("/api/daily/sounds", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ key, choice }) });
    if (!r.ok) { $("sum").replaceChildren(el("span", "err", (await r.json()).error || "could not save")); return; }
    load();
  };

  const render = (sounds) => {
    const count = (c) => sounds.filter((s) => s.choice === c).length;
    $("sum").textContent = count("keep") + " kept, " + count("drop") + " dropped, " +
      count(null) + " not heard yet, of " + sounds.length;
    const list = $("list"); list.replaceChildren();
    const families = [...new Set(sounds.map((s) => s.family))];
    for (const f of families) {
      const members = sounds.filter((s) => s.family === f);
      list.append(el("h2", null, f + (members[0].moment ? " - " + members[0].moment : "")));
      const box = el("div", "box");
      for (const s of members) {
        const row = el("div", "row");
        const p = el("button", "play", s.file ? "Play" : "missing");
        p.disabled = !s.file;
        p.onclick = () => play(s, p);
        const db = 20 * Math.log10(s.gain);
        const lvl = el("span", "lvl", s.level.toFixed(1) + " LUFS (gain " + (db >= 0 ? "+" : "") + db.toFixed(1) + " dB)");
        if (s.defaultFor) lvl.append(el("span", "slot", "Default on " + s.defaultFor + ", when the list names no other sound."));
        if (s.note) lvl.append(el("span", "note", s.note));
        const keep = el("button", "keep" + (s.choice === "keep" ? " on" : ""), "Keep");
        keep.onclick = () => choose(s.key, s.choice === "keep" ? null : "keep");
        const drop = el("button", "drop" + (s.choice === "drop" ? " on" : ""), "Drop");
        drop.onclick = () => choose(s.key, s.choice === "drop" ? null : "drop");
        row.append(p, el("span", "key", s.key), lvl, keep, drop);
        box.append(row);
      }
      list.append(box);
    }
  };

  const load = async () => render(await (await fetch("/api/daily/sounds")).json());
  load();
</script></main></body></html>`;
