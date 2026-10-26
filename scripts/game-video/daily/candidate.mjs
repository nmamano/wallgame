/**
 * From one entry of the step-1 candidate report to the day's candidate and
 * its captions.
 *
 * The report is the JSON that scripts/game-video/pick-daily-candidates.ts
 * writes (kind "daily-video-candidates"). This file reads that JSON only, so
 * the pipeline does not depend on how the report is made.
 *
 * CAPTIONS ARE A FIRST DRAFT. Nil approves each post for the first two weeks
 * and can reject with a better caption; the crew lead then picks again with
 * --caption. After that the crew posts the template by itself, which is why
 * the template stays plain.
 *
 * PLAYER NAMES ARE UNTRUSTED TEXT that would go out under the Wall Game
 * account. Step 1 admits only guests (random animal names), Nil and official
 * bots, but a caption is still refused when a name holds anything beyond
 * letters, digits, spaces and . ' - _ , so a change upstream cannot put a link
 * or a mention in a post.
 */
/** Where the YouTube description sends people (measurement plan, 2026-10-25). */
export const YOUTUBE_LINK =
  "https://wallgame.io/?utm_source=youtube&utm_medium=social&utm_campaign=daily-video";

/** X counts every character as one here; the limit for a free account. */
export const X_MAX_CHARS = 280;
export const YOUTUBE_TITLE_MAX_CHARS = 100;

/** The renderer's styles (Wall Game Worker 2, 2026-10-26). */
export const STYLES = ["current", "wallz", "mix"];
/** Until Nil picks one in the step-2 preview. */
export const DEFAULT_STYLE = "current";

const SAFE_NAME = /^[\p{L}\p{N} .'_-]{1,40}$/u;
const GAME_ID = /^[A-Za-z0-9_-]{4,40}$/;

const percent = (p) => `${Math.round(p * 100)}%`;

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
  if (!entry.topSwings?.length) {
    throw new Error(`${entry.gameId} has no swings`);
  }
  return {
    gameId: entry.gameId,
    variant: entry.variant,
    boardWidth: entry.boardWidth,
    boardHeight: entry.boardHeight,
    movesCount: entry.movesCount,
    startedAt: entry.startedAt,
    seats: entry.seats.map((s) => ({ name: s.name, kind: s.kind })),
    swings: entry.topSwings.map((s) => ({
      ply: s.ply,
      moveNumber: s.moveNumber,
      mover: s.mover,
      notation: s.notation,
      moverBefore: s.moverBefore,
      moverAfter: s.moverAfter,
      delta: s.delta,
      size: s.size,
    })),
    source: { reportCreatedAt: report.createdAt, rank },
  };
};

/** The default X text, YouTube title and YouTube description. */
export const draftCaption = (candidate) => {
  const [a, b] = candidate.seats.map((s) => s.name);
  const top = candidate.swings[0];
  const mover = candidate.seats[top.mover - 1]?.name ?? `Player ${top.mover}`;
  const turn =
    top.delta < 0
      ? `${mover} was ${percent(top.moverBefore)} to win. Then came move ${top.moveNumber}.`
      : `${mover} was ${percent(top.moverBefore)} to win. Move ${top.moveNumber} made it ${percent(top.moverAfter)}.`;
  const x = `${a} vs ${b}. ${turn} #WallGame`;
  return {
    x,
    youtubeTitle: `${a} vs ${b}: move ${top.moveNumber} #Shorts`,
    youtubeDescription: `${turn}\n\nPlay Wall Game: ${YOUTUBE_LINK}`,
  };
};

/** Reasons a caption cannot go out, or an empty list. */
export const captionProblems = (caption) => {
  const problems = [];
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
