/**
 * From one entry of the step-1 candidate report to the day's candidate and
 * its captions.
 *
 * The report is the JSON that scripts/game-video/pick-daily-candidates.ts
 * writes (kind "daily-video-candidates"). This file reads that JSON only, so
 * the pipeline does not depend on how the report is made.
 *
 * THE CREW LEAD WRITES THE CAPTION (Nil, 2026-10-26: "something silly and
 * probably llm generated. like 'lmao he thought he'd sneak through'"). The crew
 * lead is an agent: it reads the candidate's facts (crew.mjs facts), writes two
 * or three captions, and passes the one it picks to crew.mjs pick. There is no
 * template and no separate model call here. Nil approves each post for the
 * first two weeks.
 *
 * NO GAME ID IN ANYTHING POSTED (Nil, 2026-10-26: "that's noise").
 * captionProblems refuses a caption that holds it.
 *
 * PLAYER NAMES ARE UNTRUSTED TEXT that would go out under the Wall Game
 * account. Step 1 admits only guests (random animal names), Nil and official
 * bots, but a caption is still refused when a name holds anything beyond
 * letters, digits, spaces and . ' - _ , so a change upstream cannot put a link
 * or a mention in a post.
 */
import { ENDINGS, fastForwardTag } from "../edl.mjs";

/** Where the YouTube description sends people (measurement plan, 2026-10-25). */
export const YOUTUBE_LINK =
  "https://wallgame.io/?utm_source=youtube&utm_medium=social&utm_campaign=daily-video";

/**
 * The caption and title style that DIRECTOR.md's "Captions and titles"
 * section teaches. Each cycle keeps the version its caption was written
 * under, and every post-log row carries it, so Wall Game Growth can compare
 * the posts before and after a change (Wall Game PM, 2026-10-26). Bump it
 * whenever those rules change, and name the new value in DIRECTOR.md.
 */
export const CAPTION_STYLE_VERSION = "wallz-lingo-1";

/** X counts every character as one here; the limit for a free account. */
export const X_MAX_CHARS = 280;
export const YOUTUBE_TITLE_MAX_CHARS = 100;

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
        ? `zoom on ${e.frame.join(" ")}`
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
  const outcome = (b) =>
    winner === b.hunter.player
      ? ` ${name(winner)} still wins at move ${base.movesCount}, ${base.movesCount - b.save.moveNumber} moves after the save.`
      : winner === b.prey.player
        ? ` ${name(winner)} wins at move ${base.movesCount}.`
        : "";
  return {
    ...base,
    facts: [
      ...base.beats.map(
        (b) => `Move ${b.save.moveNumber}: ${b.description}${outcome(b)}`,
      ),
      ...base.picks.map((p) => `Move ${p.moveNumber}: ${p.description}`),
    ],
  };
};

/**
 * The three posted texts, from the one caption the crew lead wrote. X gets the
 * caption alone (no link: a link raises the price); YouTube gets it as the
 * title, unless the crew lead wrote a separate one, and in the description
 * above the tracked link.
 *
 * A title too long for YouTube loses the end of its teaser, never its
 * hashtags (the ones at the end) or #Shorts. When the hashtags alone do not
 * fit, the title stays too long and captionProblems refuses it.
 */
export const captionFrom = (text, title) => {
  const caption = String(text ?? "").trim();
  const head = String(title ?? caption).trim();
  const [, teaser, tagText] = head.match(/^(.*?)((?:\s+#[\p{L}\p{N}_]+)*)$/su);
  const tags = tagText
    .split(/\s+/)
    .filter((t) => t && t.toLowerCase() !== "#shorts");
  const tail = [...tags, "#Shorts"].join(" ");
  const room = YOUTUBE_TITLE_MAX_CHARS - [...tail].length - 1;
  const chars = [...teaser];
  // Cut at the last word that fits, or mid-word when one word is too long.
  const keep = Math.max(room - 1, 0);
  const kept = chars.slice(0, keep).join("");
  const atWord = /\s/.test(chars[keep] ?? "")
    ? kept
    : kept.slice(0, Math.max(0, kept.search(/\s\S*$/)));
  const cut =
    chars.length > room ? (atWord || kept).trimEnd() + "\u2026" : teaser;
  return {
    x: caption,
    youtubeTitle: `${cut} ${tail}`.trim(),
    youtubeDescription: `${caption}\n\nPlay Wall Game: ${YOUTUBE_LINK}`,
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
 * Reasons any published text cannot go out: the posted caption, and the
 * caption, payoff and stamps burned into the video. `texts` maps a name to
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

/** Reasons a caption cannot go out, or an empty list. */
export const captionProblems = (caption, gameId, players = []) => {
  const problems = textProblems(caption, gameId, players);
  if (/\n/.test(caption?.youtubeTitle ?? "")) {
    problems.push("youtubeTitle must be one line");
  }
  if (!caption?.x) problems.push("no X text");
  if (caption?.x && [...caption.x].length > X_MAX_CHARS) {
    problems.push(`X text is over ${X_MAX_CHARS} characters`);
  }
  // A URL in the text makes an X post cost $0.20 instead of $0.015 (task
  // e8d26610, Nil's decision of 2026-10-25), and X also reads bare domains.
  if (
    caption?.x &&
    /https?:\/\/|www\.|\.(io|com|gg|net|org)\b/i.test(caption.x)
  ) {
    problems.push("X text must not hold a link");
  }
  if (!caption?.youtubeTitle) problems.push("no YouTube title");
  if (
    caption?.youtubeTitle &&
    [...caption.youtubeTitle].length > YOUTUBE_TITLE_MAX_CHARS
  ) {
    problems.push(
      `YouTube title is over ${YOUTUBE_TITLE_MAX_CHARS} characters`,
    );
  }
  if (!caption?.youtubeDescription?.includes(YOUTUBE_LINK)) {
    problems.push("YouTube description must hold the tracked wallgame.io link");
  }
  return problems;
};
