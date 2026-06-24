# Provenance

This directory vendors the **classic-Wallwars minimax AI engine** (negamax + alpha-beta +
transposition tables) so it can be served from this monorepo as a second bot opponent,
alongside the Deep-Wallwars (AlphaZero/MCTS) engine.

- **Source:** https://github.com/nmamano/wallwars — `/AI` subdirectory
- **Commit:** `bb730f1f988d1b4fb2e1dc1786d62c70215be60e` (2026-02-27)
- **License:** MIT (same as the source repo)
- **Vendored:** 2026-06-23, for the "minimax AI" serving project.

## What this is

A self-contained C++17 command-line engine. Build with CMake presets (see `README.md`);
the `wallwars_ai` target offers `play` / `test` / `benchmark` modes. Core public API:
`Negamax<R,C>::GetMove(Situation<R,C>, millis)`.

## What is added on top (not in the source repo)

The server-side integration — a lightweight V3 BGS protocol wrapper (stdin/stdout JSON-lines)
that lets the official bot-client drive this engine — is built in slices per
`../plans/minimax-ai-loop.md`. Board coordinates and move notation are translated to/from
wallgame's representation in that wrapper; see the plan's "Resources" and "Traps" sections.

## Modifications to vendored files

Tracked here as the project progresses:
- (none yet — vendored verbatim)
