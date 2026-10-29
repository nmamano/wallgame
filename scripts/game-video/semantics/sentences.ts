/**
 * One sentence per move, written by a model from that move's facts only, and
 * checked against them by code.
 *
 * THE FACTS. Each move gets a short list of facts, each with an id, written
 * here from facts.ts and labels.ts: who moved, what the move did, every
 * hunt's walk before and after, the engine's win chance and best move, the
 * label and the links. The model sees only these.
 *
 * THE MODEL writes the sentence and names the ids of the facts it used. It
 * does not choose the label or the strength (labels.ts does). One headless
 * `claude -p` call per game, Sonnet 5.5, with --strict-mcp-config and
 * --setting-sources project (office note of 2026-10-21: without them each run
 * loads 200+ connector tools) and no tools.
 *
 * THE CHECK (checkSentence) is code, not a second model. Every number, cell,
 * wall, seat name, pawn word and judgment word ("blunder", "save", "wins")
 * in the sentence must appear in the facts it cites; it cites only facts of
 * its own move and of linked moves; it says nothing about intent ("tries",
 * "panics"). A sentence that fails gets one retry with the reasons; if it
 * fails again, the move's own play fact stands in and is marked `fallback`.
 * A "from N to M" must be a before/after pair of a cited fact, in order.
 *
 * KNOWN GAPS of a word check (VR1, 2026-10-29). Apart from "from N to M",
 * numbers, cells and names are checked as a bag over the cited facts, not
 * bound to each other: "Guest X's walk" with the other side's numbers, or
 * a cell given to the wrong pawn, can pass. The word lists (intent, colour,
 * judgment) are open: a new word for intent passes until it is listed. A
 * seat name other than the game's is caught only in the "Guest X" and
 * "X Bot" forms. "walk" as a verb also needs its owner ("Guest X's cat
 * walks").
 */
import type { PlayerId } from "../../../shared/domain/game-types";
import type { GameFacts, HuntChange, PlyFacts } from "./facts";
import type { GameLabels, Link } from "./labels";

export const MODEL = "claude-sonnet-5-5";
export const MAX_WORDS = 35;

export interface Fact {
  id: string;
  text: string;
}

export interface PlySentence {
  ply: number;
  sentence: string;
  factIds: string[];
  /** The model's sentence failed the check twice; a fact stands in. */
  fallback: boolean;
  /** Why the last model sentence failed, if it did. */
  rejected: string[];
}

export interface GameSemantics {
  facts: GameFacts;
  labels: GameLabels;
  sentences: PlySentence[] | null;
}

/* ----------------------------------------------------------- the facts -- */

const pct = (x: number) => `${Math.round(x * 100)}%`;
const steps = (n: number) => `${n} step${n === 1 ? "" : "s"}`;

const namesOf = (facts: GameFacts): Record<PlayerId, string> => {
  const name = (p: number) =>
    facts.game.seats.find((s) => s.playerOrder === p)?.name ?? `Player ${p}`;
  return { 1: name(1), 2: name(2) };
};

const huntText = (h: HuntChange, names: Record<PlayerId, string>) => {
  const target =
    h.target.type === "home"
      ? `${names[h.hunter.player]}'s home`
      : `${names[h.target.player]}'s ${h.target.type}`;
  const who = `${names[h.hunter.player]}'s ${h.hunter.type} (on ${h.hunterTo})`;
  return h.before === h.after
    ? `${who} needs ${steps(h.after)} to reach ${target}, the same as before the move.`
    : `${who} needs ${steps(h.after)} to reach ${target}; before the move it needed ${h.before}.`;
};

const playText = (f: PlyFacts, names: Record<PlayerId, string>) => {
  const parts = [
    ...f.steps.map((s) => `moves the ${s.type} from ${s.from} to ${s.to}`),
    ...(f.walls.length === 0
      ? []
      : [
          `places ${f.walls.length === 1 ? "a wall" : "walls"} ${f.walls.join(" and ")}`,
        ]),
  ];
  return `Move ${f.moveNumber}: ${names[f.mover]} ${parts.join(" and ") || "plays " + f.notation}.`;
};

