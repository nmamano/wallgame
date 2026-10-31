/**
 * The image check (Nil, 2026-10-30: game analysis "should use a combination
 * of distance calculations and looking at images"): for each labelled move,
 * can a viewer SEE what the label and the sentence claim?
 *
 * THE TILES. storyboard.ts --tiles shoots each position of the game alone:
 * tile-ply-<N>.png is the position after ply N (tile-start.png before any
 * move), with that ply's walls and pawn move in yellow and the race counter
 * ("steps red N · blue M") under the board. A move at ply k is shown by
 * the tile before it (tile-ply-<k-1>, or tile-start) and tile-ply-<k>.
 *
 * THE MODEL. One headless `claude -p` call per game, Opus 5.5, with
 * --strict-mcp-config and --setting-sources project, and only the Read tool,
 * run in the tiles folder. For each labelled ply it reads the two tiles and
 * answers seen (true or false) with a short reason. Code never changes a
 * label from it: `seen` is a mark, and the Director prefers seen moments.
 */
import type { PlayerId } from "../../../shared/domain/game-types";
import { dailySeatColors } from "../edl.mjs";
import { boxedRoom } from "./facts";
import { countersShow, isMoment } from "./labels";
import { MODEL, type GameSemantics } from "./sentences";

export interface PlySeen {
  ply: number;
  seen: boolean;
  /** What a viewer can or cannot see in the two tiles, in a few words. */
  reason: string;
}

const STORYBOARD = new URL("../storyboard.ts", import.meta.url).pathname;

/** Shoots every tile of a stored candidate into `dir` (storyboard.ts). */
export const shootTiles = (candidatePath: string, dir: string) => {
  const sheet = `${dir}/sheet.png`;
  const run = Bun.spawnSync({
    cmd: [
      "bun",
      STORYBOARD,
      "--candidate",
      candidatePath,
      "--out",
      sheet,
      "--tiles",
      dir,
    ],
  });
  if (run.exitCode !== 0) {
    throw new Error(
      `storyboard.ts failed: ${run.stderr.toString().trim().split("\n").slice(-5).join("\n")}`,
    );
  }
};

const SCHEMA = {
  type: "object",
  properties: {
    plies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ply: { type: "integer" },
          seen: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["ply", "seen", "reason"],
      },
    },
  },
  required: ["plies"],
};

/**
 * What a viewer should SEE for each label or tag. A label the engine alone
 * makes (blunder, turn, trap-closes) has nothing of its own; its other tags
 * (a box-in under a blunder) say what the board shows.
 */
const VISIBLE: Partial<Record<string, string>> = {
  "box-in":
    "the new walls next to the mouse close off part of its ways out, together with the walls already there (it need not be fully enclosed)",
  threat: "the cat now close to the mouse, the counter falling to 2 or less",
  save: "the new walls between the cat and the mouse, the counter jumping up",
  escape: "the mouse stepping away from the cat, the counter going up",
  detour: "the new walls in the cat's way, the counter jumping up",
  punish:
    "the punishing move's effect: new walls in the cat's way with the counter jumping up, or the cat coming close",
  "self-trap": "the mover's own new walls in its own cat's way",
  standoff: "cat and mouse on next-door cells with a wall between them",
  capture: "the cat and the mouse meeting on one cell",
  home: "the cat reaching its home",
};

/** The claims of one labelled ply, in words a picture can be checked on. */
export const claimOf = (s: GameSemantics, ply: number): string => {
  const f = s.facts.plies[ply];
  const l = s.labels.plies[ply];
  const name = (p: PlayerId) =>
    s.facts.game.seats.find((x) => x.playerOrder === p)?.name ?? `P${p}`;
  const { focus } = l;
  /** A pawn's cell after the move, from any hunt that names it. */
  const cellOf = (pawn: { player: PlayerId; type: string }) =>
    f.hunts.find(
      (x) => x.target.player === pawn.player && x.target.type === pawn.type,
    )?.targetTo ??
    f.hunts.find(
      (x) => x.hunter.player === pawn.player && x.hunter.type === pawn.type,
    )?.hunterTo ??
    "?";
  const target =
    focus.target.type === "home"
      ? "its home"
      : `${name(focus.target.player)}'s ${focus.target.type} (on ${cellOf(focus.target)})`;
  const lines = [
    `label: ${l.label}${l.tags.length > 1 ? ` (also ${l.tags.filter((t) => t !== l.label).join(", ")})` : ""}`,
    `sentence: ${s.sentences?.[ply]?.sentence ?? "(none)"}`,
    `walls placed by this move: ${f.walls.length ? f.walls.join(", ") : "none"}`,
  ];
  if (l.tags.includes("box-in")) {
    // The box is the story the board tells, not the label's walk (a box-in
    // under a blunder has the blunder's focus).
    const room = boxedRoom(f);
    lines.push(
      `the new walls close in ${name(room.target.player)}'s mouse on ${cellOf(room.target)}: the cells it reaches before ${room.hunters.map((h) => `${name(h.player)}'s ${h.type}`).join(" or ")} fall from ${room.before} to ${room.after}`,
    );
  } else {
    lines.push(
      `${name(focus.hunter.player)}'s ${focus.hunter.type} (on ${cellOf(focus.hunter)} after the move) needs ${focus.before} steps to reach ${target} before the move and ${focus.after} after it`,
    );
  }
  lines.push(
    `what a viewer should see: ${l.tags.flatMap((t) => VISIBLE[t] ?? []).join("; ") || "nothing on the board: only the engine says it"}`,
  );
  return lines.join("\n");
};

