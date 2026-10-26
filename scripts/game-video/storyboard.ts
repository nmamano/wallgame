/**
 * The storyboard of a daily candidate: one image with every position of the
 * game, so the Director SEES the game before it writes the edit list (Nil,
 * 2026-10-26, through Wall Game PM).
 *
 *   bun scripts/game-video/storyboard.ts --candidate <file.json> --out <file.png>
 *       [--edl <edl.json>]
 *
 * The candidate is one ranked entry of pick-daily-candidates.ts (gameId,
 * variant, boardWidth, boardHeight, initialState, moves, seats, picks,
 * beats). Each tile is one position, labelled with its ply, move number and
 * notation; the close-call plies (danger, save) and the jump plies
 * are marked, and the seats are red and blue as in the daily look
 * (dailySeatColors in edl.mjs).
 *
 * NO PRODUCTION VIEW. The positions come from the game record through
 * today's GameState (replayDistances, the picker's own replay), and the tiles
 * are drawn here with the site's own pawn art and colour filters, then shot
 * by the local Chrome. Nothing loads wallgame.io.
 *
 * With --edl, the storyboard is also the EDL's check before any render: it
 * validates the EDL against the game (edl.mjs, as `direct` and the renderer
 * do) and marks each event on its ply's tile, with its kind, its cell or
 * walls. One tile
 * per event's ply, so the Director sees every event's still before a render
 * costs the game a view.
 *
 * stdout carries one line, `RESULT {"png", "sha256", "plies", "width",
 * "height"}`; errors go to stderr with a non-zero exit.
 */
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { colorFilterMap } from "../../frontend/src/lib/player-colors";
import type {
  GameInitialState,
  PlayerId,
} from "../../shared/domain/game-types";
import { DEFAULT_PAWN_STYLES } from "../../shared/domain/pawn-styles";
import { boardPawns } from "../../shared/domain/pawns";
import type { SeatKind } from "./daily-candidates";
import { replayDistances } from "./race-replay";
import { checkEdlAgainstGame, dailySeatColors, validateEdl } from "./edl.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PAWN_DIR = join(REPO, "frontend/public/pawns");
const CHROME = "/usr/bin/google-chrome";

/** One tile's board, in CSS pixels; the sheet is TILE_COLUMNS tiles wide. */
const TILE_BOARD = 300;
const TILE_COLUMNS = 6;
/** The site's crisp theme, near enough for a director's sheet. */
const CELL_FILL = ["#1e2a47", "#25335a"];
const NEUTRAL_WALL = "#9a4a12";
const WALL_HEX = { red: "#dc2626", blue: "#2563eb" } as const;

interface Candidate {
  gameId: string;
  variant: string;
  boardWidth: number;
  boardHeight: number;
  initialState: GameInitialState;
  moves: string[];
  seats: { playerOrder: number; kind: SeatKind; name: string }[];
  picks: { ply: number; size: number }[];
  beats: {
    danger: { ply: number };
    save: { ply: number };
    size: number;
  }[];
}

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const candidatePath = arg("candidate");
const outPath = arg("out");
const edlPath = arg("edl");
if (!candidatePath || !outPath) {
  console.error(
    "usage: storyboard.ts --candidate <ranked entry json> --out <png> [--edl <edl json>]",
  );
  process.exit(2);
}
const game = JSON.parse(readFileSync(candidatePath, "utf8")) as Candidate;
if (!game.initialState) {
  console.error(
    `candidate ${game.gameId} has no initialState; the storyboard replays from it`,
  );
  process.exit(2);
}

const isBot = (id: PlayerId) =>
  game.seats.find((s) => s.playerOrder === id)?.kind === "official bot";
/** The daily look's colours, by the same rule as the video. */
const colorOf = (() => {
  let colors: Record<PlayerId, "red" | "blue">;
  try {
    colors = dailySeatColors({ 1: isBot(1), 2: isBot(2) });
  } catch (err) {
    console.error(`candidate ${game.gameId}: ${(err as Error).message}`);
    process.exit(2);
  }
  return (id: PlayerId) => colors[id];
})();
const word = (id: PlayerId) => (isBot(id) ? "AI" : "Human");
const redSeat: PlayerId = colorOf(1) === "red" ? 1 : 2;

const replay = replayDistances(game);

/** Every mark on a ply, as short labels: the story beats and the jumps. */
const marks = new Map<number, string[]>();
const mark = (ply: number, label: string) =>
  marks.set(ply, [...(marks.get(ply) ?? []), label]);
