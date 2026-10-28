/**
 * The one-time rewrites of a day file at start-up: version 1 (one game a
 * day) as version 2 (candidates), and version 2 as version 3 (music cue
 * lists), on copies of the real 2026-10-26 and 2026-10-27 files (the
 * Director's condition, 2026-10-27). Only the data dir in their paths is
 * changed, to /data, because the repo is public. The live version 2 files
 * were made from them by migrateV1.
 */
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copySha256 } from "./copy.mjs";
import { migrateV1, migrateV2, openStore, VERSION } from "./store.mjs";

const FIXTURES = join(import.meta.dir, "fixtures");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, Json>;

/** Every leaf of `value` as [path, value], with paths like a.b.0.c. */
const leaves = (value: Json, path: string[] = []): [string[], Json][] =>
  value !== null && typeof value === "object"
    ? Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]))
    : [[path, value]];

const at = (value: Json, path: string[]): Json | undefined =>
  path.reduce<Json | undefined>(
    (v, k) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? v[k]
        : Array.isArray(v)
          ? v[Number(k)]
          : undefined,
    value,
  );

/**
 * Where version 2 keeps a version 1 field. The approval's video and block
 * move into its offer of A (and stay on the approval when A was approved);
 * its decision is renamed; the rest keeps its name.
 */
const newPath = (v1: Obj, path: string[]): string[][] => {
  const [top, ...rest] = path;
  const A = ["cands", "A"];
  const approval = (base: string[], a: Obj, field: string, more: string[]) => {
    const approved = a.decision === "approve";
    if (field === "videoSha256")
      return [
        [...base, "offered", "A", "videoSha256"],
        ...(approved ? [[...base, "videoSha256"]] : []),
      ];
    if (field === "copy")
      return [
        [...base, "offered", "A", "copy", ...more],
        ...(approved ? [[...base, "copy", ...more]] : []),
      ];
    if (field === "decision") return [];
    return [[...base, field, ...more]];
  };
  switch (top) {
    case "state":
      return [];
    case "candidate":
    case "style":
    case "styleVersion":
    case "edl":
    case "render":
    case "check":
    case "copy":
    case "caption":
    case "replaced":
      return [[...A, top, ...rest]];
    case "approval":
      return approval(["approval"], v1.approval as Obj, rest[0], rest.slice(1));
    case "earlierAsks": {
      const [i, field, ...more] = rest;
      return approval(
        ["earlierAsks", i],
        (v1.earlierAsks as Obj[])[Number(i)],
        field,
        more,
      );
    }
    default:
      return [path];
  }
};

