/**
 * Guards on the bot-client CONFIG FILE (S-BOTS, 2026-07-29).
 *
 * The config decides what the production bots claim to be, and one specific
 * mistake is silent: a bot with no entry in `engineCommands` parses cleanly,
 * attaches, advertises itself, and then serves the built-in dummy
 * implementation. `assertEngineCommandsCoverBots` is what turns that into a
 * loud failure before a rollout, so it is pinned here rather than only being
 * demonstrated once by hand.
 *
 * The tracked production config is also asserted directly, so editing it
 * wrongly fails a test instead of failing on Nil's desktop.
 */

import { describe, it, expect } from "bun:test";
import {
  configFileSchema,
  assertAnalysisCoverage,
  assertEngineCommandsCoverBots,
  type ConfigFile,
} from "../../official-custom-bot-client/src/config-schema";
import prodConfig from "../../official-custom-bot-client/transformer.prod.config.json";

const parsedProd = (): ConfigFile => {
  const parsed = configFileSchema.safeParse(prodConfig);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data;
};

describe("engineCommands must cover the bots exactly", () => {
  const base = (): ConfigFile => structuredClone(parsedProd());

  it("accepts the exact-set case", () => {
    expect(() => assertEngineCommandsCoverBots(base())).not.toThrow();
  });

  it("throws when a bot has no engine command", () => {
    const config = base();
    delete config.engineCommands[config.bots[0].botId];
    expect(() => assertEngineCommandsCoverBots(config)).toThrow(
      /bots without a command/,
    );
  });

  it("throws when a command key is a typo (stray command)", () => {
    const config = base();
    const id = config.bots[0].botId;
    config.engineCommands[`${id}-typo`] = config.engineCommands[id];
    delete config.engineCommands[id];
    expect(() => assertEngineCommandsCoverBots(config)).toThrow(
      /commands without a bot/,
    );
  });

  it("throws on a duplicate botId", () => {
    const config = base();
    config.bots.push({ ...config.bots[0] });
    expect(() => assertEngineCommandsCoverBots(config)).toThrow(/duplicate/);
  });
});

describe("the analysis bots must cover the site's own questions", () => {
  const base = (): ConfigFile => structuredClone(parsedProd());

  it("accepts the production config", () => {
    expect(() => assertAnalysisCoverage(base())).not.toThrow();
  });

  it("throws when no bot declares analysis", () => {
    // The failure this exists for is SILENT: `findEvalBot` returns null, which
    // is also what it returns when the bot client is simply offline, so a
    // config with no analysis bot presents as an evaluation bar that is
    // "temporarily" missing and never comes back.
    const config = base();
    for (const bot of config.bots) delete bot.analysis;
    expect(() => assertAnalysisCoverage(config)).toThrow(/no bot declares/);
  });

  it("throws when an analysis bot withholds the official token", () => {
    // The server grants isAnalysisBot only alongside a valid token, so this
    // config would attach cleanly and the declaration would evaporate.
    const config = base();
    const analysisBot = config.bots.find((b) => b.analysis === true)!;
    analysisBot.official = false;
    expect(() => assertAnalysisCoverage(config)).toThrow(/also be official/);
  });

  it("throws when two analysis bots claim the same variant", () => {
    // findEvalBot takes the first match, so this is the config that makes the
    // answer depend on which bot the client happened to register first. The
    // production split - Superhuman Bot on the three ordinary variants,
    // PuzzleBot on the two custom-setup ones - is deliberate, and this is what
    // keeps it deliberate.
    const config = base();
    const weak = config.bots.find((b) => b.analysis !== true)!;
    weak.analysis = true;
    weak.official = true;
    expect(() => assertAnalysisCoverage(config)).toThrow(
      /two analysis bots declare/,
    );
  });
});

