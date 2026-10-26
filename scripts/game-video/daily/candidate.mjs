/**
 * From one entry of the step-1 candidate report to the day's candidate, and
 * the checks on the text that the video and its posts show.
 *
 * The report is the JSON that scripts/game-video/pick-daily-candidates.ts
 * writes (kind "daily-video-candidates"). This file reads that JSON only, so
 * the pipeline does not depend on how the report is made.
 *
 * THE DIRECTOR WRITES THE ON-VIDEO CAPTION in its edit list, from the
 * candidate's facts (crew.mjs facts). Wall Game Growth writes the post text
 * (copy.mjs). Nil approves each post for the first two weeks.
 *
 * NO GAME ID IN ANYTHING POSTED (Nil, 2026-10-26: "that's noise").
 * textProblems refuses a text that holds it.
 *
 * PLAYER NAMES ARE UNTRUSTED TEXT that would go out under the Wall Game
 * account. Step 1 admits only guests (random animal names), Nil and official
 * bots, but a candidate is still refused when a name holds anything beyond
 * letters, digits, spaces and . ' - _ , so a change upstream cannot put a link
 * or a mention in a post.
 */
import { ENDINGS, fastForwardTag } from "../edl.mjs";

/**
 * The on-video caption style that DIRECTOR.md's "On-video caption" section
 * teaches. Each cycle keeps the version at pick time, and every post-log row
 * carries it, so Wall Game Growth can compare the posts before and after a
 * change (Wall Game PM, 2026-10-26). Bump it whenever those rules change, and
 * name the new value in DIRECTOR.md. The post text has its own version, from
 * Growth (copy.mjs).
 */
export const CAPTION_STYLE_VERSION = "wallz-lingo-1";

/**
 * The renderer's daily look (Wall Game Worker 2, 2026-10-26): the WallzGame
 * body, punch-ins on the picked moves, meme sounds, the VS card over the first
 * seconds of play, and the ending Nil picks. Nil rejected the plain look, so
 * the daily pipeline sends this one value and nothing else.
 */
export const STYLES = ["daily"];
export const DEFAULT_STYLE = "daily";

/**
 * The director's default ending: the one posted least recently (Nil,
 * 2026-10-26: "All 3 endings are funny. We can rotate between them, for
 * variety."). ENDINGS is edl.mjs's, in its order. `rows` are
 * post-log rows, live and dry-run together, so the rotation also runs before
 * the keys exist. Only a posted day has rows, so a rejected or skipped day
 * does not use up its ending. An ending never posted comes first, in
 * ENDINGS order.
 */
export const nextEnding = (rows) => {
  const lastPosted = new Map();
  for (const row of rows) {
    if (!ENDINGS.includes(row.ending)) continue;
    const before = lastPosted.get(row.ending);
    if (before === undefined || row.utc > before) {
      lastPosted.set(row.ending, row.utc);
    }
  }
  const never = ENDINGS.find((e) => !lastPosted.has(e));
  if (never) return never;
  return ENDINGS.reduce((a, b) =>
    lastPosted.get(b) < lastPosted.get(a) ? b : a,
  );
};

/**
 * The director's edit list in short lines, for the dashboard and the part of
 * the ask that is not posted. Plies are 0-based, as in the list.
 */
export const edlSummary = (edl) => [
  `ending ${edl.ending}, music ${edl.music ?? "random"}${edl.caption ? `, video caption "${edl.caption}"` : ", no video caption"}`,
  `VS sound ${edl.vsSound}, finish sound ${edl.finishSound}`,
  ...(edl.startPly ? [`starts at ply ${edl.startPly}`] : []),
  ...(edl.coldOpenPly != null
    ? [`cold open: the position after ply ${edl.coldOpenPly}`]
    : []),
  ...(edl.payoff
    ? [`from ply ${edl.payoff.ply}: video caption "${edl.payoff.text}"`]
    : []),
  ...(edl.pace ?? []).map(
    (p) =>
      `plies ${p.fromPly}-${p.toPly}: ${p.secondsPerMove} s per move${p.fastForward ? `, fast-forward ${fastForwardTag(p.secondsPerMove)}` : ""}`,
  ),
  ...(edl.events ?? []).map((e) => {
    const what =
      e.kind === "zoom"
        ? `${e.lead ? "lead zoom (before the move)" : "zoom"} on ${e.frame.join(" ")}`
        : e.kind === "stamp"
          ? `stamp "${e.text}"`
          : e.kind === "trap"
            ? `trap on ${e.walls.join(" ")}, "${e.text}"`
            : e.kind === "race"
              ? "race counter flash"
              : e.kind === "react"
                ? `react ${e.emoji} at ${e.cell}`
                : e.cell
                  ? `${e.kind} at ${e.cell}`
                  : e.kind;
    return `ply ${e.ply}: ${what}${e.sound ? ` + ${e.sound}` : ""}`;
  }),
];

