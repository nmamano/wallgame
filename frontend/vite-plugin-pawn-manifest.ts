import { readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Gives the app the pawn art FILENAMES without importing the art.
 *
 * The three lists used to come from `import.meta.glob("../../public/pawns/<type>/*.svg")`,
 * and only ever had `Object.keys()` called on them - the loader functions were
 * thrown away. Rollup still saw 385 dynamic imports, so every production build
 * shipped a code-split chunk AND a hashed copy of every SVG that no code path
 * could reach: 708 files and ~9.4 MB, on top of the verbatim copies Vite already
 * writes to `dist/pawns/` because the art lives in `public/`.
 *
 * The art is fetched by URL (`/pawns/cat/cat1.svg`, built in `lib/pawn-style.ts`
 * and `components/pawn-selector.tsx`), so names are all the app ever needed.
 */

const VIRTUAL_ID = "virtual:pawn-manifest";
// A leading NUL is Rollup's convention for "this id is mine, do not touch it".
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export const PAWN_TYPES = ["cat", "mouse", "home"] as const;

export const pawnManifestPlugin = (publicDir: string): Plugin => {
  const dirFor = (type: string) => path.join(publicDir, "pawns", type);
  const read = (type: string) =>
    readdirSync(dirFor(type)).filter((name) => name.endsWith(".svg"));

  return {
    name: "wallgame:pawn-manifest",

    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),

    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const manifest = Object.fromEntries(
        PAWN_TYPES.map((type) => [type, read(type)]),
      );
      return `export default ${JSON.stringify(manifest)};`;
    },

    // Dropping a new SVG into public/pawns used to appear in the dev server
    // without a restart, because Vite invalidates a glob's importers on
    // add/unlink. Nothing about this change should cost that.
    configureServer(server) {
      const watched = PAWN_TYPES.map(dirFor);
      server.watcher.add(watched);

      const invalidate = (file: string) => {
        if (!file.endsWith(".svg")) return;
        if (!watched.some((dir) => file.startsWith(dir))) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (!mod) return;
        server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };

      server.watcher.on("add", invalidate);
      server.watcher.on("unlink", invalidate);
    },
  };
};
