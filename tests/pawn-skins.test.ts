import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readPawnFiles } from "../scripts/generate-pawn-files";
import { PAWN_FILES } from "../shared/domain/pawn-files.generated";
import {
  DEFAULT_PAWN_STYLES,
  builtInPawnPath,
  isBuiltInPawnStyle,
  type PawnStyleType,
} from "../shared/domain/pawn-styles";
import { appearanceSchema, joinGameSchema } from "../shared/contracts/games";
import { botAppearanceSchema } from "../shared/contracts/custom-bot-config-schema";
import { updatePawnSchema } from "../shared/contracts/settings";
import { configFileSchema } from "../official-custom-bot-client/src/config-schema";
import {
  CAT_PAWNS,
  DOG_PAWNS,
  ELEPHANT_PAWNS,
  HOME_PAWNS,
  MOUSE_PAWNS,
} from "../frontend/src/lib/pawns";
import {
  normalizePawnStyleSelection,
  resolvePawnStyleSrc,
} from "../frontend/src/lib/pawn-style";

// assetUrl reads import.meta.env.BASE_URL when it is called. Vite sets it;
// under Bun it is process.env. The site runs at the root.
process.env.BASE_URL = "/";

/**
 * A pawn skin is chosen by a player or a bot and drawn by every viewer, so it
 * must name one of the site's own pawn files (board task 6a245eee). Two
 * layers hold that: the contracts refuse any other value, and the viewer's
 * resolver draws the default for one that a game stored before the check.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const PAWN_TYPES = [
  "dog",
  "cat",
  "mouse",
  "elephant",
  "home",
] as const satisfies readonly PawnStyleType[];

/** Values a player could send that must never reach a viewer's <img>. */
const HOSTILE = [
  "/api/logout",
  "api/logout",
  "https://attacker.example/p.svg",
  "http://attacker.example/pawns/cat/cat3.svg",
  "//attacker.example/pawns/cat/cat3.svg",
  "data:image/svg+xml;base64,PHN2Zy8+",
  "javascript:alert(1)",
  "../../api/logout",
  "/pawns/cat/../../api/logout",
  "/pawns/cat/cat3.svg?x=1",
  "/pawns-x/cat/cat3.svg",
  "/pawn-backings/cat/cat3.png",
  "cat3.svg/",
  "cat999.svg",
  "constructor",
  "__proto__",
];

/** The skins the site's own pickers offer, per type. */
const UI_CHOICES: Record<PawnStyleType, readonly string[]> = {
  dog: DOG_PAWNS,
  cat: CAT_PAWNS,
  mouse: MOUSE_PAWNS,
  elephant: ELEPHANT_PAWNS,
  home: HOME_PAWNS,
};

describe("the generated pawn file list", () => {
  test("matches frontend/public/pawns (run `bun run pawns:files` if not)", () => {
    expect(PAWN_FILES as Record<string, readonly string[]>).toEqual(
      readPawnFiles(),
    );
  });
});

describe("isBuiltInPawnStyle", () => {
  test("accepts a pawn by name, bare name, and path", () => {
    expect(builtInPawnPath("cat3.svg", "cat")).toBe("/pawns/cat/cat3.svg");
    expect(builtInPawnPath("cat3", "cat")).toBe("/pawns/cat/cat3.svg");
    expect(builtInPawnPath("/pawns/cat/cat3.svg", "cat")).toBe(
      "/pawns/cat/cat3.svg",
    );
    expect(builtInPawnPath("pawns/animal-cycle/dog.svg", "dog")).toBe(
      "/pawns/animal-cycle/dog.svg",
    );
    expect(isBuiltInPawnStyle("default", "home")).toBe(true);
  });

  test("refuses a name from another type's folder", () => {
    expect(isBuiltInPawnStyle("cat3.svg", "mouse")).toBe(false);
    expect(isBuiltInPawnStyle("home2.svg", "cat")).toBe(false);
  });

  test("refuses URLs, other site paths and files that do not exist", () => {
    for (const type of PAWN_TYPES) {
      expect(HOSTILE.filter((v) => isBuiltInPawnStyle(v, type))).toEqual([]);
    }
    expect(isBuiltInPawnStyle("", "cat")).toBe(false);
  });

  test("accepts every skin the pickers offer and every default", () => {
    for (const type of PAWN_TYPES) {
      expect(UI_CHOICES[type].length).toBeGreaterThan(0);
      expect(
        UI_CHOICES[type].filter((v) => !isBuiltInPawnStyle(v, type)),
      ).toEqual([]);
      expect(isBuiltInPawnStyle(DEFAULT_PAWN_STYLES[type], type)).toBe(true);
    }
  });
});

