# Deep-Wallwars integration notes

## What this is

Deep-Wallwars, created by [Thorben Tröbst](https://github.com/t-troebst), is integrated into this monorepo as **vendored source code** using
**git subtree with squash**, and is treated as **authoritative local code**.

There is **no ongoing relationship with upstream**.

## Directory layout

- `deep-wallwars/`
  - Contains a snapshot of the Deep-Wallwars engine source
  - All engine modifications live here
  - There is NO nested git repository
  - Files are tracked directly by the monorepo

## Git model (important)

- Deep-Wallwars was imported once using `git subtree add --prefix=deep-wallwars deepwallwars main --squash`
- The monorepo does NOT contain upstream history
- There is NO bidirectional sync
- All changes to Deep-Wallwars are normal monorepo commits

Conceptually:

> Deep-Wallwars is vendored code, not an external dependency.

## Upstream policy (explicit)

- We do NOT pull from upstream
- We do NOT attempt to keep in sync
- We do NOT expect to rebase, merge, or cherry-pick upstream changes

If upstream contributions are ever desired:
- Changes will be manually ported from the monorepo into a clean fork
- There are no plans to keep the fork (https://github.com/nmamano/Deep-Wallwars) up to date with the monorepo.

## Development workflow

- Edit engine code and platform code in the same editor / monorepo.
- Single commits may touch both engine and server/wrapper code
- Engine evolution is driven entirely by this project's needs
- There is no special tooling, no submodules, no subtree pulls

## Rationale

This setup was chosen because:
- We want a single-repo, low-friction dev loop
- Engine internals must be modified deeply (variants, rules)
- Original project is not actively being worked on
- Upstream sync is not a requirement

This is an intentional, irreversible choice.
