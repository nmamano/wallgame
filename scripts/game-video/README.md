# Game video scripts

The scripts here make the Wall Game videos: the renderer, the daily app
(`daily/`), the crew tool (`daily/crew.mjs`) and their tests.

## Runtimes

- **Node 22.18.0 or later** (or 24.2.0 or later). The scripts check
  `import.meta.main` to know that they were run and not imported, and Node
  added it in 22.18 and 24.2. On an older Node it is undefined: before
  2026-11-04 a script then exited 0 and did nothing. Now `isMain` in
  `is-main.mjs` stops it with the reason. Measured on 2026-11-04: on Node
  22.17.0 and 18.19.0, 10 tests here fail; on 22.18.0 all pass.
  `.github/workflows/ci.yml` pins Node to this floor, so CI proves it.
- **Bun**, the version that `.github/workflows/ci.yml` names, for the tests
  and for the scripts that run with `bun`.
- **ffmpeg** on PATH. `app/server.test.ts` needs it; some other tests skip
  without it.

## Tests

`bun test --parallel=4 scripts/game-video` runs them all, about 70 s on
auntie-2 (2026-11-04; `daily/daily.test.ts` alone takes most of it).
`.husky/pre-push` runs them when a push changes this folder or the code it
imports from outside it (the list is in the hook); CI runs them on every push to main. A test here must not read a
file that git does not track: use a tracked fixture (`daily/fixtures/`,
`semantics/fixtures/`) or a temp dir.

A test makes its temp dirs with `test-tmp.ts` (one root per test file,
removed after the file's tests; `TEST_TMP.root` is the TMPDIR for a child
process with its own env), and stops every app it makes. Never
`mkdtempSync(join(tmpdir(), ...))` in a test: those dirs stayed in /tmp
(189,061 entries on auntie-2, 2026-11-07). `bash check-test-tmp.sh` runs the
tests with a fresh TMPDIR and fails if they leave anything in it.
