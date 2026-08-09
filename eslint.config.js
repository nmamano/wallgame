import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import react from "eslint-plugin-react";

import { fileURLToPath } from "node:url";

// Run this through `bun run lint` / `bun run lint:check`, not a bare
// `eslint .`. Type-aware rules build one TypeScript program per project named
// below, and there are now seven of them; measured 2026-08-09, a whole-repo run
// peaks above 3GB and dies with "heap out of memory" on any machine whose
// default V8 old-space is smaller (this box's was 2240MB on that date). Those
// two scripts set the limit explicitly so the gate does not silently depend on
// how much RAM the host happens to have.

export default tseslint.config(
  // Global ignores (apply to whole repo)
  {
    ignores: [
      "dist",
      "node_modules",
      "ignore",
      "frontend/src/components/unused-components/**",
      "frontend/src/components/ui/**",
      "**/.tanstack/tmp/**",
      // Bun/tool caches. These are gitignored, but eslint's flat config does
      // not read .gitignore, so without this it lints thousands of cached files.
      "**/.cache/**",
      "server/db/schema/**",
      // Dummy engine is standalone (downloaded separately via sparse checkout).
      // NOT covered by any gate: it has its own tsconfig, but nothing invokes
      // it, so dummy-engine/ is neither linted nor type-checked. Measured
      // 2026-08-09: 0 tsc and 1 eslint error, so wiring it in is cheap whenever
      // someone wants to - it was simply left out of the change that covered
      // scripts/ and official-custom-bot-client/.
      "dummy-engine/**",
    ],
  },

  // FRONTEND: React + type-checked TS
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    files: ["frontend/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: ["./tsconfig.node.json", "./tsconfig.app.json"],
        tsconfigRootDir: fileURLToPath(new URL("./frontend", import.meta.url)),
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      react: react,
    },
    settings: {
      react: { version: "19.0" },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...react.configs["jsx-runtime"].rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Disable React Compiler memoization warnings as they are optimization hints, not errors
      "react-hooks/preserve-manual-memoization": "off",
      // Allow setState in useEffect for legitimate external state synchronization
      "react-hooks/set-state-in-effect": "off",
    },
  },

  // FRONTEND BUN TESTS: same rules, but the dedicated test tsconfig (the
  // app project excludes *.test.ts because bun:test types are not part of
  // the vite build).
  {
    files: ["frontend/**/*.test.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: fileURLToPath(new URL("./frontend", import.meta.url)),
      },
    },
  },

  // SERVER + SHARED + TESTS: Type-checked TS
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    files: ["server/**/*.ts", "shared/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
      parserOptions: {
        // Both, because tests/ left tsconfig.server.json for its own project.
        // A file that belongs to NEITHER project silently loses every typed
        // rule, so these must list the same ground `bun run typecheck` covers.
        project: ["./tsconfig.server.json", "./tsconfig.tests.json"],
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
    rules: {},
  },

  // SCRIPTS: Type-checked TS
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    files: ["scripts/**/*.{ts,mts}"],
    languageOptions: {
      // "latest", not 2020: several harnesses use top-level await, which the
      // 2020 parser rejects outright as a syntax error.
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
      parserOptions: {
        // Both, because browser-harness/ left tsconfig.scripts.json for its own
        // project. A file that belongs to NEITHER project silently loses every
        // typed rule, so these must list the same ground `bun run typecheck`
        // covers.
        project: ["./tsconfig.scripts.json", "./tsconfig.harness.json"],
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
    rules: {},
  },

  // SCRIPTS, the plain-JS harnesses: syntax and unused bindings only.
  //
  // No type-aware rules, because there are no types to be aware of - these are
  // .mjs on purpose. Browser globals are in scope alongside node's because the
  // page.evaluate() callbacks in these files run in the browser.
  {
    extends: [js.configs.recommended],
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {},
  },

  // BOT CLIENT: Type-checked TS, against the subproject's OWN tsconfig.
  //
  // official-custom-bot-client/ is published by sparse checkout - a consumer
  // clones only that directory plus /shared/, so the repo root's tsconfig and
  // this file are absent downstream. That constrains the subproject's tsconfig
  // to stay self-contained (it must not `extends` a root file), and it does.
  // It does NOT stop the monorepo from pointing its own gates at that config
  // from the outside, which costs the downstream consumer nothing and is what
  // this block and `bun run typecheck` both do.
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    files: ["official-custom-bot-client/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: fileURLToPath(
          new URL("./official-custom-bot-client", import.meta.url),
        ),
      },
    },
    rules: {},
  },
);