describe("input: the contracts accept only built-in skins", () => {
  const skinKey = (type: PawnStyleType) => `${type}Skin`;

  test("create and join appearance refuse a hostile skin with a clear error", () => {
    for (const type of PAWN_TYPES) {
      for (const skin of HOSTILE) {
        const parsed = joinGameSchema.safeParse({
          appearance: { [skinKey(type)]: skin },
        });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.path).toEqual([
          "appearance",
          skinKey(type),
        ]);
        expect(parsed.error?.issues[0]?.message).toBe(
          `must be "default" or the name of one of the site's ${type} pawns`,
        );
        expect(
          appearanceSchema.safeParse({ [skinKey(type)]: skin }).success,
        ).toBe(false);
      }
    }
  });

  test("create and join appearance accept every picker skin and trim it", () => {
    for (const type of PAWN_TYPES) {
      for (const skin of ["default", ...UI_CHOICES[type]]) {
        expect(
          appearanceSchema.parse({ [skinKey(type)]: ` ${skin} ` }),
        ).toEqual({ [skinKey(type)]: skin });
      }
    }
  });

  test("bot styles refuse a hostile or overlong value", () => {
    expect(
      botAppearanceSchema.safeParse({ catStyle: "/api/logout" }).success,
    ).toBe(false);
    expect(
      botAppearanceSchema.safeParse({ homeStyle: "https://x.example/h.svg" })
        .success,
    ).toBe(false);
    expect(
      botAppearanceSchema.safeParse({ catStyle: `${"c".repeat(61)}.svg` })
        .success,
    ).toBe(false);
    expect(
      botAppearanceSchema.safeParse({ color: "r".repeat(33) }).success,
    ).toBe(false);
  });

  test("the official and test bot configs still parse", () => {
    const configs = [
      "official-custom-bot-client/transformer.prod.config.json",
      "official-custom-bot-client/test-dumb-bot.config.json",
      "official-custom-bot-client/test-dummy-engine.config.json",
      "minimax-engine/deploy/minimax.prod.config.json",
    ];
    for (const file of configs) {
      const parsed = configFileSchema.safeParse(
        JSON.parse(readFileSync(path.join(ROOT, file), "utf8")),
      );
      expect({ file, issues: parsed.error?.issues ?? [] }).toEqual({
        file,
        issues: [],
      });
    }
  });

  test("an account's pawn setting must be a skin of its own type", () => {
    expect(
      updatePawnSchema.safeParse({ pawnType: "cat", pawnShape: "cat3.svg" })
        .success,
    ).toBe(true);
    expect(
      updatePawnSchema.safeParse({ pawnType: "cat", pawnShape: "default" })
        .success,
    ).toBe(true);
    const refused = updatePawnSchema.safeParse({
      pawnType: "mouse",
      pawnShape: "https://attacker.example/m.svg",
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["pawnShape"]);
  });
});

describe("read path: a stored skin that is not built in draws the default", () => {
  test("a hostile stored skin resolves to the type's default file", () => {
    for (const type of PAWN_TYPES) {
      const fallback = `/pawns/${type}/${DEFAULT_PAWN_STYLES[type]}`;
      for (const skin of HOSTILE) {
        expect(resolvePawnStyleSrc(skin, type)).toBe(fallback);
        expect(normalizePawnStyleSelection(skin, type)).toBe("default");
      }
      expect(resolvePawnStyleSrc(undefined, type)).toBe(fallback);
    }
  });

  test("a built-in skin resolves to its own file", () => {
    expect(resolvePawnStyleSrc("cat3", "cat")).toBe("/pawns/cat/cat3.svg");
    expect(resolvePawnStyleSrc(" mouse20.svg ", "mouse")).toBe(
      "/pawns/mouse/mouse20.svg",
    );
    expect(resolvePawnStyleSrc("/pawns/home/home8.svg", "home")).toBe(
      "/pawns/home/home8.svg",
    );
    expect(resolvePawnStyleSrc("pawns/animal-cycle/cat.svg", "cat")).toBe(
      "/pawns/animal-cycle/cat.svg",
    );
    for (const type of PAWN_TYPES) {
      for (const skin of UI_CHOICES[type]) {
        expect(resolvePawnStyleSrc(skin, type)).toBe(`/pawns/${type}/${skin}`);
      }
    }
  });
});
