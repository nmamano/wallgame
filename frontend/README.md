# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ["./tsconfig.node.json", "./tsconfig.app.json"],
      tsconfigRootDir: import.meta.dirname,
    },
  },
});
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from "eslint-plugin-react";

export default tseslint.config({
  // Set the react version
  settings: { react: { version: "18.3" } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs["jsx-runtime"].rules,
  },
});
```

## Project created with these commands:

```
~/repos/wallgame (main)$ bun create vite@latest
√ Project name: ... frontend
√ Select a framework: » React
√ Select a variant: » TypeScript

Scaffolding project in C:\Users\Nilo\repos\wallgame\frontend...

Done. Now run:

  cd frontend
  bun install
  bun run dev


~/repos/wallgame (main)$ cd frontend

~/repos/wallgame/frontend (main)$ bun install
bun install v1.2.2 (c1708ea6)

+ @eslint/js@9.20.0
+ @types/react@19.0.8
+ @types/react-dom@19.0.3
+ @vitejs/plugin-react@4.3.4
+ eslint@9.20.1
+ eslint-plugin-react-hooks@5.1.0
+ eslint-plugin-react-refresh@0.4.19
+ globals@15.15.0
+ typescript@5.7.3
+ typescript-eslint@8.24.0
+ vite@6.1.0
+ react@19.0.0
+ react-dom@19.0.0

180 packages installed [14.50s]

~/repos/wallgame/frontend (main)$ bun install tailwindcss @tailwindcss/vite
bun add v1.2.2 (c1708ea6)

installed tailwindcss@4.0.6
installed @tailwindcss/vite@4.0.6

12 packages installed [1431.00ms]

~/repos/wallgame/frontend (main)$ bun run dev
$ vite

  VITE v6.1.0  ready in 267 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help
error: script "dev" exited with code 58


~/repos/wallgame/frontend (main)$ bun run dev
$ vite

  VITE v6.1.0  ready in 263 ms

  ➜  Local:   http://localhost:5173/
bun add v1.2.2 (c1708ea6)

installed @types/node@22.13.4

2 packages installed [563.00ms]

~/repos/wallgame/frontend (main)$ bunx --bun shadcn@canary init
✔ Preflight checks.
✔ Verifying framework. Found Vite.
✔ Validating Tailwind CSS config. Found v4.
✔ Validating import alias.
√ Which color would you like to use as the base color? » Neutral
ts

Success! Project initialization completed.
You may now add components.


~/repos/wallgame/frontend (main)$ bunx --bun shadcn@canary add button
✔ Checking registry.
✔ Updating src\App.css
✔ Installing dependencies.
✔ Created 1 file:
  - src\components\ui\button.tsx
```