/**
 * A zoom on a close call's save ply must frame every wall that caused the
 * save and both pawns (PM decision, 2026-10-26: with two walls, both go in
 * the frame). Returns error lines; edl.mjs cannot check this, it has no
 * close calls.
 */
export const saveFrameProblems = (edl, beats) =>
  edl.events.flatMap((e, i) => {
    if (e.kind !== "zoom") return [];
    return beats
      .filter((b) => b.save.ply === e.ply)
      .flatMap((b) => {
        const want = [
          ...(b.save.walls ?? []).filter((w) => w.cause).map((w) => w.notation),
          b.save.hunterCell,
          b.save.preyCell,
        ];
        const missing = want.filter((t) => !e.frame.includes(t));
        return missing.length
          ? [
              `events[${i}]: the zoom on save ply ${e.ply} must frame ${want.join(" ")}; missing ${missing.join(" ")}`,
            ]
          : [];
      });
  });

/**
 * The player whose walk ends at 0 in `distances` (the race counter, one
 * entry per position: distances[k] is after k plies), or null when the game
 * ended another way (a resign, a timeout).
 */
export const raceWinner = (distances) => {
  const last = distances?.at(-1);
  if (last?.[1] === 0) return 1;
  if (last?.[2] === 0) return 2;
  return null;
};

/**
 * A save is a false one when the hunter still wins this soon after it
 * (rehearsal, 2026-10-26: in all three close calls of the day's top five,
 * the hunter won 5 to 9 plies after the save).
 */
export const DOOMED_SAVE_PLIES = 10;

/**
 * What a stranger reads against what the video shows (Director rehearsal,
 * 2026-10-26). Returns error lines:
 * - A number in the caption must be on the race counter when the caption is
 *   first read: at the start (startPly, before or after its move) or on the
 *   cold open. "Red was 2 steps from winning" over a counter that says 10 is
 *   a contradiction for most of the video.
 * - A number in the payoff must be on the counter just before or just after
 *   the payoff's move, so "2 to 8" and "now it's 8" both pass.
 * - No laugh on a save when the hunter still wins within DOOMED_SAVE_PLIES:
 *   the viewer sees "safe", then the loss. The laugh goes on the save ply,
 *   after the zoom (Nil, 2026-10-26: a laugh on the hunter's reply was "off
 *   by one").
 * The counter in `distances` is the picker's replay, the one the renderer
 * draws (race-replay.ts).
 */
export const storyProblems = (edl, { distances, beats, movesCount }) => {
  const problems = [];
  const counter = (positions) =>
    [
      ...new Set(
        positions.flatMap((k) =>
          [distances[k]?.[1], distances[k]?.[2]].filter(Number.isInteger),
        ),
      ),
    ].sort((a, b) => a - b);
  const numbers = (text) => (text.match(/\d+/g) ?? []).map(Number);
  const mismatch = (what, text, positions, when) => {
    const shown = counter(positions);
    for (const n of numbers(text)) {
      if (!shown.includes(n)) {
        problems.push(
          `the ${what} says ${n}, but the race counter shows ${shown.join(" or ")} ${when}; use a number that the counter shows then, or say it in words`,
        );
      }
    }
  };
  if (edl.caption) {
    mismatch(
      "caption",
      edl.caption,
      [
        edl.startPly,
        edl.startPly + 1,
        ...(edl.coldOpenPly === null ? [] : [edl.coldOpenPly + 1]),
      ],
      "when the caption is first read",
    );
  }
  if (edl.payoff) {
    mismatch(
      "payoff",
      edl.payoff.text,
      [edl.payoff.ply, edl.payoff.ply + 1],
      `around ply ${edl.payoff.ply}`,
    );
  }
  const winner = raceWinner(distances);
  const lastPly = movesCount - 1;
  for (const b of beats) {
    const gap = lastPly - b.save.ply;
    if (winner !== b.hunter.player || gap > DOOMED_SAVE_PLIES) continue;
    edl.events.forEach((e, i) => {
      if (e.kind === "laugh" && e.ply === b.save.ply) {
        problems.push(
          `events[${i}]: a laugh on save ply ${b.save.ply}, but the hunter wins ${gap} plies later; the save only delays the loss, so say that in the payoff instead`,
        );
      }
    });
  }
  return problems;
};

/** Throws unless `distances` is one race count per position of the game. */
const checkDistances = (gameId, distances, movesCount) => {
  const count = (n) => n === null || (Number.isInteger(n) && n >= 0);
  if (
    !Array.isArray(distances) ||
    distances.length !== movesCount + 1 ||
    distances.some((d) => !count(d?.[1]) || !count(d?.[2]))
  ) {
    throw new Error(
      `${gameId} has race counts that are not one per position of the game`,
    );
  }
};