const linkText = (
  link: Link,
  ply: number,
  facts: GameFacts,
  names: Record<PlayerId, string>,
): string => {
  const at = (k: number) => facts.plies[k];
  const n = (k: number) => at(k).moveNumber;
  const chance = (k: number) => {
    const e = at(k).engine;
    return e
      ? ` (${names[at(k).mover]}'s win chance fell from ${pct(e.before)} to ${pct(e.after)})`
      : "";
  };
  const self = link.from === ply;
  switch (link.kind) {
    case "blunder-punish":
      return self
        ? `Move ${n(link.to)} by ${names[at(link.to).mover]} punishes this blunder.`
        : `This move punishes the blunder of move ${n(link.from)} by ${names[at(link.from).mover]}${chance(link.from)}.`;
    case "threat-save":
      return self
        ? `Move ${n(link.to)} by ${names[at(link.to).mover]} saves the mouse from this threat.`
        : `This move answers the threat of move ${n(link.from)}: a save.`;
    case "threat-escape":
      return self
        ? `On move ${n(link.to)} the mouse escapes this threat.`
        : `This move answers the threat of move ${n(link.from)}: an escape.`;
    case "sealed-capture":
      return self
        ? `From this move on the engine keeps ${names[at(ply).mover]} at 90% or more until the capture on move ${n(link.to)}.`
        : `The game was sealed on move ${n(link.from)}.`;
  }
};

/** The facts of one move, with ids "<ply>.<name>". */
export const factsOf = (
  facts: GameFacts,
  labels: GameLabels,
  ply: number,
): Fact[] => {
  const f = facts.plies[ply];
  const l = labels.plies[ply];
  const names = namesOf(facts);
  const kind = (p: PlayerId) =>
    facts.game.seats.find((s) => s.playerOrder === p)?.kind ?? "player";
  const out: Fact[] = [];
  const add = (name: string, text: string) =>
    out.push({ id: `${ply}.${name}`, text });
  add("play", playText(f, names));
  add(
    "who",
    `${names[f.mover]} is ${kind(f.mover) === "official bot" ? "a bot" : kind(f.mover) === "guest" ? "a guest player" : "a player"}.`,
  );
  f.hunts.forEach((h, i) => add(`walk${i + 1}`, huntText(h, names)));
  const e = f.engine;
  if (e) {
    add(
      "engine",
      e.afterFromResult
        ? `The engine gave ${names[f.mover]} a ${pct(e.before)} win chance before this move; the move ends the game.`
        : `The engine gives ${names[f.mover]} a ${pct(e.before)} win chance before this move and ${pct(e.after)} after it.`,
    );
    if (e.playedBest) {
      add("best", "This move is the engine's top choice.");
    } else if (e.bestMove) {
      const walls = e.bestWalls.length
        ? `, with ${e.bestWalls.length === 1 ? "the wall" : "the walls"} ${e.bestWalls.join(" and ")}`
        : ", with no wall";
      let what = `The engine preferred ${e.bestMove}${walls} to this move.`;
      if (e.bestWalks) {
        // Only a walk the best move makes better FOR THE MOVER says why it
        // is best: the other side's walk longer, or the mover's own shorter.
        // (A best move can also lengthen the mover's own walk, as a wall
        // that guards its mouse does; that alone would mislead.)
        const gains = f.hunts.flatMap((h, i) => {
          const best = e.bestWalks![i];
          const gain =
            h.hunter.player === f.mover ? h.after - best : best - h.after;
          return gain > 0 ? [{ h, best, gain }] : [];
        });
        const most = gains.sort((a, b) => b.gain - a.gain)[0];
        if (most) {
          const target =
            most.h.target.type === "home"
              ? "its home"
              : `${names[most.h.target.player]}'s ${most.h.target.type}`;
          what += ` With it, ${names[most.h.hunter.player]}'s ${most.h.hunter.type} would need ${steps(most.best)} to reach ${target}, not ${most.h.after}.`;
        }
      }
      add("best", what);
    }
  }
  const tagText = l.tags.filter((t) => t !== l.label);
  add(
    "label",
    `Label: ${l.label}${tagText.length ? ` (also: ${tagText.join(", ")})` : ""}.`,
  );
  labels.links
    .filter((k) => k.from === ply || k.to === ply)
    .forEach((k, i) => add(`link${i + 1}`, linkText(k, ply, facts, names)));
  if (f.end) {
    const caught = f.hunts.find(
      (h) => h.after === 0 && h.hunter.player === f.mover,
    );
    add(
      "end",
      caught
        ? `${names[f.mover]}'s ${caught.hunter.type} reaches ${caught.target.type === "home" ? "its home" : `${names[caught.target.player]}'s ${caught.target.type}`} (a capture): ${f.end.winner ? `${names[f.end.winner]} wins` : "the game ends"}.`
        : `The game ends: ${f.end.winner ? `${names[f.end.winner]} wins` : "no winner"}.`,
    );
  }
  return out;
};