/** The tile of the position before ply `ply` (storyboard.ts --tiles). */
const tileBefore = (ply: number) =>
  ply === 0 ? "tile-start.png" : `tile-ply-${ply - 1}.png`;

const prompt = (s: GameSemantics, plies: number[]): string => {
  const isBot = (p: PlayerId) =>
    s.facts.game.seats.find((x) => x.playerOrder === p)?.kind ===
    "official bot";
  const colors = dailySeatColors({ 1: isBot(1), 2: isBot(2) }) as Record<
    PlayerId,
    string
  >;
  const seats = s.facts.game.seats
    .map(
      (x) =>
        `${x.name} plays ${colors[x.playerOrder as PlayerId]} (pawns and walls in that colour)`,
    )
    .join("; ");
  return `You check whether a viewer of a short Wall Game video can SEE what a move means.
Wall Game: each player has a cat and a mouse; a cat wins by reaching the other player's mouse. Walls make paths longer.
${seats}. The images are board tiles in this folder. tile-ply-N.png is the position after ply N; tile-start.png is the start. In a tile, the walls and the pawn move of that ply are drawn in yellow, and the line under the board reads "steps red N · blue M": each side's cat's shortest walk to its target.

For each move below, Read its two tiles (before and after). Then answer:
- seen: true when a viewer who looks at the two tiles for two seconds can see "what a viewer should see": the new walls (yellow in the after tile) where the claim says they matter, the pawns where it says, the change in the step counter. false when there is nothing to see but the engine's verdict, when it takes careful counting to believe, or when the picture shows something else.
- reason: at most 20 words, what is or is not visible.
Do not judge whether the move is good; judge only what the pictures show.

MOVES:
${plies.map((ply) => `ply ${ply}: tiles ${tileBefore(ply)} (before) and tile-ply-${ply}.png (after)\n${claimOf(s, ply)}`).join("\n\n")}

Return JSON: {"plies": [{"ply": <ply>, "seen": <true|false>, "reason": "..."}]}, one entry per move.`;
};

/** One headless model call over `tilesDir`; returns its structured output. */
export const askVision = (
  input: string,
  tilesDir: string,
): { plies: PlySeen[]; costUsd: number } => {
  const proc = Bun.spawnSync({
    cmd: [
      "claude",
      "-p",
      "--model",
      MODEL,
      "--strict-mcp-config",
      "--setting-sources",
      "project",
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(SCHEMA),
    ],
    stdin: Buffer.from(input),
    cwd: tilesDir,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `claude -p failed: ${proc.stderr.toString().slice(0, 500)}`,
    );
  }
  const reply = JSON.parse(proc.stdout.toString()) as {
    is_error?: boolean;
    structured_output?: { plies: PlySeen[] };
    total_cost_usd?: number;
  };
  if (reply.is_error || !reply.structured_output) {
    throw new Error("claude -p gave no structured output");
  }
  return {
    plies: reply.structured_output.plies,
    costUsd: reply.total_cost_usd ?? 0,
  };
};

/**
 * The seen mark of every labelled (not quiet) ply. A ply the model left
 * out is not seen, with that as its reason. A move whose counters flip the
 * lead, or turn a tie into the mover's lead, is seen whatever the model says
 * (Director, 2026-10-31, C36 D: the viewer reads the counters).
 */
export const checkSeen = (
  s: GameSemantics,
  tilesDir: string,
  ask: typeof askVision = askVision,
): PlySeen[] => {
  const plies = s.labels.plies.filter(isMoment).map((l) => l.ply);
  if (plies.length === 0) return [];
  const { plies: answers, costUsd } = ask(prompt(s, plies), tilesDir);
  console.error(
    `vision call: $${costUsd.toFixed(2)} for ${plies.length} plies`,
  );
  const byPly = new Map(answers.map((a) => [a.ply, a]));
  return plies.map((ply) => {
    const answer = byPly.get(ply) ?? {
      ply,
      seen: false,
      reason: "the model gave no answer",
    };
    if (!answer.seen && countersShow(s.labels.plies[ply])) {
      return {
        ply,
        seen: true,
        reason: `the counters show it (the lead changes). Model: ${answer.reason}`,
      };
    }
    return answer;
  });
};
