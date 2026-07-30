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

describe("the tracked production bot config", () => {
  it("parses and covers every bot with an engine command", () => {
    const config = parsedProd();
    expect(() => assertEngineCommandsCoverBots(config)).not.toThrow();
    expect(config.bots.length).toBe(3);
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

  it("keeps Easy Bot non-official and off the puzzle variants", () => {
    // Non-official is what excludes it from custom-setup games and from
    // serving evaluations; not advertising those variants is the second,
    // independent reason it cannot end up as the puzzle oracle.
    const easy = parsedProd().bots.find((b) => b.botId === "dw-easy");
    expect(easy).toBeDefined();
    expect(easy!.name).toBe("Easy Bot");
    expect(easy!.official).toBe(false);
    const variants = Object.keys(easy!.variants);
    expect(variants).not.toContain("custom-setup-standard");
    expect(variants).not.toContain("custom-setup-classic");
  });

  it("pins Easy Bot's EXACT search settings, not just that they are lower", () => {
    // A single sample is what Nil asked for: no tree search, just the policy
    // head's own preferred move. It only became a valid configuration with the
    // prior fallback in `MCTS::peek_best_move` (board task 945fe1ef) — before
    // that the engine answered "No legal move available" below roughly 100
    // samples, which is why this used to pin 128.
    //
    // `--root_noise_factor 0` is pinned as part of the SAME setting, not as an
    // extra. The engine mixes 25% Dirichlet noise into the root priors by
    // default, so at one sample the move would be drawn from a policy that is a
    // quarter noise: neither policy-only nor searching. Removing this flag alone
    // would leave a bot that looks configured and is not.
    const config = parsedProd();
    const easy = config.engineCommands["dw-easy"];
    expect(easy).toMatch(/--samples 1(\s|$)/);
    expect(easy).toMatch(/--parallel_samples 32(\s|$)/);
    expect(easy).toMatch(/--thread_pool_size 4(\s|$)/);
    expect(easy).toMatch(/--root_noise_factor 0(\s|$)/);

    // Same binary and model as the strong bot: "just like Superhuman with less
    // search" is the whole specification, so a diverging model would make Easy
    // Bot a different bot rather than a weaker one.
    const pathsOf = (command: string) =>
      command.match(/\S*deep_ww_bgs_engine|\S*models_serving\/\S+/g) ?? [];
    expect(pathsOf(easy)).toEqual(
      pathsOf(config.engineCommands["dw-transformer"]),
    );
    expect(pathsOf(easy).length).toBe(2);
  });

  it("gives PuzzleBot the deepest search and Easy Bot the shallowest", () => {
    // Not a claim about strength, just that the three engine commands are not
    // accidentally identical — the whole point of separate processes.
    const config = parsedProd();
    const samples = (botId: string) =>
      Number(/--samples (\d+)/.exec(config.engineCommands[botId])?.[1]);
    expect(samples("dw-easy")).toBeLessThan(samples("dw-transformer"));
    expect(samples("dw-transformer")).toBeLessThan(samples("dw-puzzle"));
  });
});