/* ------------------------------------------------------------ the check -- */

const UNITS = (
  "zero one two three four five six seven eight nine ten eleven twelve " +
  "thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
).split(" ");
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const NUMBER_WORDS: Record<string, string> = { hundred: "100" };
UNITS.forEach((w, i) => (NUMBER_WORDS[w] = String(i)));
TENS.forEach((w, i) => (NUMBER_WORDS[w] = String(20 + 10 * i)));

/**
 * "one" is a count only before a unit ("one step", "one wall"); elsewhere
 * ("one of the walls") it is not checked.
 */
const ONE_COUNT =
  /\bone\s+(?:more\s+|extra\s+)?(?:step|move|wall|square|cell|turn|ply)s?\b/gi;

/** A judgment word, and the stem a cited fact must hold for it. */
const JUDGMENTS: [RegExp, string][] = [
  [/\b(blunder\w*|mistake\w*|error\w*)\b/i, "blunder"],
  [/\bpunish\w*\b/i, "punish"],
  [/\b(sav(e|es|ed|ing)|rescu\w*)\b/i, "save"],
  [/\b(escap\w*|flee\w*|flees|fled)\b/i, "escape"],
  [/\b(threat\w*|danger\w*)\b/i, "threat"],
  [/\b(trap\w*|cage\w*|seal\w*|lock\w*|box(es|ed)? in)\b/i, "trap-closes|seal"],
  [/\b(win|wins|won|winner|victory)\b/i, "wins"],
  [/\b(catch\w*|caught|captur\w*)\b/i, "capture"],
  // The two engine facts use distinct words (VR1 B2): "top choice" only on
  // the engine's own move, "preferred" only on another.
  [/\b(best|top choice|optimal|perfect|correct)\b/i, "top choice"],
  [
    /\b(miss\w*|skip\w*|ignor\w*|overlook\w*|instead of the engine)\b/i,
    "preferred",
  ],
  [/\b(turn(s|ed)? the game|turning point|flip\w*)\b/i, "turn"],
  [/\bstandoff\b/i, "standoff"],
];

/** Words about intent or feeling: the facts cannot show them. */
const INTENT =
  /\b(tr(y|ies|ied)|want\w*|hop(e|es|ed)|panic\w*|think\w*|thought|plan\w*|decid\w*|desperate\w*|smart\w*|genius|brilliant\w*|clever\w*|lucky|luck|finally|sneak\w*|confus\w*|scared|afraid|nervous|realiz\w*|forgot\w*|expect\w*|surpris\w*|intend\w*|aim\w*|sees?|saw|seen|know\w*|rush\w*|gives? up|gave up|notic\w*)\b/i;

const CELL = /(?<![\w>^])[>^]?[a-l](?:1[0-2]|[1-9])\b/gi;
const COLOURS =
  /\b(red|blue|green|yellow|orange|purple|pink|white|black|grey|gray|brown)\b/i;

/**
 * Every "from N to M" a cited fact holds, as "N>M": a walk's before and
 * after, a win chance's before and after, and a best move's "would need X,
 * not Y" (from Y to X).
 */
const citedPairs = (cited: string): Set<string> => {
  const pairs = new Set<string>();
  const add = (re: RegExp, from: number, to: number) => {
    for (const m of cited.matchAll(re)) pairs.add(`${m[from]}>${m[to]}`);
  };
  add(
    /needs (\d+) steps? to reach [^;.]*; before the move it needed (\d+)/g,
    2,
    1,
  );
  add(/(\d+)% win chance before this move and (\d+)% after/g, 1, 2);
  add(/from (\d+)% to (\d+)%/g, 1, 2);
  add(/would need (\d+) steps? to reach [^,.]*, not (\d+)/g, 2, 1);
  return pairs;
};
const PAWN = /\b(cat|cats|mouse|mice|home|dog|elephant)\b/gi;