game.beats.forEach((b, i) => {
  const tag = game.beats.length > 1 ? ` ${i + 1}` : "";
  mark(b.danger.ply, `DANGER${tag}`);
  // The mouse laughs on the save ply, after the zoom (Nil, ask ac64cf6d),
  // so the ply after it is no beat of its own.
  mark(b.save.ply, `SAVE${tag} +${b.size}`);
});
for (const p of game.picks) mark(p.ply, `JUMP +${p.size}`);

/** One EDL event as the storyboard draws it, by kind. */
interface EdlEvent {
  ply: number;
  kind: string;
  cell?: string;
  walls?: string[];
  frame?: string[];
  emoji?: string;
  text?: string;
  sound?: string;
}
/** What the EDL draws on a ply's board: cells ringed, walls lit. */
const edlCells = new Map<number, { cell: string; color: string }[]>();
const edlWalls = new Map<number, string[]>();
const KIND_HEX: Record<string, string> = {
  scared: "#f59e0b",
  laugh: "#22c55e",
  blunder: "#ef4444",
  brilliant: "#2dd4bf",
  react: "#e879f9",
};
if (edlPath) {
  const checked = validateEdl(JSON.parse(readFileSync(edlPath, "utf8")));
  const errors = checked.edl
    ? checked.edl.gameId === game.gameId
      ? checkEdlAgainstGame(checked.edl, {
          notations: game.moves,
          cols: game.boardWidth,
          rows: game.boardHeight,
        })
      : [`the EDL is for game ${checked.edl.gameId}, not ${game.gameId}`]
    : (checked.errors ?? []);
  if (errors.length > 0 || !checked.edl) {
    console.error(`--edl ${edlPath} is not valid:\n  ${errors.join("\n  ")}`);
    process.exit(2);
  }
  const { startPly, coldOpenPly } = checked.edl as {
    startPly: number;
    coldOpenPly: number | null;
  };
  if (coldOpenPly !== null) mark(coldOpenPly, "COLD OPEN");
  // The plies a startPly cuts: the video never plays them.
  for (let ply = 0; ply < startPly - 1; ply += 1) mark(ply, "CUT");
  if (startPly > 0) mark(startPly - 1, "OPENS HERE");
  for (const ev of checked.edl.events as EdlEvent[]) {
    const sound = ev.sound ? ` + ${ev.sound}` : "";
    const what =
      ev.kind === "react"
        ? `${ev.emoji} ${ev.cell}`
        : ev.kind === "trap"
          ? `${ev.walls!.join(" ")} ${ev.text}`
          : ev.kind === "zoom"
            ? ev.frame!.join(" ")
            : ev.kind === "stamp"
              ? ev.text!
              : (ev.cell ?? "");
    mark(ev.ply, `${ev.kind.toUpperCase()} ${what}${sound}`.trim());
    if (ev.cell && KIND_HEX[ev.kind]) {
      edlCells.set(ev.ply, [
        ...(edlCells.get(ev.ply) ?? []),
        { cell: ev.cell, color: KIND_HEX[ev.kind] },
      ]);
    }
    const walls = ev.kind === "trap" ? ev.walls! : [];
    if (walls.length > 0) {
      edlWalls.set(ev.ply, [...(edlWalls.get(ev.ply) ?? []), ...walls]);
    }
  }
}

/**
 * The site's pawn art, inlined so the page needs no server. A style is used
 * only when it is a plain .svg file name of that type's folder; anything else
 * (a path, a URL, a missing file) draws the default.
 */
const artCache = new Map<string, string>();
const art = (type: string, style?: string) => {
  const file =
    style &&
    basename(style) === style &&
    style.endsWith(".svg") &&
    existsSync(join(PAWN_DIR, type, style))
      ? style
      : DEFAULT_PAWN_STYLES[type as keyof typeof DEFAULT_PAWN_STYLES];
  const key = `${type}/${file}`;
  if (!artCache.has(key)) {
    const svg = readFileSync(join(PAWN_DIR, type, file));
    artCache.set(key, `data:image/svg+xml;base64,${svg.toString("base64")}`);
  }
  return artCache.get(key)!;
};

