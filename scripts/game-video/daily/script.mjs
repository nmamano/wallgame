/**
 * Phase 1 of a video, the script (Nil, 2026-10-29: "first scripting the
 * video, like what will happen when, make sure it's narratively sound
 * first. then implement"; SCRIPT.md). crew.mjs `script` drafts the script
 * file from the item's game and list, for the director to complete;
 * `script-review-prompt` gives the reviewer the other videos of the batch.
 * Pure: the text only, from what crew.mjs reads.
 */
import { dailySeatColors, edlSoundUses } from "../edl.mjs";
import { raceWinner } from "./candidate.mjs";

/** Each seat's colour in the video, by player order (dailySeatColors). */
export const seatColors = (candidate) =>
  dailySeatColors(
    Object.fromEntries(
      candidate.seats.map((s) => [s.playerOrder, s.kind === "official bot"]),
    ),
  );

/**
 * The day the one-move draw rule ended: before it, a capture by player 1
 * with player 2 one move from a catch was a draw (b24de9e8; FkQKb63y,
 * 2026-08-03, was one).
 */
export const ONE_MOVE_RULE_UNTIL = "2026-09-01";

/**
 * The player order that a script's header names as the winner, from its
 * "Winner:" line (SCRIPT.md: "Winner: <who> (<colour>), by <how>"). The
 * colour in the first brackets wins ("bro (blue, the human)"); with no
 * colour there, the line must name one colour only: "Winner: the human
 * beats red (blue)" reads blue, and "Winner: the human, after red's wall,
 * blue" is refused (VR1, review 115 N2).
 * @returns {{ player: 1 | 2 } | { problem: string }}
 */
export const scriptWinner = (script, candidate) => {
  const colours = seatColors(candidate);
  const form = `write "Winner: <who> (<colour>), by <how>" (SCRIPT.md)`;
  const line = script.split("\n").find((l) => /^\s*Winner:/i.test(l));
  if (!line)
    return { problem: `the script's header has no Winner line: ${form}` };
  const bracket = line
    .match(/\(([^)]*)\)?/)?.[1]
    .match(/^\s*(red|blue)\b/i)?.[1];
  const named = new Set(
    [...line.matchAll(/\b(red|blue)\b/gi)].map((m) => m[1].toLowerCase()),
  );
  const colour =
    bracket?.toLowerCase() ?? (named.size === 1 ? [...named][0] : null);
  if (!colour) {
    return {
      problem:
        named.size === 0
          ? `the script's Winner line names no colour: ${form}`
          : `the script's Winner line names both red and blue and no colour in brackets: ${form}`,
    };
  }
  return { player: colours[1] === colour ? 1 : 2 };
};

/**
 * Why the item's game must not make a video, from its stored result
 * (candidate.result) and the script that passed review (null: none yet;
 * render refuses the item then). Two checks that do not lean on each
 * other: the record has a winner, and the script names the same one
 * (Wall Game PM, 2026-10-31, after FkQKb63y: a draw that the move
 * sentences, the script and its review all called a capture win).
 * @returns {string[]} the faults; empty when none
 */
export const resultProblems = (candidate, script) => {
  const r = candidate.result;
  if (!r) {
    // A pick from before the report carried results. Since the rule
    // changed, a capture always wins; before, it could be a draw.
    return candidate.startedAt < ONE_MOVE_RULE_UNTIL
      ? [
          `game ${candidate.gameId} was played before ${ONE_MOVE_RULE_UNTIL}, under the one-move draw rule, and its item has no stored result: drop the item and pick the game from a report that carries the result`,
        ]
      : [];
  }
  if (r.winner !== 1 && r.winner !== 2) {
    return [
      `game ${candidate.gameId} has no winner (${r.reason}): a game with no winner makes no video`,
    ];
  }
  if (script === null) return [];
  const named = scriptWinner(script, candidate);
  if ("problem" in named) return [named.problem];
  const colours = seatColors(candidate);
  if (named.player !== r.winner) {
    return [
      `the script says ${colours[named.player]} (player ${named.player}) wins, but the stored result says ${colours[r.winner]} (player ${r.winner}) wins by ${r.reason}: the script's story is not the game's`,
    ];
  }
  return [];
};

/**
 * The game's facts with 0-based plies, as the edit list names them: each
 * close call, escape and wall jump, the cells after the ply, and the walls
 * that caused the jump (marked *).
 */