/** Reasons the sentence breaks the rules; [] when it passes. */
export const checkSentence = (
  sentence: string,
  factIds: string[],
  allowed: Fact[],
  seatNames: string[],
): string[] => {
  if (seatNames.length === 0)
    throw new Error("checkSentence needs the seat names");
  const reasons: string[] = [];
  const byId = new Map(allowed.map((f) => [f.id, f.text]));
  for (const id of factIds) {
    if (!byId.has(id))
      reasons.push(
        `cites ${id}, which is not a fact of this move or a linked move`,
      );
  }
  const cited = factIds.flatMap((id) => byId.get(id) ?? []).join(" ");
  const citedLower = cited.toLowerCase();
  const words = sentence.trim().split(/\s+/);
  if (words.length > MAX_WORDS)
    reasons.push(`has ${words.length} words; at most ${MAX_WORDS}`);
  if (/[.!?]\s+\S/.test(sentence.trim()))
    reasons.push("is more than one sentence");
  // Numbers: digits, percents and number words.
  // A cell's digits ("a1") are no number.
  const citedNumbers = new Set(cited.replace(CELL, " ").match(/\d+/g) ?? []);
  const textNoCells = sentence.replace(CELL, " ");
  for (const n of textNoCells.match(/\d+/g) ?? []) {
    if (!citedNumbers.has(n))
      reasons.push(`the number ${n} is not in the cited facts`);
  }
  for (const w of sentence.toLowerCase().match(/\b[a-z]+\b/g) ?? []) {
    const n = NUMBER_WORDS[w];
    if (n !== undefined && w !== "one" && !citedNumbers.has(n)) {
      reasons.push(`"${w}" (${n}) is not in the cited facts`);
    }
  }
  for (const one of sentence.matchAll(ONE_COUNT)) {
    if (!citedNumbers.has("1"))
      reasons.push(`"${one[0]}" (1) is not in the cited facts`);
  }
  // A "from N to M" must be one of the cited before/after pairs, in that
  // direction (VR1, 2026-10-29: a bag of numbers lets "3 to 8" pass for 8
  // to 3).
  const pairs = citedPairs(cited);
  for (const m of sentence.matchAll(/\bfrom (\d+)%?(?: steps?)? to (\d+)/gi)) {
    if (!pairs.has(`${m[1]}>${m[2]}`))
      reasons.push(`"${m[0]}" is not a before/after pair of the cited facts`);
  }
  // Cells and walls.
  const citedCells = new Set(
    (cited.match(CELL) ?? []).map((c) => c.toLowerCase()),
  );
  for (const c of sentence.match(CELL) ?? []) {
    if (!citedCells.has(c.toLowerCase()))
      reasons.push(`${c} is not in the cited facts`);
  }
  // Pawn words.
  for (const p of sentence.match(PAWN) ?? []) {
    const base = p
      .toLowerCase()
      .replace(/^cats$/, "cat")
      .replace(/^mice$/, "mouse");
    if (!citedLower.includes(base))
      reasons.push(`"${p}" is not in the cited facts`);
  }
  // Seat names: every seat named must be cited; a colour must be in the
  // cited facts ("Red's cat" says nothing the facts bind).
  for (const name of seatNames) {
    if (sentence.includes(name) && !cited.includes(name))
      reasons.push(`"${name}" is not in the cited facts`);
  }
  const colour = COLOURS.exec(sentence);
  if (colour && !citedLower.includes(colour[0].toLowerCase()))
    reasons.push(`"${colour[0]}" is not in the cited facts`);
  // Any other "Guest X" or "X Bot" is no player of this game.
  for (const name of sentence.match(
    /\bGuest [A-Z][a-z]+\b|\b[A-Z][a-z]+ Bot\b/g,
  ) ?? []) {
    if (!seatNames.includes(name))
      reasons.push(`"${name}" is not a player of this game`);
  }
  // A walk names its owner (Wall Game PM, 2026-10-29: "the walk at 4
  // steps" left the reader to guess whose): "Normal Bot's walk" or
  // "Normal Bot's cat walk", never "the walk" or "its walk".
  const owner = new RegExp(
    `(?:${seatNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})'s (?:(?:cat|mouse|dog|elephant)(?:'s)? )?$`,
  );
  for (const walk of sentence.matchAll(/\bwalks?\b/gi)) {
    if (!owner.test(sentence.slice(0, walk.index))) {
      reasons.push(
        `"${walk[0]}" must follow its owner's name ("<player>'s walk")`,
      );
    }
  }
  // Judgment words.
  const plain = sentence.replace(/\bwin chance\b/gi, "chance");
  for (const [word, stems] of JUDGMENTS) {
    const hit = word.exec(plain);
    if (!hit) continue;
    // A self-trap lets the sentence say the mover trapped its own cat, not
    // that it trapped the other side (VR1, 2026-10-29).
    if (
      stems.startsWith("trap") &&
      citedLower.includes("self-trap") &&
      /\b(own|itself|themselves)\b/i.test(sentence)
    )
      continue;
    if (!stems.split("|").some((s) => citedLower.includes(s))) {
      reasons.push(
        `"${hit[0]}" needs a cited fact that says ${stems.replace("|", " or ")}`,
      );
    }
  }
  const intent = INTENT.exec(sentence);
  if (intent)
    reasons.push(
      `"${intent[0]}" is about intent or feeling, which the facts cannot show`,
    );
  return reasons;
};