const W = game.boardWidth;
const H = game.boardHeight;
/** Square cells: the board is TILE_BOARD wide and as tall as its rows need. */
const cell = TILE_BOARD / W;
const boardHeight = H * cell;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** One position as an SVG board: cells, walls, pawns, and what just moved. */
const boardSvg = (index: number) => {
  const state = replay.states[index];
  const prev = index > 0 ? replay.states[index - 1] : null;
  const parts: string[] = [];
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      parts.push(
        `<rect x="${c * cell + 1}" y="${r * cell + 1}" width="${cell - 2}" height="${cell - 2}" rx="3" fill="${CELL_FILL[(r + c) % 2]}"/>`,
      );
    }
  }
  const before = new Set(
    (prev?.grid.getWalls() ?? []).map(
      (w) => `${w.cell[0]},${w.cell[1]},${w.orientation}`,
    ),
  );
  for (const w of state.grid.getWalls()) {
    const [r, c] = w.cell;
    const fresh = prev && !before.has(`${r},${c},${w.orientation}`);
    const color = w.playerId ? WALL_HEX[colorOf(w.playerId)] : NEUTRAL_WALL;
    // ">" is the right edge of its cell, "^" the top edge.
    const [x1, y1, x2, y2] =
      w.orientation === "vertical"
        ? [(c + 1) * cell, r * cell, (c + 1) * cell, (r + 1) * cell]
        : [c * cell, r * cell, (c + 1) * cell, r * cell];
    if (fresh) {
      parts.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fde047" stroke-width="${cell * 0.24}" stroke-linecap="round" opacity="0.8"/>`,
      );
    }
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${cell * 0.12}" stroke-linecap="round"/>`,
    );
  }
  const prevCells = new Map(
    (prev ? boardPawns(prev.pawns) : []).map((p) => [
      `${p.playerId}:${p.type}`,
      p.cell,
    ]),
  );
  for (const p of boardPawns(state.pawns)) {
    const [r, c] = p.cell;
    const from = prevCells.get(`${p.playerId}:${p.type}`);
    if (from && (from[0] !== r || from[1] !== c)) {
      parts.push(
        `<line x1="${(from[1] + 0.5) * cell}" y1="${(from[0] + 0.5) * cell}" x2="${(c + 0.5) * cell}" y2="${(r + 0.5) * cell}" stroke="#fde047" stroke-width="${cell * 0.08}" stroke-dasharray="${cell * 0.12}" opacity="0.85"/>`,
      );
    }
    const pad = cell * 0.08;
    parts.push(
      `<image href="${art(p.type, p.pawnStyle)}" x="${c * cell + pad}" y="${r * cell + pad}" width="${cell - 2 * pad}" height="${cell - 2 * pad}" style="filter:${colorFilterMap[colorOf(p.playerId)]}"/>`,
    );
  }
  // The EDL's marks on this ply: a ringed cell per cell event, lit walls.
  for (const m of edlCells.get(index - 1) ?? []) {
    const c = m.cell.charCodeAt(0) - 97;
    const r = H - Number(m.cell.slice(1));
    parts.push(
      `<rect x="${c * cell + 2}" y="${r * cell + 2}" width="${cell - 4}" height="${cell - 4}" rx="5" fill="none" stroke="${m.color}" stroke-width="4"/>`,
    );
  }
  for (const term of edlWalls.get(index - 1) ?? []) {
    const c = term.charCodeAt(1) - 97;
    const r = H - Number(term.slice(2));
    const [x1, y1, x2, y2] = term.startsWith(">")
      ? [(c + 1) * cell, r * cell, (c + 1) * cell, (r + 1) * cell]
      : [c * cell, r * cell, (c + 1) * cell, r * cell];
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fef08a" stroke-width="${cell * 0.2}" stroke-linecap="round" opacity="0.7"/>`,
    );
  }
  for (let c = 0; c < W; c += 1) {
    parts.push(
      `<text x="${(c + 0.5) * cell}" y="${boardHeight - 3}" font-size="10" fill="#94a3b8" text-anchor="middle">${String.fromCharCode(97 + c)}</text>`,
    );
  }
  for (let r = 0; r < H; r += 1) {
    parts.push(
      `<text x="3" y="${r * cell + 11}" font-size="10" fill="#94a3b8">${H - r}</text>`,
    );
  }
  return `<svg width="${TILE_BOARD}" height="${boardHeight}" viewBox="0 0 ${TILE_BOARD} ${boardHeight}">${parts.join("")}</svg>`;
};

