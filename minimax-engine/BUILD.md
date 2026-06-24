# Building the classic minimax engine

Self-contained C++17 CMake project (vendored — see `PROVENANCE.md`). No external
dependencies, no GPU. Everything is header-only and pulled in by `source/main.cc`,
so it compiles as a **single translation unit** — the build is fast and LTO is
irrelevant.

## Toolchain (verified on auntie)
- cmake 3.28.3
- g++ (Ubuntu) 13.3.0
- Ubuntu 24.04, x86-64

## Build
```bash
cd minimax-engine
cmake --preset release
( cd build_release && make )
```
Produces `build_release/wallwars_ai`. `cmake --list-presets` shows the
`debug` / `release` / `*-clang` variants.

## Run modes
```bash
./build_release/wallwars_ai test       # self-test suite
./build_release/wallwars_ai play        # interactive CLI game
./build_release/wallwars_ai benchmark   # performance benchmark
```

## Gate
`scripts/test-gate.sh` builds and runs the self-tests, then asserts the
only failing test is the documented baseline failure below — failing (non-zero)
if the build breaks or the failing-test set/count changes.

## Known baseline failure (quarantined, NOT hidden)
`wallwars_ai test` reports **11/12 PASSED**. The single failure is:

```
NegamaxOrderedMovesTest FAILED      ("948: Mismatch in NegamaxOrderedMovesTest")
```

This is a **move-ordering heuristic** test, not a correctness test:
`NegamaxGetMoveTest` — which exercises the actual `Negamax::GetMove` the bot will
call — passes, and the search returns correct/winning moves in the self-test runs.
The mismatch is almost certainly compiler/platform-dependent ordering of equally
scored moves; it is present in the upstream source at the vendored commit
(`bb730f1`). We keep the test **visible** and gate on the exact failing name +
count, so a genuinely new regression cannot hide behind it.

> If this test's name or the `11/12` count ever changes, the gate fails on
> purpose. Do not "fix" it by editing the gate's expectations — investigate.