const SAFE_NAME = /^[\p{L}\p{N} .'_-]{1,40}$/u;
const GAME_ID = /^[A-Za-z0-9_-]{4,40}$/;
/** A board cell in standard notation; the renderer puts an overlay on it. */
const CELL = /^[a-z][1-9][0-9]?$/;
const PAWN_TYPES = ["cat", "mouse", "dog", "elephant"];

/** Throws unless `beat` is a CloseCall the renderer can act on. */
const checkBeat = (gameId, beat) => {
  const moments = [beat?.danger, beat?.save, beat?.relief];
  const ok =
    typeof beat?.description === "string" &&
    [beat.hunter, beat.prey].every(
      (p) =>
        (p?.player === 1 || p?.player === 2) && PAWN_TYPES.includes(p.type),
    ) &&
    moments.every(
      (m) =>
        Number.isInteger(m?.ply) &&
        m.ply >= 0 &&
        Number.isInteger(m.moveNumber) &&
        CELL.test(m.hunterCell ?? "") &&
        CELL.test(m.preyCell ?? ""),
    );
  if (!ok) throw new Error(`${gameId} has a close call the video cannot use`);
};

/** Throws unless `escape` is an Escape the renderer can act on. */
const checkEscape = (gameId, escape) => {
  const ok =
    typeof escape?.description === "string" &&
    [escape.hunter, escape.prey].every(
      (p) =>
        (p?.player === 1 || p?.player === 2) && PAWN_TYPES.includes(p.type),
    ) &&
    Number.isInteger(escape.ply) &&
    escape.ply >= 0 &&
    Number.isInteger(escape.moveNumber) &&
    Number.isInteger(escape.walkBefore) &&
    Number.isInteger(escape.walk) &&
    [escape.hunterCell, escape.preyFrom, escape.preyCell].every((c) =>
      CELL.test(c ?? ""),
    );
  if (!ok) throw new Error(`${gameId} has an escape the video cannot use`);
};

/**
 * The report entry at `rank` (1-based), as the cycle's candidate.
 * Throws with a reason when the report or the entry cannot be used.
 */
export const candidateFromReport = (report, rank = 1) => {
  if (report?.kind !== "daily-video-candidates") {
    throw new Error("that file is not a daily-video-candidates report");
  }
  const entry = report.ranked?.[rank - 1];
  if (!entry) {
    throw new Error(
      `the report has ${report.ranked?.length ?? 0} ranked games; there is no rank ${rank}`,
    );
  }
  if (!GAME_ID.test(entry.gameId ?? "")) {
    throw new Error(`the report's game id is not one: ${entry.gameId}`);
  }
  for (const seat of entry.seats) {
    if (!SAFE_NAME.test(seat.name ?? "")) {
      throw new Error(
        `a player name holds characters a post must not carry: ${JSON.stringify(seat.name)}`,
      );
    }
  }
  if (entry.picks?.some((p) => typeof p.description !== "string")) {
    throw new Error(`${entry.gameId} has a pick without a description`);
  }
  for (const beat of entry.beats ?? []) checkBeat(entry.gameId, beat);
  for (const escape of entry.escapes ?? []) checkEscape(entry.gameId, escape);
  if (
    entry.moves !== undefined &&
    (!Array.isArray(entry.moves) ||
      entry.moves.length !== entry.movesCount ||
      entry.moves.some((m) => typeof m !== "string"))
  ) {
    throw new Error(`${entry.gameId} has a move list that is not one per ply`);
  }
  if (entry.distances !== undefined) {
    checkDistances(entry.gameId, entry.distances, entry.movesCount);
  }
  if (!entry.picks?.length) {
    throw new Error(
      `${entry.gameId} has no move that beat an ordinary advance`,
    );
  }
  const base = {
    gameId: entry.gameId,
    variant: entry.variant,
    boardWidth: entry.boardWidth,
    boardHeight: entry.boardHeight,
    movesCount: entry.movesCount,
    startedAt: entry.startedAt,
    seats: entry.seats.map((s) => ({
      playerOrder: s.playerOrder,
      name: s.name,
      kind: s.kind,
    })),
    // DistanceJump (scripts/game-video/daily-candidates.ts), largest first.
    picks: entry.picks.map((p) => ({
      ply: p.ply,
      moveNumber: p.moveNumber,
      mover: p.mover,
      notation: p.notation,
      ownBefore: p.ownBefore,
      ownAfter: p.ownAfter,
      opponentBefore: p.opponentBefore,
      opponentAfter: p.opponentAfter,
      jump: p.jump,
      size: p.size,
      // The pawns before and after, and the walls of the move with the one
      // that caused the jump: what the director frames a zoom on.
      pawns: p.pawns,
      walls: p.walls,
      wallsChange: p.wallsChange,
      together: p.together,
      // Worker 1's sentence for the move: the crew lead's caption material.
      description: p.description,
    })),
    // DescribedCloseCall (daily-candidates.ts), largest save first: the
    // danger, the wall that saves the prey, and the hunter's reply.
    beats: (entry.beats ?? []).map((b) => ({
      hunter: b.hunter,
      prey: b.prey,
      danger: b.danger,
      save: b.save,
      relief: b.relief,
      size: b.size,
      description: b.description,
    })),
    // DescribedEscape (daily-candidates.ts), largest first: a prey that
    // steps away from a close hunter, with or without a wall. A report from
    // before 2026-10-26 has none.
    escapes: (entry.escapes ?? []).map((e) => ({
      ply: e.ply,
      moveNumber: e.moveNumber,
      notation: e.notation,
      hunter: e.hunter,
      prey: e.prey,
      walkBefore: e.walkBefore,
      walk: e.walk,
      hunterCell: e.hunterCell,
      preyFrom: e.preyFrom,
      preyCell: e.preyCell,
      size: e.size,
      description: e.description,
    })),
    // Every ply's notation: edl.mjs checks the director's list against it.
    moves: entry.moves ?? null,
    // Where the game started: the storyboard replays the moves from it.
    initialState: entry.initialState ?? null,
    // The race counter at each position (distances[k] is after k plies):
    // what the video shows over the board, so storyProblems can hold the
    // captions to it.
    distances: entry.distances ?? null,
    source: { reportCreatedAt: report.createdAt, rank },
  };
  const winner = raceWinner(base.distances);
  const name = (player) =>
    base.seats.find((s) => s.playerOrder === player)?.name;
  // A close call's sentence says "the mouse is safe"; the game can still be
  // lost a few moves later, and the story must follow the end.
  const outcome = (b, moveNumber, what) =>
    winner === b.hunter.player
      ? ` ${name(winner)} still wins at move ${base.movesCount}, ${base.movesCount - moveNumber} moves after the ${what}.`
      : winner === b.prey.player
        ? ` ${name(winner)} wins at move ${base.movesCount}.`
        : "";
  return {
    ...base,
    facts: [
      ...base.beats.map(
        (b) =>
          `Move ${b.save.moveNumber}: ${b.description}${outcome(b, b.save.moveNumber, "save")}`,
      ),
      ...base.escapes.map(
        (e) =>
          `Move ${e.moveNumber}: ${e.description}${outcome(e, e.moveNumber, "escape")}`,
      ),
      ...base.picks.map((p) => `Move ${p.moveNumber}: ${p.description}`),
    ],
  };
};

/**
 * The names of the people who played: every seat but an official bot. A
 * post calls a player "bro", never by name (Nil, 2026-10-26, through Wall
 * Game PM); the bot is ours, and its name can be roasted.
 * @param {{ seats: { name: string, kind: string }[] }} candidate
 * @returns {string[]}
 */
export const playerNames = (candidate) =>
  candidate.seats.filter((s) => s.kind !== "official bot").map((s) => s.name);

/**
 * Reasons any published text cannot go out: Growth's copy block (copy.mjs),
 * and the caption, payoff and stamps burned into the video. `texts` maps a name to
 * its text; `players` are playerNames of the game.
 */
export const textProblems = (texts, gameId, players = []) => {
  const problems = [];
  const id = String(gameId ?? "").toLowerCase();
  for (const [field, text] of Object.entries(texts ?? {})) {
    const lower = String(text).toLowerCase();
    if (id && lower.includes(id)) {
      problems.push(`${field} must not hold the game id`);
    }
    for (const name of players) {
      // The whole name as words: "Nil" is not in "vanilla".
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        new RegExp(
          `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
          "iu",
        ).test(text)
      ) {
        problems.push(`${field} must not name the player ${name}: say bro`);
      }
    }
    // Wallz is another game; its tag would send our viewers there.
    if (/#wallz/i.test(String(text))) {
      problems.push(`${field} must not hold #wallz`);
    }
    // X forbids unsolicited automated mentions, and the account is labelled
    // Automated: one @name can cost the account.
    if (/(^|[^\w])@\w/.test(String(text))) {
      problems.push(`${field} must not mention anyone (@)`);
    }
    // YouTube does not take < or > in a title or a description. Refusing them
    // here keeps a day from ending with X posted and YouTube refused.
    if (/[<>]/.test(String(text))) {
      problems.push(`${field} must not hold < or >`);
    }
  }
  return problems;
};