export const directorLines = (candidate) => {
  const walls = (ws) =>
    (ws ?? []).map((w) => `${w.notation}${w.cause ? "*" : ""}`).join(" ");
  return [
    ...candidate.beats.map(
      (b) =>
        `director, close call: danger ply ${b.danger.ply} (${b.hunter.type} ${b.danger.hunterCell}, ${b.prey.type} ${b.danger.preyCell}); ` +
        `save ply ${b.save.ply} walls ${walls(b.save.walls)} (walk ${b.save.walkBefore} to ${b.save.walk}; ${b.prey.type} ${b.save.preyCell} safe from this ply)`,
    ),
    ...candidate.escapes.map(
      (e) =>
        `director, escape ply ${e.ply} (${e.prey.type} ${e.preyFrom} -> ${e.preyCell}, walk ${e.walkBefore} to ${e.walk}; ${e.hunter.type} at ${e.hunterCell})`,
    ),
    ...candidate.picks.map(
      (p) =>
        `director, wall jump: ply ${p.ply} ${p.notation}, walls ${walls(p.walls)}`,
    ),
  ];
};

const words = (text) => text.trim().split(/\s+/).length;
const quoted = (text) => `"${text}" (${words(text)} words)`;

/** The texts a viewer reads: overlay lines, trap and stamp words. */
const eventText = (e) =>
  e.kind === "overlay" || e.kind === "trap" || e.kind === "stamp"
    ? (e.text ?? null)
    : null;

/** An event as the BEATS table names it: its kind and what it shows. */
const eventLabel = (e) => {
  const what =
    e.kind === "overlay"
      ? `${e.asset}${e.seat ? ` (${e.seat})` : ""}`
      : e.kind === "react"
        ? `react ${e.emoji}`
        : e.kind;
  const where = e.cell ? ` on ${e.cell}` : "";
  return `${what}${where}${e.sound ? ` + ${e.sound}` : ""}`;
};

/**
 * SCRIPT.md's checklist, one "[ ] ..." line an item: the items of its
 * "## Checklist" section, each item's wrapped lines joined.
 * @param {string} markdown  SCRIPT.md
 * @returns {string[]}
 */