/* ------------------------------------------------------------ the model -- */

const PROMPT = `You write ONE sentence per move of a Wall Game match, for the people who edit short videos of it.
Wall Game: each player has a cat and a mouse. A cat wins by reaching the other player's mouse. On a turn a player does two actions: pawn steps and/or walls. Walls make paths longer. "Steps" is the shortest walk around the walls.

Rules:
- Use ONLY the facts given for that move. No fact, no claim. Never guess intent or feelings.
- The sentence says what the move MEANS for the game, in the spirit of its "Label" fact. Do not just list the steps.
  - blunder/turn: say what went wrong, from the engine's best move (e.g. the wall it skipped) or from the linked move that punishes it (what that move then did).
  - punish/save/escape/threat/detour: say what the move does to the walk (from N to M steps), and to whom.
  - quiet: plain and short.
- Simple English, present tense, at most 30 words, one sentence. Name who acts. Use digits for numbers.
- Write cells and walls exactly as in the facts (c5, ^a1, >e4). Use player names exactly as in the facts.
- Name the owner of every walk: "Normal Bot's walk" or "Normal Bot's cat walk", never "the walk" or "its walk".
- Words like blunder, punish, save, escape, threat, trap, wins, capture: use them only when a fact you cite says so. Say "best" only when a cited fact says "top choice"; say "skips" or "misses" only when a cited fact says the engine "preferred" another move.
- "from N to M" must be a before/after pair of a cited fact, in that order.
- factIds: the ids of every fact your sentence uses (numbers, cells, names, words). Cite enough.

Return JSON: {"sentences": [{"ply": <ply>, "sentence": "...", "factIds": ["..."]}]}, one entry per move given.`;

const SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ply: { type: "integer" },
          sentence: { type: "string" },
          factIds: { type: "array", items: { type: "string" } },
        },
        required: ["ply", "sentence", "factIds"],
      },
    },
  },
  required: ["sentences"],
};

interface ModelSentence {
  ply: number;
  sentence: string;
  factIds: string[];
}

/** One headless model call; returns its structured output. */
export const askModel = (input: string): ModelSentence[] => {
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
      "",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(SCHEMA),
    ],
    stdin: Buffer.from(input),
    cwd: "/tmp",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `claude -p failed: ${proc.stderr.toString().slice(0, 500)}`,
    );
  }
  const reply = JSON.parse(proc.stdout.toString()) as {
    is_error?: boolean;
    structured_output?: { sentences: ModelSentence[] };
    total_cost_usd?: number;
  };
  if (reply.is_error || !reply.structured_output) {
    throw new Error(`claude -p gave no structured output`);
  }
  console.error(`model call: $${(reply.total_cost_usd ?? 0).toFixed(2)}`);
  return reply.structured_output.sentences;
};