const tiles = replay.states.map((_, index) => {
  const ply = index - 1;
  const tags = ply >= 0 ? (marks.get(ply) ?? []) : [];
  const mover = ply >= 0 ? replay.movers[ply] : null;
  const head =
    ply < 0
      ? "start"
      : `ply ${ply} · move ${ply + 1} · <b style="color:${WALL_HEX[colorOf(mover!)]}">${word(mover!)}</b> ${esc(game.moves[ply])}`;
  const badges = tags
    .map(
      (t) =>
        `<span class="badge ${t.split(" ")[0].toLowerCase()}">${esc(t)}</span>`,
    )
    .join("");
  // The race counter as the video shows it under this position.
  const d = replay.distances[index];
  const steps =
    d[1] === null || d[2] === null
      ? ""
      : `<span class="steps">steps red ${d[redSeat]} · blue ${d[redSeat === 1 ? 2 : 1]}</span>`;
  return `<div class="tile${tags.length ? " marked" : ""}"><div class="head">${head}</div>${boardSvg(index)}<div class="badges">${steps}${badges}</div></div>`;
});

const seatTitle = (id: PlayerId) =>
  `<span style="color:${WALL_HEX[colorOf(id)]}">${word(id)} ${colorOf(id)}</span>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #0b0f1c; color: #e2e8f0; font: 600 13px "DejaVu Sans", sans-serif; }
  h1 { font-size: 18px; margin: 14px 16px 4px; }
  .legend { margin: 0 16px 10px; color: #94a3b8; font-weight: 500; }
  .grid { display: grid; grid-template-columns: repeat(${TILE_COLUMNS}, max-content); gap: 14px; padding: 8px 16px 16px; width: max-content; }
  .tile { background: #111a2e; border: 2px solid #1e293b; border-radius: 8px; padding: 6px; }
  .tile.marked { border-color: #fde047; }
  .head { margin: 0 0 5px; white-space: nowrap; overflow: hidden; width: ${TILE_BOARD}px; }
  .badges { min-height: 22px; margin-top: 5px; display: flex; gap: 4px; flex-wrap: wrap; width: ${TILE_BOARD}px; }
  .badge { padding: 2px 6px; border-radius: 4px; font-size: 12px; background: #334155; }
  .badge.danger { background: #b91c1c; } .badge.save { background: #15803d; }
  .badge.jump { background: #6d28d9; }
  .badge.zoom, .badge.stamp, .badge.sound, .badge.freeze { background: #0369a1; }
  .badge.scared { background: #b45309; } .badge.laugh { background: #15803d; }
  .badge.blunder { background: #dc2626; } .badge.brilliant { background: #0d9488; }
  .badge.trap { background: #a16207; } .badge.race { background: #475569; }
  .badge.react { background: #a21caf; }
  .steps { padding: 2px 4px; font-size: 12px; color: #94a3b8; }
  .badge.cold { background: #be185d; } .badge.cut { background: #1f2937; color: #64748b; }
  .badge.opens { background: #0369a1; }
</style></head><body>
<h1>${esc(game.gameId)} · ${esc(game.variant)} · ${game.moves.length} plies · ${seatTitle(1)} vs ${seatTitle(2)}</h1>
<div class="legend">Each tile is the position after its ply (0-based, as in the edit list). Yellow: the walls and the pawn move of that ply. Steps: the race counter the video shows. Marked: close-call DANGER / SAVE and JUMP plies${edlPath ? ", and each EDL event (a freeze plays before its ply lands)" : ""}.</div>
<div class="grid">${tiles.join("")}</div></body></html>`;

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({
    viewport: { width: 400, height: 300 },
    deviceScaleFactor: 1,
  });
  // "load" waits for every image; the pawn art is inlined, so it is quick.
  await page.setContent(html, { waitUntil: "load" });
  // The page is as wide as its grid, so the title lays out on one line.
  const grid = await page.locator(".grid").boundingBox();
  if (!grid) throw new Error("the storyboard grid did not lay out");
  await page.setViewportSize({ width: Math.ceil(grid.width), height: 300 });
  const out = resolve(outPath);
  await page.screenshot({ path: out, fullPage: true });
  const whole = await page.locator("html").boundingBox();
  const size = {
    width: Math.ceil(whole?.width ?? 0),
    height: Math.ceil(whole?.height ?? 0),
  };
  const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
  process.stdout.write(
    `RESULT ${JSON.stringify({ png: out, sha256, plies: game.moves.length, ...size })}\n`,
  );
} finally {
  await browser.close();
}
