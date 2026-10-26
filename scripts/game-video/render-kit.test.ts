import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, renderKitFiles } from "./render-kit.mjs";

describe("the render kit", () => {
  const files = renderKitFiles();

  test("holds every module the renderer imports, through the graph", () => {
    expect(files).toContain("scripts/game-video/render-game-video.mjs");
    expect(files).toContain("scripts/game-video/stamp-spot.mjs");
    expect(files).toContain("shared/domain/variant-rules.ts");
    for (const f of files) expect(existsSync(join(REPO, f))).toBe(true);
  });

  test("needs no package the kit does not install", () => {
    // sync-render-kit.sh installs playwright-core and nothing else.
    const bare =
      /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^./"'][^"']*)["']/gm;
    const packages = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(join(REPO, f), "utf8").matchAll(bare)) {
        if (!m[1].startsWith("node:")) packages.add(m[1]);
      }
    }
    expect([...packages]).toEqual(["playwright-core"]);
  });

  test("is what sync-render-kit.sh copies", () => {
    const sync = readFileSync(
      join(REPO, "scripts/game-video/sync-render-kit.sh"),
      "utf8",
    );
    expect(sync).toContain("bun scripts/game-video/render-kit.mjs");
    expect(sync).toContain('"${code_files[@]}"');
  });

  test("follows re-exports and dynamic imports, and refuses a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-kit-"));
    writeFileSync(join(dir, "a.mjs"), 'export { x } from "./b.mjs";\n');
    writeFileSync(join(dir, "b.mjs"), 'const c = await import("./c");\n');
    writeFileSync(join(dir, "c.ts"), "export const c = 1;\n");
    expect(renderKitFiles(["a.mjs"], dir)).toEqual(["a.mjs", "b.mjs", "c.ts"]);
    writeFileSync(join(dir, "d.mjs"), 'import "./gone.mjs";\n');
    expect(() => renderKitFiles(["d.mjs"], dir)).toThrow(/gone\.mjs/);
  });
});