describe("a version 1 day file becomes candidate A", () => {
  for (const day of ["2026-10-26", "2026-10-27"]) {
    test(`${day}: every field reads the same, and the old file is kept`, () => {
      const dir = mkdtempSync(join(tmpdir(), "daily-migrate-test-"));
      const cycles = join(dir, "daily", "cycles");
      mkdirSync(cycles, { recursive: true });
      const source = join(FIXTURES, `v1-${day}.json`);
      copyFileSync(source, join(cycles, `${day}.json`));
      const v1 = JSON.parse(readFileSync(source, "utf8")) as Obj;

      const store = openStore(dir);
      const v2 = migrateV1(v1) as Obj;
      expect(v2.version).toBe(2);
      // At start-up it goes on to the current version; the old bytes are
      // kept next to it, and the store lists the day once.
      expect(store.read(day)).toEqual(migrateV2(v2));
      expect(readFileSync(join(cycles, `${day}.v1.json`), "utf8")).toBe(
        readFileSync(source, "utf8"),
      );
      expect(store.days()).toEqual([day]);

      let checked = 0;
      for (const [path, value] of leaves(v1)) {
        for (const to of newPath(v1, path)) {
          expect([to.join("."), at(v2, to)]).toEqual([to.join("."), value]);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(100);

      // The states: a production state stays on A; from the ask on, the day
      // has it.
      const v1State = v1.state as string;
      const production = [
        "picked",
        "directed",
        "rendering",
        "rendered",
        "render-failed",
        "checked",
      ].includes(v1State);
      expect(v2.state).toBe(production ? "open" : v1State);
      expect(at(v2, ["cands", "A", "state"])).toBe(
        production ? v1State : "checked",
      );

      // The sha bindings: the block is for the render's video, and an
      // approval names A's video and block.
      const a = v1.approval as Obj | null;
      if (v1.copy) {
        expect(at(v2, ["cands", "A", "copyFor"])).toBe(
          at(v1, ["render", "video", "sha256"]) ?? null,
        );
      }
      if (a) {
        expect(at(v2, ["approval", "picked"])).toBe(
          a.decision === "approve" ? "A" : null,
        );
        expect(at(v2, ["approval", "decision"])).toBe(
          a.decision === "approve"
            ? "pick"
            : a.decision === "reject"
              ? "none"
              : null,
        );
        expect(at(v2, ["approval", "offered", "A", "copySha256"])).toBe(
          a.copy ? copySha256(a.copy as never) : null,
        );
      }

      // A second start changes nothing.
      const once = readFileSync(join(cycles, `${day}.json`), "utf8");
      openStore(dir);
      expect(readFileSync(join(cycles, `${day}.json`), "utf8")).toBe(once);
      expect(readdirSync(cycles).sort()).toEqual([
        `${day}.json`,
        `${day}.v1.json`,
      ]);
    });
  }

  test("a field that version 1 never had stops the migration", () => {
    const v1 = JSON.parse(
      readFileSync(join(FIXTURES, "v1-2026-10-27.json"), "utf8"),
    ) as Obj;
    expect(() => migrateV1({ ...v1, surprise: 1 })).toThrow(
      /version 1 has no field surprise; the migration would lose it/,
    );
  });
});

/** A version 2 field that version 3 rewrites: the music and the list's text. */
const CUE_PATHS = [
  ["edl", "doc", "music"],
  ["edl", "text"],
  ["edl", "sha256"],
  ["render", "music"],
];
const rewritten = (path: string[]) =>
  path[0] === "cands" &&
  CUE_PATHS.some((p) => p.every((k, i) => path[i + 2] === k));

describe("a version 2 day file gets music cue lists", () => {
  for (const day of ["2026-10-26", "2026-10-27"]) {
    test(`${day}: the one track becomes one cue, and the rest reads the same`, () => {
      const dir = mkdtempSync(join(tmpdir(), "daily-migrate-test-"));
      const cycles = join(dir, "daily", "cycles");
      mkdirSync(cycles, { recursive: true });
      const v1 = JSON.parse(
        readFileSync(join(FIXTURES, `v1-${day}.json`), "utf8"),
      ) as Obj;
      const v2Text = JSON.stringify(migrateV1(v1), null, 2);
      writeFileSync(join(cycles, `${day}.json`), v2Text);
      const v2 = JSON.parse(v2Text) as Obj;

      const store = openStore(dir);
      const v3 = store.read(day) as Obj;
      expect(v3.version).toBe(VERSION);
      expect(readFileSync(join(cycles, `${day}.v2.json`), "utf8")).toBe(v2Text);

      let checked = 0;
      for (const [path, value] of leaves(v2)) {
        if (path[0] === "version" || rewritten(path)) continue;
        expect([path.join("."), at(v3, path)]).toEqual([path.join("."), value]);
        checked++;
      }
      expect(checked).toBeGreaterThan(100);

      // Both live days played tea-for-two from ply 0.
      const A = ["cands", "A"];
      const cue = [{ fromPly: 0, track: "tea-for-two" }];
      expect(at(v2, [...A, "edl", "doc", "music"])).toBe("tea-for-two");
      expect(at(v3, [...A, "edl", "doc", "music"])).toEqual(cue);
      expect(at(v3, [...A, "render", "music"])).toEqual([{ ...cue[0], at: 0 }]);
      // The text a render sends to the 4090 has the cue, and its sha256
      // follows it; the rest of the list is the same.
      const text = at(v3, [...A, "edl", "text"]) as string;
      expect(JSON.parse(text)).toEqual({
        ...JSON.parse(at(v2, [...A, "edl", "text"]) as string),
        music: cue,
      });
      expect(at(v3, [...A, "edl", "sha256"])).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
      // What the renderer read stays recorded as it was.
      expect(at(v3, [...A, "render", "edlSha256"])).toBe(
        at(v2, [...A, "render", "edlSha256"]) as string,
      );
      // The video and its block are the same bytes, so an approval and a
      // copy block stay good: the approved 2026-10-27 day can still post.
      if (at(v3, [...A, "copyFor"]) !== null) {
        expect(at(v3, [...A, "copyFor"])).toBe(
          at(v3, [...A, "render", "video", "sha256"]) as string,
        );
      }

      // A second start changes nothing.
      const once = readFileSync(join(cycles, `${day}.json`), "utf8");
      openStore(dir);
      expect(readFileSync(join(cycles, `${day}.json`), "utf8")).toBe(once);
      expect(readdirSync(cycles).sort()).toEqual([
        `${day}.json`,
        `${day}.v2.json`,
      ]);
    });
  }

  test("the post log's rows name their tracks as a list", () => {
    const dir = mkdtempSync(join(tmpdir(), "daily-migrate-test-"));
    const root = join(dir, "daily");
    mkdirSync(root, { recursive: true });
    const old = [
      { day: "2026-10-27", platform: "tiktok", music: "tea-for-two" },
      { day: "2026-10-28", platform: "x", music: ["deja-vus", "skippy"] },
    ];
    const oldText = old.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(root, "post-log.jsonl"), oldText);

    const store = openStore(dir);
    const rows = readFileSync(store.postLog.live, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Obj);
    expect(rows).toEqual([{ ...old[0], music: ["tea-for-two"] }, old[1]]);
    expect(readFileSync(join(root, "post-log.v2.jsonl"), "utf8")).toBe(oldText);
    // No dry-run log: nothing is made.
    expect(readdirSync(root).filter((f) => f.startsWith("post-log"))).toEqual([
      "post-log.jsonl",
      "post-log.v2.jsonl",
    ]);
  });
});
