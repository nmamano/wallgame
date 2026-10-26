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
import { ENDINGS } from "../edl.mjs";

/** Where the YouTube description sends people (measurement plan, 2026-10-25). */
export const YOUTUBE_LINK =
  "https://wallgame.io/?utm_source=youtube&utm_medium=social&utm_campaign=daily-video";

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
    (p) => `plies ${p.fromPly}-${p.toPly}: ${p.secondsPerMove} s per move`,
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
    source: { reportCreatedAt: report.createdAt, rank },
  };
  return {
    ...base,
    facts: [
      ...base.beats.map((b) => `Move ${b.save.moveNumber}: ${b.description}`),
      ...base.picks.map((p) => `Move ${p.moveNumber}: ${p.description}`),
    ],
  };
};

/**
 * The three posted texts, from the one caption the crew lead wrote. X gets the
 * caption alone (no link: a link raises the price); YouTube gets it as the
 * title, unless the crew lead wrote a separate one, and in the description
 * above the tracked link.
 */
export const captionFrom = (text, title) => {
  const caption = String(text ?? "").trim();
  const head = String(title ?? caption).trim();
  const room = YOUTUBE_TITLE_MAX_CHARS - " #Shorts".length;
  return {
    x: caption,
    youtubeTitle: `${[...head].length > room ? [...head].slice(0, room - 1).join("") + "\u2026" : head} #Shorts`,
    youtubeDescription: `${caption}\n\nPlay Wall Game: ${YOUTUBE_LINK}`,
  };
};

/**
 * Reasons any published text cannot go out: the posted caption, and the
 * caption and stamps burned into the video. `texts` maps a name to its text.
 */
export const textProblems = (texts, gameId) => {
  const problems = [];
  const id = String(gameId ?? "").toLowerCase();
  for (const [field, text] of Object.entries(texts ?? {})) {
    if (id && String(text).toLowerCase().includes(id)) {
      problems.push(`${field} must not hold the game id`);
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
export const captionProblems = (caption, gameId) => {
  const problems = textProblems(caption, gameId);
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
