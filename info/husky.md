# Git hooks (husky)

## Activation is automatic

`package.json` has `"prepare": "husky"`, so `bun install` installs the hooks. There is
nothing to run by hand and nothing to remember on a new clone.

That is the whole point of the `prepare` script. Before 2026-08-08 the hooks were
activated by a manual `git config core.hooksPath .husky`, which this file told you to
run - and on the machine where most of the work happens, nobody had. `core.hooksPath` was
unset, the hook files were not executable, and **the hooks had never run there**. A
commit that violated formatting sailed through the local gate and failed CI instead (run
31271384297). A setup step that must be remembered per clone is a setup step that will be
forgotten.

To check that they are live:

```
git config core.hooksPath      # -> .husky/_   (husky 9 puts its shim there)
```

If that prints nothing, run `bun install`.

## What each hook checks

| Hook | Checks | Not checked |
| --- | --- | --- |
| `pre-commit` | Prettier and ESLint, **staged files only** | build, tests |
| `pre-push` | Prettier, ESLint and the build, **whole repo** | tests |

**Neither hook runs the test suite**, despite what this file claimed until 2026-08-08.
Tests need Docker - each integration file starts its own Postgres through Testcontainers -
and take minutes, which is too much in front of every push. `.github/workflows/ci.yml` runs
them on every push instead. That split is deliberate; it is also why the suite once had
seven files failing unnoticed for over a week, before CI existed.

`pre-push` deliberately runs **the same commands as CI**, including `bun x eslint .` rather
than `bun run lint`. `bun run lint` passes `--fix`, so as a gate it would repair the
violation and report success while pushing the unrepaired commit.

`pre-commit` runs Prettier with `--ignore-unknown` and no extension list. It used to filter
staged files through a hand-written list of extensions, and that list did not include
`.mjs` - which is precisely how the 2026-08-08 failure got through. Prettier knows which
files it handles; asking it is more durable than maintaining a copy of the answer.

## Running them by hand

```
./.husky/pre-commit
./.husky/pre-push
```

## Bypassing

`git commit --no-verify` / `git push --no-verify`. CI still runs, so a bypass defers the
check rather than skipping it.
