import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import react from "eslint-plugin-react";

import { fileURLToPath } from "node:url";

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
      "server/db/schema/**",
      "scripts/**",
      // Bot client is standalone (downloaded separately via sparse checkout)
      // It has its own tsconfig and is type-checked with `bun run typecheck`
      "official-custom-bot-client/**",
      // Dummy engine is standalone (downloaded separately via sparse checkout)
      // It has its own tsconfig and is type-checked with `bun run typecheck`
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
        project: ["./tsconfig.server.json"],
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
    rules: {},
  },
);