/** The facts a move's sentence may cite: its own and its linked moves'. */
const allowedFacts = (
  all: Fact[][],
  labels: GameLabels,
  ply: number,
): Fact[] => {
  const linked = labels.links.flatMap((k) =>
    k.from === ply ? [k.to] : k.to === ply ? [k.from] : [],
  );
  return [ply, ...linked].flatMap((k) => all[k]);
};

export const writeSentences = (
  facts: GameFacts,
  labels: GameLabels,
  ask: (input: string) => ModelSentence[] = askModel,
): GameSemantics => {
  const all = facts.plies.map((_, ply) => factsOf(facts, labels, ply));
  const seatNames = facts.game.seats.map((s) => s.name);
  const request = (plies: number[], notes: Map<number, string[]>) =>
    `${PROMPT}\n\nMOVES:\n${JSON.stringify(
      plies.map((ply) => ({
        ply,
        facts: allowedFacts(all, labels, ply),
        ...(notes.has(ply) ? { yourLastSentenceFailed: notes.get(ply) } : {}),
      })),
      null,
      1,
    )}`;
  const result = new Map<number, PlySentence>();
  let todo = facts.plies.map((f) => f.ply);
  let notes = new Map<number, string[]>();
  for (let attempt = 0; attempt < 2 && todo.length > 0; attempt++) {
    const answers = new Map(ask(request(todo, notes)).map((a) => [a.ply, a]));
    const failed = new Map<number, string[]>();
    for (const ply of todo) {
      const a = answers.get(ply);
      const reasons = a
        ? checkSentence(
            a.sentence,
            a.factIds,
            allowedFacts(all, labels, ply),
            seatNames,
          )
        : ["no sentence returned"];
      if (a && reasons.length === 0) {
        result.set(ply, {
          ply,
          sentence: a.sentence,
          factIds: a.factIds,
          fallback: false,
          rejected: [],
        });
      } else {
        failed.set(
          ply,
          reasons.map((r) => (a ? `"${a.sentence}": ${r}` : r)),
        );
      }
    }
    todo = [...failed.keys()];
    notes = failed;
  }
  for (const ply of todo) {
    const play = all[ply][0];
    result.set(ply, {
      ply,
      sentence: play.text,
      factIds: [play.id],
      fallback: true,
      rejected: notes.get(ply) ?? [],
    });
  }
  return {
    facts,
    labels,
    sentences: facts.plies.map((f) => result.get(f.ply)!),
  };
};

/* ------------------------------------------------------------- the table -- */

/** The short file for a person: the moves that mean something, then the rest. */
export const renderTable = (s: GameSemantics): string => {
  const { game } = s.facts;
  const names = namesOf(s.facts);
  const winner = s.facts.winner
    ? names[s.facts.winner]
    : "no winner on the board";
  const lines = [
    `# ${game.gameId} - ${game.variant} ${game.boardWidth}x${game.boardHeight}, ${names[1]} (P1) vs ${names[2]} (P2), ${game.moves.length} moves, ${winner} wins`,
    "",
    `https://wallgame.io/game/${game.gameId}  ·  engine: ${s.facts.engineBotId ?? "none"}  ·  move = ply + 1 (the replay page's count)`,
    "",
    "| move | ply | by | label | strength | sentence |",
    "|---|---|---|---|---|---|",
  ];
  const quiet: number[] = [];
  for (const l of s.labels.plies) {
    if (l.label === "quiet") {
      quiet.push(l.moveNumber);
      continue;
    }
    const sentence = s.sentences?.[l.ply];
    const text = sentence
      ? `${sentence.sentence}${sentence.fallback ? " *(fact, model failed check)*" : ""}`
      : "";
    const tags = l.tags.filter((t) => t !== l.label);
    lines.push(
      `| ${l.moveNumber} | ${l.ply} | ${names[l.mover]} | ${l.label}${tags.length ? ` (${tags.join(", ")})` : ""} | ${l.strength.toFixed(2)} | ${text} |`,
    );
  }
  lines.push("", `Quiet moves (${quiet.length}): ${quiet.join(", ")}.`);
  if (s.labels.links.length) {
    lines.push(
      "",
      `Links: ${s.labels.links.map((k) => `${k.kind} ${k.from + 1} -> ${k.to + 1}`).join("; ")}.`,
    );
  }
  return lines.join("\n") + "\n";
};