export const scriptChecklist = (markdown) => {
  const section = markdown
    .split(/^## /m)
    .find((s) => s.startsWith("Checklist"));
  if (!section) throw new Error("SCRIPT.md has no ## Checklist section");
  const items = [];
  for (const line of section.split("\n").slice(1)) {
    if (/^- \[ \] /.test(line)) items.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && items.length > 0) {
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  if (items.length === 0) throw new Error("SCRIPT.md's checklist is empty");
  return items;
};

/**
 * The script file's draft: the header, the texts, the game's facts and a
 * BEATS row for each ply with an event or a fact, then the pace and the
 * checklist. `timeline` (RESULT.timeline's shape, from the lint) gives each
 * ply's second; without it the times are "~?". A row's label is its explain
 * event's (edl.mjs, the Game Semantics Worker's move label), else
 * "<label>". `checklist` is SCRIPT.md's (scriptChecklist), so the draft
 * never keeps a second copy. The director completes every "<...>" and "?"
 * before the review.
 * @param {{ item: object, edl: object | null, timeline: { moves: { ply: number, at: number }[], events?: object[], sounds?: object[] } | null, timesNote: string, checklist: string[] }} o
 * @returns {string}
 */
export const scriptDraft = ({ item, edl, timeline, timesNote, checklist }) => {
  const c = item.candidate;
  const colors = seatColors(c);
  const seat = (p) => c.seats.find((s) => s.playerOrder === p);
  const colorOf = (p) => colors[p];
  const last = c.movesCount - 1;
  const winner = raceWinner(c.distances);
  // distances[k] is after k plies: [0] is the start, [p + 1] after ply p.
  const steps = (k) => {
    const d = c.distances?.[k];
    if (!d) return "?";
    const by = (color) =>
      d[Number(Object.keys(colors).find((p) => colors[p] === color))];
    return `red ${by("red")}, blue ${by("blue")}`;
  };
  const at = new Map((timeline?.moves ?? []).map((m) => [m.ply, m.at]));
  const time = (ply) => (at.has(ply) ? `~${at.get(ply).toFixed(1)}` : "~?");

  const events = edl?.events ?? [];
  const bar = events.find((e) => e.kind === "overlay" && e.form === "bar");
  const factsAt = new Map();
  const addFact = (ply, text) =>
    factsAt.set(ply, [...(factsAt.get(ply) ?? []), text]);
  for (const b of c.beats) {
    addFact(
      b.danger.ply,
      `danger: ${b.hunter.type} ${b.danger.walk} from the ${b.prey.type}`,
    );
    addFact(b.save.ply, `save: walk ${b.save.walkBefore} -> ${b.save.walk}`);
  }
  for (const e of c.escapes) {
    addFact(e.ply, `escape: walk ${e.walkBefore} -> ${e.walk}`);
  }
  for (const p of c.picks) {
    addFact(
      p.ply,
      `wall jump ${p.notation}: ${p.opponentBefore} -> ${p.opponentAfter}`,
    );
  }
  const plies = [
    ...new Set([...events.map((e) => e.ply), ...factsAt.keys()]),
  ].sort((a, b) => a - b);

  return [
    `SCRIPT ${item.id} | game ${c.gameId} | ${c.movesCount} plies (0-${last})`,
    `Players: ${c.seats.map((s) => `${s.name} (${s.kind}) ${colorOf(s.playerOrder).toUpperCase()}`).join(", ")}.`,
    winner
      ? `Winner: ${seat(winner).name} (${colorOf(winner)}), by capture at ply ${last}.`
      : "Winner: <no catch in the record: how did the game end (home, resign, time)? check the storyboard>",
    `Start: steps to catch ${steps(0)}. End: ${steps(c.movesCount)}.`,
    "",
    "STORY: <the shape, for example danger -> save -> relief -> caught>",
    "HOOK: <the game's twist, in the caption from 0 s>",
    "",
    "TEXTS",
    `- caption (0 s): ${edl?.caption ? quoted(edl.caption) : "<caption>"}. True: <the fact it rests on>`,
    `- payoff (from ply ${edl?.payoff?.ply ?? "?"}): ${edl?.payoff ? quoted(edl.payoff.text) : "<payoff>"}. True: <...>`,
    `- ending bar (ply ${last}): ${bar ? quoted(bar.text) : "<ending line>"}. Pays off: <the hook>`,
    "",
    "FACTS (the game record; plies 0-based)",
    ...c.facts.map((f) => `- ${f}`),
    ...directorLines(c).map((l) => `- ${l}`),
    "",
    `BEATS (ply | label | ~t s | what the viewer sees | effect + sound | on-screen text | speaker | fact). Times: ${timesNote}`,
    ...plies.map((ply) => {
      const here = events.filter((e) => e.ply === ply);
      const text = here.map(eventText).filter(Boolean);
      const payoff =
        edl?.payoff?.ply === ply ? [`payoff "${edl.payoff.text}"`] : [];
      const label = here.find((e) => e.kind === "explain")?.label;
      return [
        ply,
        label ?? "<label>",
        time(ply),
        "<sees>",
        here.length ? here.map(eventLabel).join("; ") : "-",
        [...text.map((t) => `"${t}"`), ...payoff].join("; ") || "-",
        "<speaker>",
        [`steps ${steps(ply + 1)}`, ...(factsAt.get(ply) ?? [])].join("; "),
      ].join(" | ");
    }),
    "",
    "PACE (from the list; say why each fast ply has no fact):",
    ...(edl?.pace ?? []).map(
      (p) =>
        `- plies ${p.fromPly}-${p.toPly}: ${p.secondsPerMove} s a move${p.fastForward ? ", fast-forward" : ""}`,
    ),
    "",
    "CHECKLIST (SCRIPT.md; tick each before the review)",
    ...checklist,
  ].join("\n");
};

/**
 * The other videos of the batch (SCRIPT-REVIEW.md, BATCH): for each item
 * in draft or finished, other than `selfId`, with a list: its caption,
 * payoff, cut-out and toast lines, trap and stamp words, ending line and
 * sounds (its stored, validated list).
 * @returns {string[]}
 */
export const batchLines = (items, selfId) => {
  const lines = items
    .filter(
      (it) =>
        it.id !== selfId &&
        ["draft", "finished"].includes(it.state) &&
        it.edl?.doc,
    )
    .map((it) => {
      const edl = it.edl.doc;
      const of = (pred) => edl.events.filter(pred).map((e) => `"${e.text}"`);
      const clips = edl.events
        .filter((e) => e.kind === "overlay" && e.form === "clip")
        .map((e) => `${e.asset}${e.text ? ` "${e.text}"` : ""}`);
      const bar = edl.events.find(
        (e) => e.kind === "overlay" && e.form === "bar",
      );
      return [
        `- ${it.id} (game ${it.gameId}, ${it.state})`,
        `caption "${edl.caption ?? ""}"`,
        edl.payoff ? `payoff "${edl.payoff.text}"` : null,
        clips.length ? `cut-outs and toasts: ${clips.join(", ")}` : null,
        of((e) => e.kind === "trap").length
          ? `trap words: ${of((e) => e.kind === "trap").join(", ")}`
          : null,
        of((e) => e.kind === "stamp").length
          ? `stamp words: ${of((e) => e.kind === "stamp").join(", ")}`
          : null,
        `ending "${bar?.text ?? ""}"`,
        `sounds: ${edlSoundUses(edl)
          .map(([, key]) => key)
          .join(", ")}`,
      ]
        .filter(Boolean)
        .join("; ");
    });
  return lines.length ? lines : ["- (no other video in draft or review)"];
};