describe("the tracked production bot config", () => {
  it("parses and covers every bot with an engine command", () => {
    const config = parsedProd();
    expect(() => assertEngineCommandsCoverBots(config)).not.toThrow();
    expect(config.bots.length).toBe(4);
  });

  it("rejects an unknown key on a bot", () => {
    // The guarantee this suite relies on. Note the boundary: `.strict()` is on
    // the bot and config objects, NOT on the nested `appearance`/`variants`
    // entries, which still accept unknown keys. Tightening those is a change
    // to a schema the SERVER also enforces at attach, so it is deliberately
    // not done here.
    const withExtra = {
      ...prodConfig,
      bots: [
        { ...prodConfig.bots[0], surpriseKey: "x" },
        ...prodConfig.bots.slice(1),
      ],
    };
    expect(configFileSchema.safeParse(withExtra).success).toBe(false);
  });

  it("names the strong bot Superhuman Bot and keeps its bot id stable", () => {
    // The id is identity: ratings, game history and the built_in_bots row all
    // key off it, so a rename must NOT touch it.
    const strong = parsedProd().bots.find((b) => b.botId === "dw-transformer");
    expect(strong?.name).toBe("Superhuman Bot");
    expect(strong?.official).not.toBe(false);
  });

  it("presents the ladder gentlest-first, with the id that carries history unchanged", () => {
    // `dw-easy` is now displayed as NORMAL Bot. The id is deliberately not
    // renamed to match: ratings, past games and the built_in_bots row all key
    // off it, and every game it has already played is attributed to it.
    // `dw-beginner` is the new bottom rung and takes over the name "Easy Bot".
    const bots = parsedProd().bots;
    const byId = (id: string) => bots.find((b) => b.botId === id);

    expect(byId("dw-beginner")?.name).toBe("Easy Bot");
    expect(byId("dw-easy")?.name).toBe("Normal Bot");
    expect(byId("dw-transformer")?.name).toBe("Superhuman Bot");

    // The order players see. This is the whole point of the change: 57% of new
    // players took the first row of the list and it was Superhuman Bot, and
    // they won 1 game in 58 (production, 2026-08-07).
    const ladder = bots
      .filter((b) => b.listOrder !== undefined)
      .sort((a, b) => a.listOrder! - b.listOrder!)
      .map((b) => b.name);
    expect(ladder).toEqual(["Easy Bot", "Normal Bot", "Superhuman Bot"]);
  });

  it("recommends 8x8 and nothing bigger", () => {
    // 62% of our search clicks are mobile, and 12x10 does not fit a phone
    // (Nil, 2026-08-07). The Recommended tab is what a first-time visitor
    // clicks, so it offers one size.
    //
    // A recommendation is not a restriction: every bot still DECLARES the full
    // range and 12x10 stays reachable from the board-size control and the
    // Filtered tab. The two are pinned together on purpose, because quietly
    // narrowing what the bots can play would be a different and much larger
    // change wearing this one's clothes.
    //
    // Not empty, either. `getRecommendedBots` falls back to a bot's declared
    // size only when min equals max on both axes, so a bot with a range and no
    // recommendation vanishes from the tab entirely.
    const oversized: string[] = [];
    const unrecommended: string[] = [];
    const narrowed: string[] = [];

    for (const bot of parsedProd().bots) {
      for (const [variant, config] of Object.entries(bot.variants)) {
        const label = `${bot.botId}/${variant}`;
        if (config!.recommended.length === 0) unrecommended.push(label);
        for (const rec of config!.recommended) {
          if (rec.boardWidth > 8 || rec.boardHeight > 8) {
            oversized.push(`${label} ${rec.boardWidth}x${rec.boardHeight}`);
          }
        }
        // Unchanged: what the bot can be ASKED to play.
        if (config!.boardWidth.max < 12 || config!.boardHeight.max < 10) {
          narrowed.push(
            `${label} ${config!.boardWidth.max}x${config!.boardHeight.max}`,
          );
        }
      }
    }

    // Collected rather than asserted per-entry so a failure names every
    // offender at once instead of the first one.
    expect(oversized).toEqual([]);
    expect(unrecommended).toEqual([]);
    expect(narrowed).toEqual([]);
  });

  it("keeps the two weak bots off the puzzle variants and out of analysis", () => {
    // Two independent reasons neither can end up as the puzzle or evaluation
    // engine: they do not declare `analysis`, and they do not advertise the
    // custom-setup variants puzzles are played on. Official no longer excludes
    // them from anything - that is exactly what the analysis flag is for.
    for (const id of ["dw-beginner", "dw-easy"]) {
      const bot = parsedProd().bots.find((b) => b.botId === id);
      expect(bot).toBeDefined();
      expect(bot!.official).not.toBe(false);
      expect(bot!.analysis).not.toBe(true);
      const variants = Object.keys(bot!.variants);
      expect(variants).not.toContain("custom-setup-standard");
      expect(variants).not.toContain("custom-setup-classic");
    }
  });

  it("pins the weak bots' EXACT search settings, not just that they are lower", () => {
    // A single sample is what Nil asked for: no tree search, just the policy
    // head's own preferred move. It only became a valid configuration with the
    // prior fallback in `MCTS::peek_best_move` (board task 945fe1ef) — before
    // that the engine answered "No legal move available" below roughly 100
    // samples, which is why this used to pin 128.
    //
    // `--root_noise_factor` is pinned as part of the SAME setting, not as an
    // extra: at one sample it IS the move selection, because there is no tree
    // to absorb it and the engine takes the argmax of priors that are (1-f)
    // policy and f Dirichlet. Removing the flag would leave a bot that looks
    // configured and is not.
    //
    // The VALUES are pinned as an ordering, not as constants, with one
    // exception. Measured on the 4090 (2026-08-07, 40 games per point against
    // the simple policy) root noise buys almost no weakness below 0.75 - 100%,
    // 100%, 98.8%, 98.8%, 100% at 0, 0.25, 0.4, 0.55, 0.65 - and then falls off
    // a cliff to 16% at 0.85. So it is carried for VARIETY, not difficulty: at
    // noise 0 a one-sample bot replays the same game every time. The difficulty
    // lives in the naive mix below, which does have a usable gradient.
    const config = parsedProd();
    const noiseOf = (botId: string) =>
      Number(
        /--root_noise_factor (\S+)/.exec(config.engineCommands[botId])![1],
      );

    for (const id of ["dw-beginner", "dw-easy"]) {
      const command = config.engineCommands[id];
      expect(command).toMatch(/--samples 1(\s|$)/);
      expect(command).toMatch(/--parallel_samples 32(\s|$)/);
      expect(command).toMatch(/--thread_pool_size 4(\s|$)/);
      expect(command).toMatch(/--root_noise_factor \S+/);
      // Below the cliff, where the flag adds variety rather than weakness.
      expect(noiseOf(id)).toBeLessThan(0.75);
    }
    expect(noiseOf("dw-beginner")).toBeGreaterThan(noiseOf("dw-easy"));

    // Same binary and model as the strong bot: "just like Superhuman with less
    // search" is the whole specification, so a diverging model would make these
    // different bots rather than weaker ones.
    const pathsOf = (command: string) =>
      command.match(/\S*deep_ww_bgs_engine|\S*models_serving\/\S+/g) ?? [];
    for (const id of ["dw-beginner", "dw-easy"]) {
      expect(pathsOf(config.engineCommands[id])).toEqual(
        pathsOf(config.engineCommands["dw-transformer"]),
      );
      expect(pathsOf(config.engineCommands[id]).length).toBe(2);
    }
  });

  it("mixes naive moves into the two weak bots ONLY, and more into the weaker", () => {
    // The knob that actually sets difficulty: a share of moves come from the
    // client's naive walk-toward-the-goal policy instead of the engine. It is a
    // client-side field — the engine command, the model and the sample count are
    // all untouched — so a stray copy on another bot would quietly hobble a bot
    // nobody asked to weaken.
    //
    // Unlike root noise this has a smooth gradient. Measured against the simple
    // policy on 2026-08-07: 100% at rate 0, 76% at 0.33, 54% at 0.5, 45% at
    // 0.65, 39% at 0.8. And it stays SENSIBLE at every point, because every
    // move it substitutes is a walk toward the goal rather than a random one -
    // which is the property root noise loses exactly where it starts working.
    //
    // Pinned as an ORDERING, not as values. The exact percentages are Nil's to
    // tune by playing them; what must not change silently is which bots mix and
    // that the bottom rung mixes more.
    const config = parsedProd();
    const rateOf = (botId: string) =>
      config.bots.find((b) => b.botId === botId)!.naiveMoveRate ?? 0;

    for (const id of ["dw-beginner", "dw-easy"]) {
      expect(rateOf(id)).toBeGreaterThan(0);
      expect(rateOf(id)).toBeLessThan(1);
    }
    expect(rateOf("dw-beginner")).toBeGreaterThan(rateOf("dw-easy"));
    for (const other of ["dw-transformer", "dw-puzzle"]) {
      expect(rateOf(other)).toBe(0);
    }
  });

  it("pins the losing-move fallback to PuzzleBot ONLY", () => {
    // PuzzleBot is losing by construction in every puzzle, and in a completely
    // lost position every line loses — so the search ranks moves whose outcomes
    // are identical and the winner can look absurd to a human. Below -0.9 it
    // plays a naive walk-toward-the-goal policy instead, and snaps back to full
    // search the moment the human errs and the eval recovers.
    //
    // Scoped to this bot on purpose. The other two must NOT enable it: on 8x8 an
    // even position already evaluates around -0.83, so a bot merely behind in an
    // ordinary game would cross -0.9 and start playing naively for no reason a
    // player could understand.
    //
    // TWO flags, and both are pinned. Enablement is a separate switch because no
    // NUMBER can mean "off": the engine's root value legitimately reaches exactly
    // -1.0 in a position where every line loses, so a threshold of -1 as a
    // "disabled" default would have fired there. The engine also refuses to start
    // with the threshold but not the switch, so a half-configured command cannot
    // look enabled and do nothing.
    const config = parsedProd();
    const puzzle = config.engineCommands["dw-puzzle"];
    expect(puzzle).toMatch(/--losing_fallback(\s|$)/);
    expect(puzzle).toMatch(/--losing_fallback_eval -0\.9(\s|$)/);
    for (const other of ["dw-transformer", "dw-easy", "dw-beginner"]) {
      expect(config.engineCommands[other]).not.toMatch(/--losing_fallback/);
    }
  });

  it("gives PuzzleBot the deepest search and Easy Bot the shallowest", () => {
    // Not a claim about strength, just that the three engine commands are not
    // accidentally identical — the whole point of separate processes.
    const config = parsedProd();
    const samples = (botId: string) =>
      Number(/--samples (\d+)/.exec(config.engineCommands[botId])?.[1]);
    expect(samples("dw-beginner")).toBeLessThan(samples("dw-transformer"));
    expect(samples("dw-easy")).toBeLessThan(samples("dw-transformer"));
    expect(samples("dw-transformer")).toBeLessThan(samples("dw-puzzle"));
  });
});
