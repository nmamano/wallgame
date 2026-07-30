# Engine cluster (batch 3) - three C++ tasks

Nil picked these on 2026-07-30 as "the most interesting cluster to me, and most impactful".
All three live in `deep-wallwars/`. Board tasks:

| Slice      | Task       | P   | Title                                                            |
| ---------- | ---------- | --- | ---------------------------------------------------------------- |
| S-SAMPLES  | `945fe1ef` | P2  | support `--samples 1` so Easy Bot is truly policy-only           |
| S-CONC     | `8f1cf7e3` | P2  | BGS engine unsafe under concurrent requests (two prod segfaults) |
| S-TIEBREAK | `b4c2b191` | P3  | tie-break equal-eval losing moves so PuzzleBot loses gracefully  |

Process is unchanged from batch 2: plan gate with Project Reviewer 1, implement, gates, diff gate,
sign-off, ONE commit per slice, push, desktop build, bot restart, production round-trip probe, docs.

**ALL THREE SHIPPED AND PRODUCTION-VERIFIED, 2026-07-30.** Nil playtested the puzzle fallback and
confirmed it: "no longer makes non-sensical moves when fully losing. behaving just like i wanted".

### Recommended NEXT batch (proposed 2026-07-30, Nil deferred the decision to a waking session)

**Bot availability and honest status** - `5f302c24` (the client silently serves the dummy bot when an
engine fails to start), `87e711cb` (auto-start/keep-alive for WSL + bot client), `222a2e3d` (make the
desktop WSL always-on), `5f6a2e44` (bots show offline after Fly restarts), `2337bcd6` (Tailscale in the
Fly container so the server can wake the client).

The reason it should be next: every wallgame outage on record sits inside that cluster's blast radius -
the 103-minute silent outage on 2026-07-26 (`5f302c24` is precisely WHY nobody noticed a dead engine),
the WSL-instance-down incident on 2026-07-29, and bots-offline-after-deploy. This cluster hardened the
engine itself, which moves the remaining risk squarely onto the supervision layer around it. `5f302c24`
deserves a plan gate of its own rather than being squeezed in: `spawnEngine` returns before the engine is
ready, so a real fix needs a readiness handshake, and the stderr-capture gap recorded on that task is
part of the same defect.

Caveat that batch carries: it touches WSL, the desktop supervisor and the Fly container - the same
surface that took the whole WSL instance down. Keepalive-first discipline throughout, and the
Windows-side recovery one-liner within reach before anything is killed.

Alternative if user-visible progress is wanted instead: the freestyle trio, `681a1659` (stop mirroring
the board across the midline), `2787ec58` (other board sizes), `018cc14e` (freestyle 8x8 as the site
default) - with `018cc14e` last, since it changes what a first-time visitor sees.

Two follow-ups this cluster created, both filed: `9c0ac857` (Easy Bot is STILL too strong at one sample -
Nil went 2-8 against it) and `e5fec60c` (the six stale C++ failures, now carrying a partial diagnosis).

---

## 0. Environment findings (2026-07-30, before any code)

These change how this cluster gets tested, so they come first.

### THE C++ HAS A UNIT TEST SUITE AND NOBODY HAS EVER RUN IT

`deep-wallwars/CMakeLists.txt:87-104` defines a Catch2 target `unit_tests` over eight test files
(`test/mcts.cpp`, `test/bgs_session.cpp`, `test/engine_adapter.cpp`, `test/gamestate.cpp`,
`test/play.cpp`, `test/batched_model.cpp`, `test/tensorrt_model.cpp`, `test/main.cpp`). It is
gated on `find_package(Catch2 3)`, Catch2 IS installed on the desktop, and the target had never
been built - there was no `build-tests/unit_tests` binary.

Measured on the desktop at `1caaa61`:

- `make -j6 unit_tests` in `deep-wallwars/build-tests` - **4.9 s** (the three `.trt` files
  `model_trt` depends on already exist in that tree, so nothing GPU-ish rebuilds).
- `./unit_tests` runs in well under a second: **84 cases, 619 assertions**.

So the brief's line "the C++ has no gates, which is the point" is wrong, and cheaply so. This
cluster gets a real automated gate. Every slice below runs `make unit_tests && ./unit_tests` and
compares against the recorded baseline.

### BASELINE: 6 pre-existing failures at `1caaa61` (RECORD THESE, they are not ours)

```
84 cases | 77 passed | 6 failed | 1 failed as expected
```

| Test case                                                  | Location                      |
| ---------------------------------------------------------- | ----------------------------- |
| `parse_move_notation - Cat and mouse move`                 | `test/bgs_session.cpp:167`    |
| `parse_move_notation - Pawn move and wall`                 | `test/bgs_session.cpp:183`    |
| `parse_move_notation - Double pawn move (cat moves twice)` | `test/bgs_session.cpp:197`    |
| `parse_move_notation - Double pawn move straight line`     | `test/bgs_session.cpp:223`    |
| `parse_move_notation - Invalid notation`                   | `test/bgs_session.cpp:242`    |
| `validate_request - rejects freestyle variant`             | `test/engine_adapter.cpp:446` |

`TensorRT 5x5 model` is tagged `[!shouldfail]`, which is the "1 failed as expected".

The five notation failures and the freestyle one look like tests that went stale as the notation
format and the freestyle support moved on - the freestyle one is plainly obsolete now that the
three prod bots all advertise a `freestyle` variant. **Not in scope for this cluster.** They are
being filed as a separate board task; the only thing this cluster owes them is the baseline
number, so that "6 failed" after a slice means "no regression" and "7 failed" means stop.

### Facts about the running configuration that matter for S-CONC

All three production bots run with `--thread_pool_size 4`
(`official-custom-bot-client/transformer.prod.config.json`). Four is the number that makes the
concurrency defect a production defect rather than a theoretical one - see S-CONC D1.

### REPRODUCED: the deadlock threshold is EXACTLY `--thread_pool_size`

Measured 2026-07-30 against throwaway engines on the desktop at `1caaa61` (driver:
`scripts/bgs-engine-probe.ts`, shape copied from `scripts/filter-puzzle-candidates.ts`). Each run
creates N sessions **sequentially, awaiting every ack** - that is the CONTROL, and it passed in
every single run, so the engine was provably alive and healthy immediately before it wedged - then
fires N `evaluate_position` messages with no waiting and counts responses.

| `--thread_pool_size` | concurrent requests | result                        |
| -------------------- | ------------------- | ----------------------------- |
| 4                    | 2                   | 2/2 in 239 ms                 |
| 4                    | 3                   | 3/3 in 258 ms                 |
| 4                    | **4**               | **0/4 - WEDGED, no recovery** |
| 8                    | 4                   | 4/4 in 251 ms                 |
| 8                    | **8**               | **0/8 - WEDGED**              |
| 2                    | **2**               | **0/2 - WEDGED**              |
| 12                   | **12**              | **0/12 - WEDGED**             |

The threshold tracks the pool size exactly across four different pool sizes, which is what makes
this the mechanism rather than a coincidence at 4. It matches the arithmetic in D1 precisely: N
concurrent requests block N pool threads in `blockingWait`, and the N coroutines they are waiting
for sit in the same pool's queue behind them. One free thread is enough to drain them serially;
zero free threads is permanent.

**This escalates the task.** The board task frames it as "bulk/concurrent requests starve it" with
bulk tooling as the trigger. What is actually true: **every production engine wedges permanently at
exactly 4 concurrent requests**, because production runs `--thread_pool_size 4`. Four simultaneous
puzzle games on PuzzleBot is enough. No bulk tooling required, no unusual traffic required. The
wedge is unrecoverable, and because the bot client stays attached and keeps listing bots when its
engine is unresponsive (task `5f302c24`), the failure is silent - which is the signature of the
~103-minute outage on 2026-07-26.

Order and priority are settled - see "Order - SETTLED: S-CONC first" below. The severity question
(whether the board task should sit above P2) is with Nil; it does not gate the work, which is
happening first either way.

### Confirmed at the same binary: the S-SAMPLES "before"

| `--samples` | result                                            |
| ----------- | ------------------------------------------------- |
| 1           | `success=false`, `"No legal move available"`      |
| 2           | `success=false`, `"No legal move available"`      |
| 96          | `success=false`, `"No legal move available"`      |
| 112         | `success=true`, `bestMove=">a2.>a1"`, eval -0.842 |

Consistent with the inherited measurements, and re-taken here so the after-state has a same-binary
before-state to compare against.

### REPRODUCED: the segfault, strongly attributed to the D3 lifetime hole

The reviewer told me to keep D3 as inference rather than proved cause. This upgrades it from "matches
the traffic shape" to **directly reproduced with a backtrace**, which is stronger - but not all the
way to "proved mechanism", and the limits are spelled out after the trace.

`scripts/bgs-engine-probe.ts --scenario race` starts a session, then puts `evaluate_position` and
`end_game_session` in flight together. Against the unfixed binary at `1caaa61` it **crashed on round
0** on both attempts (the probe run, and again under gdb), with only two concurrent requests - well
below the deadlock threshold of four, so this is a genuinely separate defect and not D1 wearing a
disguise. Two attempts is not a rate; what it establishes is that the crash is easy to hit on the
first try, not that it is deterministic. Engine stderr:

```
Created BGS session race-0 for bot probe          (worker 1794)
Ended BGS session race-0                          (worker 1796)
[process died: signal: segmentation fault (core dumped)]
```

Backtrace of the faulting thread, under gdb with a fifo for stdin (the engine needs a pollable fd,
so a plain file will not do - `AsyncPipeReader` cannot epoll a regular file):

```
Thread 8 "CPUThreadPool1" received signal SIGSEGV, Segmentation fault.
#0  0x00007fffa4001880 in ?? ()
#1  MCTS::create_tree_node(...) [clone .actor] ()
#2  std::coroutine_handle<void>::resume ()
#3  folly::resumeCoroutineWithNewAsyncStackRoot ()
#4  folly::coro::TaskWithExecutor<void>::Awaiter::await_suspend<...>
...
#9  folly::CPUThreadPoolExecutor::threadRun
```

**What this establishes.** The crash happens while a `create_tree_node` coroutine is being RESUMED
(frame #1 under `coroutine_handle::resume`), and frame #0 is a jump to an unmapped address. So
end-racing-evaluate reaches a crashing suspended-MCTS path, below the D1 cliff, and that path is
inside the session's own evaluation machinery. Combined with the stderr ordering - the session was
ENDED on another worker moments before - this strongly attributes the crash to the D3 lifetime hole.

**What it does NOT establish**, and the record should not claim:

- It does not prove the coroutine FRAME itself was freed. Destroying the `MCTS` frees the tree, the
  board and the evaluation function that a still-live frame REFERENCES, and a dangling reference of
  that kind produces the same invalid jump. Either way the cause is destroying state a suspended
  coroutine depends on; which allocation specifically got recycled is not readable from this trace.
- It does not formally exclude D2 from contributing.

Neither gap changes the fix: pinning the session with a `shared_ptr` keeps the whole `BgsSession` -
tree, board, evaluation function and all - alive until the handler finishes, so the resume lands in
live memory regardless of which piece was being recycled. And it is consistent with incident #2 (exit
139 during an `apply_move` at the tail of a four-game battery with a takeback resync) needing no
batch tooling, which is what that incident report said.

### A wedged engine cannot exit (corroborates D1's blast radius, NOT D4's specific race)

Four throwaway engines from the ladder runs above **survived their ssh pipe closing** and had to be
reclaimed by exact pid. Stdin EOF calls `terminateLoopSoon()` and `main` returns, but the pool
destructor then tries to join threads that are blocked forever, so the process never finishes
shutting down. Operationally that matters a lot: a wedged production engine does not die and get
respawned, it sits there holding GPU memory, which is consistent with the bot client happily
continuing to list it.

Be precise about what this is evidence FOR. It confirms D1's blast radius and that the old teardown
cannot complete while executor threads are deadlocked. It does **not** externally prove D4's specific
`ResponseWriter`-destroyed-before-the-pool-drains use-after-destruction. That one is read off the
declaration order in `main`, which is confirmed by reading the code, but it has not been observed
firing. Both are fixed by the explicit drain either way.

### Which `blockingWait` calls are dangerous and which are merely wasteful

Traced the evaluation chain: `CachedPolicy` (`src/cached_policy.cpp:76`) -> `BatchedModelPolicy`
(`src/batched_model_policy.cpp:9`) -> `BatchedModel::inference` (`src/batched_model.cpp:32`).
`BatchedModel` owns its own worker threads (`m_workers`, spawned in the constructor,
`run_worker` at :65) which `blockingRead` the queue and fulfil the promise. `CachedPolicy` does
**not** coalesce duplicate in-flight lookups - on a race it just evaluates twice - so there is no
coroutine-waits-on-coroutine edge anywhere in that chain.

Consequence: the `folly::coro::blockingWait` calls **inside** MCTS (constructor `mcts.cpp:48`,
`force_action` :299, `reset_to_position` :317) always complete without needing the caller's
executor. They burn a pool thread for the duration of one inference, which is wasteful, but they
cannot deadlock. **They are therefore out of scope for S-CONC**, which keeps that diff
proportional.

This conclusion has a dependency worth writing down: it holds only while `BatchedModel` keeps its own
independent worker threads. If it were ever changed to run inference on the caller's executor, those
`blockingWait` calls become the same self-pool dependency as D1 and this scope decision has to be
revisited.

The dangerous `blockingWait` is the one in `bgs_engine_main.cpp:290`, which waits on
a coroutine explicitly scheduled onto the same pool.

---

## S-SAMPLES (`945fe1ef`) - policy-prior fallback

### Root cause, now confirmed in code

The measured symptom is in the task body: the engine answers "No legal move available" below
roughly 100 samples (fails at 96, works at 112). The code reason:

`MCTS::peek_best_action()` (`mcts.cpp:321`) and `MCTS::peek_best_move()` (:338) both rank edges by
**child visit count** and both bail with `nullopt` when the winning edge has no expanded child
(`te.child == nullptr`). A `TreeEdge` only gets a child when a sample descends through it.

- After 1 sample, exactly one root edge has a child (`initialize_child` created it with
  `Value{eval.value, 1}`), so `peek_best_action()` **already works at `--samples 1`** - its key is
  1 for that edge and 0 for every other.
- `peek_best_move()` then needs a _grandchild_: the second action's edge must itself be expanded.
  That only happens once the search descends through the same root child a second time. On an 8x8
  board the root has 100+ edges and PUCT spreads early visits across them by prior, so the
  most-visited root child does not reach 2 visits until ~100 samples. Until then every second-action
  edge has `child == nullptr`, the "try to find any explored edge" fallback at :374-382 also finds
  nothing, and `bgs_session.cpp:292` reports the error.

So the missing piece is precisely the **second action**, and the threshold is "when does the best
root child get a second visit", which is why it lands around 100.

What is NOT established: board-size independence. 112 succeeding on both 5x5 and 12x10 only shows
that both thresholds are at or below 112, and the legal-action count - which is what the visits
spread over - does vary with the board. The depth-two mechanism is established; the invariance is
not, and nothing in this slice needs it to be.

### Fix

`TreeEdge::prior` is the policy head's probability for that action, and it is populated for every
legal action the moment a node is created (`create_tree_node` stores `eval.edges`). So the network
already tells us the best action without any search. Make both peek functions fall back to it:

- `peek_best_action()`: if no root edge has an expanded child, return the **max-prior** edge's
  action instead of `nullopt`.
- `peek_best_move()`: for the second action, if no edge of the first action's child has an expanded
  child, return that child's **max-prior** edge. Only when NO second edge is expanded - once there is
  any visit evidence, the existing visit-count selection stands. This also replaces the existing
  arbitrary-explored-edge fallback at :374-382 with a prior-ordered one, which is strictly better.

`edges.empty()` still returns `nullopt` - that is a genuinely move-less position (the
"our only second action is to undo our first move" case `sample_rec` comments on at :166-172) and
erroring is correct there.

**`peek_best_move()` still returns `nullopt` at ZERO samples, by design.** With no root child there
is no second position whose policy we could read, and manufacturing one would mean evaluating and
creating a node - mutating the tree, which breaks the read-only contract of a `peek`. Zero-sample
`peek_best_action()` does fall back to max prior, because the root's own priors already exist. The
required behaviour is a complete legal move at **exactly 1 sample**.

At `--samples 1` this yields: first action = the one the single sample expanded, which _is_ the
max-prior edge; second action = policy argmax on the resulting position. So the tree search
contributes nothing to the choice - but see the root-noise item below before calling that
"policy-only" without qualification.

### Deliberately NOT changing

- **`commit_to_action()`** keeps its `nullopt`. It mutates the tree via `move_root(te)`, which
  requires `edge.child` to exist. It cannot fall back without creating a node, and it is what
  self-play/training uses, so leaving it alone also means training behaviour is untouched. This
  asymmetry (peek can fall back, commit cannot) is intentional.

### Root Dirichlet noise: a new per-process flag, NOT a shared-default change

`Options::noise_factor = 0.25` and `add_root_noise()` (`mcts.cpp:488`) perturb _root_ priors, and the
BGS engine never overrides it. So at `--samples 1` the first action would come from a policy that is
25% Dirichlet noise while the second (one level down) comes from the clean policy. I originally
proposed leaving that alone and describing samples=1 as approximately policy-only. That does not
survive contact with what Nil actually asked for, and the reviewer rejected it: I cannot call
something "truly policy-only" while a quarter of the root prior is noise.

Ruling implemented instead: add a `--root_noise_factor` flag to `bgs_engine_main.cpp`, default
**0.25** so nothing changes by default, validated finite and within [0,1], plumbed into
`MCTS::Options::noise_factor` via `BgsEngineConfig`. Set it to **0 for dw-easy only**. Superhuman and
PuzzleBot keep today's behaviour through the default. The production config test pins samples=1 AND
root noise=0 for Easy Bot, so a future edit cannot quietly restore the noise and leave the bot
neither policy-only nor searching.

### Behaviour at production sample counts

The fallback does not fire in the measured production positions - at 1000 or 5000 samples the best
root child has thousands of visits and therefore expanded children. That is an observation about
those positions, not a structural impossibility, so it is worth re-checking rather than assuming.
`main.cpp` (the `deep_ww` analysis binary) also calls `peek_best_move` at :530/:532/:690; same
reasoning, only thin trees change, and only from "no answer" to "the policy's answer".

### Tests

New Catch2 cases:

- `peek_best_move` returns a complete two-action move after **exactly 1 sample** (today: `nullopt`),
  with both actions legal in sequence.
- `peek_best_move` still returns `nullopt` at **0 samples** - the deliberate boundary above.
- `peek_best_action` at **0 samples** returns the **max-prior** action.
- The action returned by the prior fallback is one of the position's legal actions.
- At a high sample count the returned move equals a **concrete pinned expected move** under a fixed
  `TestPolicy` and seed. NOT two calls of the new implementation compared to each other - that would
  pass no matter how wrong the new selection was.

One existing assertion FLIPS and must change in the same commit:
`peek_best_action - Before sampling returns nullopt` (`test/bgs_session.cpp:259`) asserts exactly
the behaviour being removed. It gets rewritten to assert the prior fallback, with a comment saying
why. Called out here because a silently-edited test assertion is how a regression hides.

### Rollout

1. `make unit_tests && ./unit_tests` - expect the 6-failure baseline and the new cases passing.
2. `make deep_ww_bgs_engine`.
3. Offline throwaway-engine probe at `--samples 1`, one request at a time: start session, evaluate,
   confirm a legal `bestMove` where today we get "No legal move available". Sweep 1/2/4/8 to show
   the whole failing band is fixed, not just the one value.
4. `dw-easy` -> `--samples 1` in `transformer.prod.config.json`; update the pin in
   `tests/game/bot-config-guards.test.ts:111-131` (128 -> 1) and its comment, which currently says
   a lower number is a broken config.
5. `bun scripts/validate-bot-config.ts`.
6. Restart bots KEEPALIVE-FIRST (`info/puzzle-platform.md` section 2).
7. Full round-trip probe against Easy Bot specifically, plus the other two.

---

## S-CONC (`8f1cf7e3`) - safe under concurrent requests

Four distinct defects, one theme. D1 is the one the task names; D2-D4 were found while reading and
are better candidates than D1 for the two segfaults, because neither incident involved bulk traffic.

### D1 - thread-pool inversion -> deadlock (the reproducible bulk-pump hang)

`bgs_engine_main.cpp:286-301`:

```cpp
thread_pool->add([...]{
    auto response = folly::coro::blockingWait(
        bgs::handle_bgs_request(...).scheduleOn(thread_pool.get()));   // same pool
    response_writer.write(response);
});
```

A pool thread blocks until a coroutine **explicitly scheduled onto that same pool** finishes, and
that coroutine's `MCTS::sample()` in turn schedules its `single_sample()` tasks onto the same pool
(`mcts.cpp:71-75`). N concurrent requests occupy N threads in `blockingWait`, and the work they are
waiting for can never be scheduled.

Production runs `--thread_pool_size 4`. So **four** simultaneously in-flight requests wedge the
engine permanently, and even a single request runs its search on 3 of 4 threads. That is the
144-message bulk pump returning 0 responses.

**Fix:** never block. Launch the handler as a coroutine that writes its own response, and extract
the dispatch out of `main` so it is testable (see "Testability" below).

### D2 - `std::mutex` held across a `co_await` -> cross-thread unlock (UB)

`handle_evaluate_position` takes `std::lock_guard<std::mutex> session_lock(session->request_mutex)`
at `bgs_session.cpp:239` and then `co_await session->mcts->sample(...)` at :250. A folly `Task`
resumes on _an_ executor thread, not necessarily the one that suspended. So the `lock_guard`
destructor can run `pthread_mutex_unlock` on a thread that does not own the mutex. That is
undefined behaviour; glibc's normal mutex silently stores 0 and corrupts the futex state, which is
exactly the failure profile the task describes - "prod mostly survives by accident" - and it
becomes lost wakeups or a crash as soon as there is real contention on that mutex.

This is a **hazard on every evaluate path that can suspend**, not an observed corruption on every
call. Two things make it conditional: a cache hit in `CachedPolicy` can complete inline without ever
suspending, and a suspension that does happen may be resumed by the same worker anyway. So the UB
fires only when the continuation lands on a different thread - which is precisely why production
"mostly survives by accident" rather than crashing constantly. It needs no bulk traffic at all.

`handle_apply_move` locks at :326 but never `co_await`s afterwards (`force_action` blocks inline),
so it is same-thread today and not affected by D2 - but it is affected by D3.

**Fix:** `folly::coro::Mutex` + `auto lock = co_await session->request_mutex.co_scoped_lock();`.
Coroutine-aware: it suspends instead of blocking a thread, and it releases correctly regardless of
which thread resumes.

### D3 - session lifetime: a raw pointer escapes the lock -> use-after-free

`SessionManager::get_session` (`bgs_session.cpp:107`) takes a `shared_lock`, reads the map, and
returns a raw `BgsSession*` - **the lock is released on return**. `end_session` (:92) takes the
unique_lock and `m_sessions.erase(it)`, destroying the `unique_ptr<BgsSession>` and with it the
whole MCTS tree. Any handler still holding that raw pointer is now reading freed memory, and an
in-flight `sample()` is walking a freed tree. SIGSEGV.

**Directly reproduced** - see the race reproduction in section 0. The backtrace is consistent with
this lifetime hole and strongly attributes the crash to it, and shared ownership removes the hole.
Two things it does NOT establish, and the record should not claim: it does not prove the coroutine
FRAME itself was freed (destroying the MCTS frees the tree, the board and the evaluation function
that a still-live frame references, and a dangling reference of that kind produces the same invalid
jump), and it does not formally exclude D2 from contributing.

It also matches incident #2's traffic shape: four bot games created / played / resigned in tight
sequence plus a takeback resync (end + start + replay churn), with no batch tooling involved.

**Fix:** `std::shared_ptr<BgsSession>` in the map; `get_session` returns the `shared_ptr`. A handler
pins its session for its whole duration. `end_session` removes it from the map immediately (so a
later request correctly gets "Session not found") and the object is destroyed when the last handler
drops it.

### D4 - teardown races in-flight work

On stdin EOF, `on_eof` sets `running = false` and calls `evb.terminateLoopSoon()`. `main` then
destroys its locals in reverse declaration order: `evb`, then `response_writer`, then
`thread_pool`. But `CPUThreadPoolExecutor`'s **destructor** is what joins outstanding tasks - so
`response_writer` is already destroyed by the time the pool drains, and any handler still finishing
writes through a destroyed `std::mutex` and `ostream`. `running` is written and never read.

**Fix:** drain explicitly after the loop exits and before anything goes out of scope; drop the dead
`running` flag.

Evidence status: the leaked wedged engines (section 0) corroborate D1 and show that the old teardown
cannot finish while executor threads are deadlocked. They do **not** externally prove the specific
`ResponseWriter`-destroyed-before-the-pool-drains use-after-destruction race - that one is read off
the declaration order, which is confirmed, but it has not been observed firing.

### Testability - extract the dispatcher

The defect lives in `main`, which no test can reach. So the dispatch moves into its own unit,
`deep-wallwars/src/request_dispatcher.{hpp,cpp}` - a separate file rather than inside
`bgs_session.*`, to keep transport lifetime out of session-domain code:

```cpp
class RequestDispatcher {
public:
    using ResponseSink = std::function<void(json const&)>;
    RequestDispatcher(SessionManager&, BgsEngineConfig const&,
                      std::shared_ptr<folly::Executor>, ResponseSink);
    ~RequestDispatcher();                 // drains, so no handler outlives what it borrows
    void dispatch(json request);          // returns immediately; never blocks the caller
    void drain();                         // blocks until every handler AND its sink call finished
    bool drain_for(std::chrono::milliseconds);  // bounded, so a test can fail instead of hanging
    int in_flight() const;
};
```

`on_line` becomes `dispatcher.dispatch(std::move(request))` and the post-loop path becomes
`dispatcher.drain()`. `main` is then left with no dispatch logic of its own, so the unit test
exercises the shipped path rather than a copy of it. `drain()` must not be called from a pool
thread; that gets a comment.

Two contracts the implementation has to hold, both of which are easy to get wrong:

- **Exactly one sink call per dispatched request.** Response PRODUCTION is separated from DELIVERY,
  so a throwing sink is logged rather than retried. My first version wrapped both in one `try`, which
  meant a throwing success-sink was misread as a handler error and the same broken sink was called a
  second time with an error object - breaking the contract the header advertises and making the
  response count meaningless.
- **The in-flight count releases on every exit.** Incremented before the task exists, and released by
  a move-only `Ticket` captured into the handler lambda, so it fires even if the task is destroyed
  without running. `finish_one()` `XCHECK`s that the count is positive first, so a future
  double-release fails loudly instead of driving the count negative and turning `drain()` into a
  permanent wait - which would look exactly like the deadlock being fixed.

Honest limitation, stated up front: the new unit test cannot _fail on today's tree_, because today's
tree has no `RequestDispatcher`. That is why the process-level evidence below is not optional.

### Tests

Catch2 (uses `TestPolicy`/`SimplePolicy`, no GPU):

- **144-message bulk pump does not deadlock.** Executor sized 4, matching production, with far more
  than 4 concurrent requests across many sessions. Assert all 144 responses arrive and `drain()`
  returns. This is the regression guard the task asks for.
- **`end_game_session` concurrent with `evaluate_position` on the same session** - loop it, assert
  no crash and that every request gets a coherent response (either a result or "Session not found",
  never a torn one).
- **Many concurrent evaluates on one session** all complete - the `coro::Mutex` serialises rather
  than deadlocks.

What these do NOT prove, so I will not claim it: absence of a data race. Catch2 without a sanitizer
cannot show that. I will **attempt** an ASan build of `unit_tests` to get before/after evidence for
D3 specifically; if folly + CUDA make that impractical I will say so and rely on the process-level
evidence rather than overstate the unit tests.

### Process-level evidence (this is the real before/after)

Against a **throwaway** engine on the desktop, never a serving one:

1. **Before:** the 144-session corpus at the CURRENT binary with `--thread_pool_size 4`. DONE - 0/144,
   see section 0. This is the reproduction the brief insists on; "it worked when I tried it" is
   worthless for a load-shape bug.
2. **Before:** the end-vs-evaluate race at the current binary. DONE - SIGSEGV on round 0.
3. **After:** the identical corpus and race at the fixed binary. Requires 144/144 distinct expected
   ids with successful non-empty moves and no duplicates, every race round producing exactly one
   coherent evaluate plus one end, AND a **natural** engine exit in both - a forced exit is a failure
   on the fixed binary, because a healthy engine must be able to shut down.
4. The `band` scenario as a sequential sanity pass, so the fix did not break the normal path.
5. Only then, restart bots keepalive-first and run the full round-trip probe on all three.

A verdict is never "responses arrived". `runCorpus` passes only on all-distinct-expected-ids, zero
duplicates, zero unexpected ids, zero failed evaluations, and a natural exit. Counting response
objects would certify an engine that answers "No legal move available" 144 times.

The probe never signals a pid it has not identified: each launch gets a unique `--seed`, and
`/proc/<pid>/cmdline` must contain both the engine path and that exact seed before any signal. Pids
get reused, and the serving Superhuman bot runs the same binary, so a bare kill on a captured pid
could hit production. A mismatch refuses to signal. If no pid arrives, the run aborts before sending
any protocol traffic rather than driving an engine it could not reclaim.

### Explicitly out of scope

`5f302c24` - the bot client stays attached and keeps listing bots when its engine dies, which is
what turned incident #2 into a 103-minute silent outage. Different component, its own design
question (`spawnEngine` returns before readiness, so a real fix needs a handshake). The brief says
do not fold it in without asking, and I am not folding it in.

---

## S-TIEBREAK (`b4c2b191`) - lose gracefully

**NOT APPROVED FOR CODE.** This slice is measurement-only until a second plan gate. What follows is
the hypothesis to be tested, not a design to implement.

### Suspected root cause - to be CONFIRMED, not assumed

`peek_best_action`/`peek_best_move` rank by child visit count. The hypothesis is that in a position
the engine judges lost, every child's Q saturates near -1, so the exploitation term in
`get_best_edge` (`mcts.cpp:109`) goes flat and visits get distributed by prior plus root Dirichlet
noise, making the choice among losing moves effectively arbitrary - including moves that lose sooner,
or that ignore the threat. That would explain Nil's "feels broken to the player".

But the premise is not established. The measurement pass has to distinguish between Q saturation,
visit ties, root-noise instability, and something else entirely. Designing a fix before knowing which
of those it is would be the batch-2 mistake again.

### Direction, once the premise is confirmed

A-like: **keep the search as the primary evidence**, and use a resistance measure only among
actions or full moves whose evaluated outcomes are demonstrably indistinguishable in the lost regime.

The option I originally recommended - when the root looks lost, replace the ranking key with
`score_for` outright - is **rejected**, and the reasoning against it is better than mine was. A root
judged lost does not make the visit distribution valueless: visits still encode the policy and
whatever downstream evidence the search accumulated, so replacing them can pick an unsearched,
near-zero-prior action and throw away 5000 samples. It is also not the magic-number-free option I
claimed, because it moves all of the judgement into one root threshold.

`Board::score_for(player)` (`gamestate.cpp:665`) remains the candidate resistance measure - when
behind it returns `-1 + opponent_dist / my_dist`, so maximising it prefers lengthening the opponent's
path and shortening your own. Using the cat is consistent with the game's attack race. But it still
has to be shown to order the moves Nil considers graceful; that a distance ratio is a perceptual
proxy for "stubborn" is an assumption, not a fact.

### The measurement pass (this is the actual next step for this slice)

For several genuinely lost positions including Nil's observed case, across **fresh bgsIds and
repeated engine processes** - fresh because root Dirichlet noise is seeded from the bgsId, so
repeating one id would look stable by construction - collect:

- the root value;
- for candidate first actions: visits, Q from the acting player's perspective, prior, and the
  resulting `score_for`;
- for the explored second actions below the leading first actions: the same facts;
- the selected complete move, and the board score after BOTH actions;
- matched won/unclear control positions, to size how often a rule would activate falsely.

Separate same-seed repeatability from cross-seed behaviour. Any root threshold and any
Q-equivalence band gets sized from the observed spread and placed outside it.

### Full move versus per-action - to be decided by evidence

My proposed per-action greedy tie-break is **not approved**. The user-visible object is a full move,
and a first action with an attractive immediate score can block a much better second action while the
5000-sample tree already holds the grandchildren. The discovery pass must compare full-move
resistance against the per-action shortcut, and prefer scoring the board after BOTH actions for a
`Turn::First` request; one-action scoring is only for a genuine `Turn::Second` custom setup. If the
full-move traversal turns out to be disproportionate, that is an approximation to accept
consciously, with evidence, at the second gate.

### Then

Return with a concrete choice rule and the enumerated list of moves it changes. Verification will
need a unit case pinning a won/unclear position as **identical** to today, plus a real playtest from
Nil - probes can only show the bot still answers; only a human can say it stopped feeling broken.

### NIL DECIDED THE DESIGN, 2026-07-30. This supersedes the option survey above.

Nil chose, in his words, to "handle it at the adapter level, not the core engine: if the evaluation
says that the position is completely lost, fall back to the naive policy instead (walk toward
goal/mouse)". Settled parameters:

- **Adapter level, not `mcts.cpp`.** The core is shared with self-play and training; the BGS adapter
  is only the bot-serving path. This is a smaller blast radius than the peek-function change I had
  planned, and nothing that would need retraining is touched.
- **Threshold: eval <= -0.9** from the mover's perspective. Nil picked -0.9 over my -0.8 explicitly
  as the more aggressive/safer choice.
- **NO hysteresis.** I proposed it; Nil declined, and he is right for a reason I had backwards - see
  below.
- **Firing throughout a puzzle is WORKING AS INTENDED.** I flagged that PuzzleBot is losing by
  construction in every puzzle, so the fallback would fire constantly. Nil: "well only if the human
  finds the right move. if the human makes a mistake, it gets punished with full strength. that's
  WAI." That is the whole design in one line: the bot coasts while the human is playing correctly and
  snaps back to full-strength search the moment the human errs and the eval recovers.
- **Which is exactly why hysteresis would be a BUG, not a nicety.** Hysteresis exists to stop a
  threshold flapping, but here the flapping IS the feature. Latching into naive mode would delay the
  bot punishing a mistake, which is the opposite of what the design wants. My recommendation was
  actively wrong, not merely over-cautious.

`SimplePolicy` (`src/simple_policy.cpp`) is the naive policy to reuse, and it is already
flag-configurable. Use it AS A POLICY - argmax over its priors on legal actions, re-evaluated after
the first action - rather than hand-rolling "step toward goal". A wallgame turn is two actions and the
second sometimes has only "undo the first" available, so a hand-rolled walker can emit an illegal
move where an argmax over legal priors cannot.

### THE ONE THING TO MEASURE BEFORE WRITING THE THRESHOLD IN

I do not understand the eval scale yet, and the number depends on it. Measured on 2026-07-30: a
**fresh, symmetric 8x8 standard opening** reported `eval = -0.8277` at 1000 samples. A symmetric
opening should read near zero. Three candidate explanations, in order of my confidence:

1. **Padding.** The production model is **10x12** (it logs `Model dimensions: 10x12`), and my probe
   asked for an 8x8 board, so `validate_bgs_config` padded it. Nil's real games are 12x10 - native
   size. So the -0.83 may be an artifact of a board size nobody actually plays.
2. The value is from the perspective of the player NOT to move, or the P1-perspective conversion in
   `handle_evaluate_position` (`bgs_session.cpp:303`) does something other than what the field name
   suggests.
3. The value head is not calibrated as anything probability-like.

**Cheap check that settles it, and it must be done first:** run `scripts/bgs-engine-probe.ts` on a
NATIVE 12x10 fresh position and read the eval. If it comes back near zero, explanation 1 holds, the
scale is fine, and -0.9 is a sensible "clearly lost" line - proceed. If a native fresh opening also
reads about -0.83, then the usable range is compressed and -0.9 is only ~0.07 from ordinary play,
which would make the bot naive most of the time. Then bring Nil the numbers before picking a value.
Also read a genuinely lost position and a genuinely won one, so the threshold sits inside a known
range rather than next to a single sample.

---

## Order - SETTLED: S-CONC first

I proposed S-SAMPLES first (smallest, Nil actively wants it, cheap way to warm the
build/test/deploy/probe loop). Project Reviewer 1 **overruled that** on the strength of the
reproduction above, and they are right: the deadlock is not a load-shape edge case, it is a
four-ordinary-requests outage cliff sitting in production right now, and the warm-up argument does
not survive the fact that the desktop unit target has already been built and run. Order is
**S-CONC, then S-SAMPLES, then S-TIEBREAK** (the last one measurement-first, see below).

No interim config mitigation. Raising `--thread_pool_size` does not remove the inversion, it only
moves the cliff, and it would cost a second bot restart plus its own load validation. Reviewer
agreed and explicitly did not authorise one. If S-CONC gets blocked, come back rather than
improvise.

---

## S-CONC SHIPPED AND PRODUCTION-VERIFIED (`a4b6783`, 2026-07-30)

Board task `8f1cf7e3` done. Rolled out via a temporary Git transport branch so the candidate was
compiled and tested BEFORE main took it - the engine builds only on the desktop and reaches it only
through git, so the alternative was committing uncompiled C++ to main. main was fast-forwarded to the
exact validated SHA afterwards, so the shipped tree is byte-identical to the tested one, and the
branch is deleted.

### Build and unit gates at the candidate SHA

- `make -j6 deep_ww_bgs_engine unit_tests` - clean. The only warning is a pre-existing
  `-Walloc-size-larger-than=` from `folly/MPMCQueue.h` via `batched_model.cpp`, a file this slice
  does not touch.
- The two constructs flagged as compile risks both built: `co_invoke(...).scheduleOn(...).start()` as
  fire-and-forget, and the move-only `Ticket` captured into a mutable lambda.
- `timeout 300 ./unit_tests "[dispatcher]"` - 7 cases, 923 assertions, exit 0, far inside the bound.
- `timeout 300 ./unit_tests` - **91 cases** (84 baseline + 7 new), 1545 assertions, and the six
  unexpected failures matched the recorded baseline **by name**, with `TensorRT 5x5 model` still
  reported separately as the `[!shouldfail]`. No additions and no substitutions.

### Process evidence, identical corpus both sides

|                                        | BEFORE `1caaa61`                     | AFTER `a4b6783`                               |
| -------------------------------------- | ------------------------------------ | --------------------------------------------- |
| 144 concurrent evaluates, pool 4       | **0/144 in 90 011 ms**               | **144/144 in 941 ms**                         |
| duplicates / unexpected / failed evals | 0 / 0 / 0                            | 0 / 0 / 0                                     |
| shutdown                               | FORCED, `cleanup=killed`, ssh exit 1 | **NATURAL**, `cleanup=not-needed`, ssh exit 0 |
| 40-round end-vs-evaluate race          | **SIGSEGV on round 0**               | **40/40 coherent**                            |
| band 112 / 1000 samples                | `>a2.>a1` / `>a2.>a1`                | `>a2.>a1` / `>a2.>a1` (unchanged)             |

The race run logged `Created BGS session race-39` from one worker and `Ended BGS session race-39`
from another, so the interleaving genuinely happened rather than accidentally serialising. The band
result is the evidence that the search itself did not move; low sample counts still answer
"No legal move available", confirming this slice did not touch S-SAMPLES.

### Production rollout

Restarted keepalive-first per `info/puzzle-platform.md` section 2. The keepalive session held the
tmux server through the kill, so there was no WSL outage this time.

- Live-game check before interrupting: two games showed `status: "in-progress"`, which on its own
  would have meant waiting forever. What actually settled it was the CONJUNCTION - both had
  `connected: false` on the human host AND were 28 and 52 minutes stale. Abandoned guest games the
  server had not reaped, not live players. `status` alone is not a liveness test, and staleness alone
  is not either, because a human may simply be thinking.
- `bun scripts/validate-bot-config.ts official-custom-bot-client/transformer.prod.config.json` -
  VALID, 3 bots, engine command per bot. Note it REQUIRES the config path argument.
- Startup verified from a byte offset captured before the restart, so an old log line could not
  satisfy it: `Engine started` for all three bots, then `Successfully attached with 3 bot(s)`.
- **The engines were proved to be the rebuilt binary, not just assumed.** All three new PIDs have
  `/proc/<pid>/exe` resolving to inode 17872, the same inode as the on-disk binary with sha256
  `95dc875edb69784c125a9f4ab18f229f33cce8c539865243d17ca7a9ceab4e3c`. An `Engine started` log line
  is not a health verdict and a matching path is not a matching image.
- Full ROUND TRIPS - connect, survive >5 s, human move, BOT REPLY, resign - all three green:
  PuzzleBot game `JlgtkrJv`, Easy Bot `SIwisrP5`, Superhuman Bot `LuwTQf1h`.

Deliberately NOT done: driving 4+ simultaneous real games at the live PuzzleBot. The exact shipped
binary already answered 144 concurrent evaluates offline, so loading production would add user
impact without isolating a new variable. Reviewer concurred.

### An ops fact worth knowing

`/api/bots/play` needs the CLIENT-NAMESPACED bot id, not the config id:
`wsl-transformer-001:dw-easy`, not `dw-easy`. The bare id returns
`404 {"error":"Bot not found or not connected"}`. Read the ids off
`/api/bots?variant=...` rather than off the config file.

---

## S-SAMPLES SHIPPED AND PRODUCTION-VERIFIED (`3aff1ae`, 2026-07-30)

Board task `945fe1ef` done. Same temporary-transport-branch process as S-CONC: the candidate was
compiled and fully tested BEFORE main took it, and main was then fast-forwarded to the exact validated
SHA, so the shipped tree is byte-identical to the tested one. Both temporary branches are deleted.

Easy Bot now runs `--samples 1 --parallel_samples 32 --thread_pool_size 4 --root_noise_factor 0`.

### One extra step this slice needed: a measurement branch

The reviewer required the high-sample regression test to pin a CONCRETE move, and there is no way to
know that value without compiling. So a throwaway branch `measure/s-samples` (`59a5fd9`, its commit
message saying MEASUREMENT ONLY) went to the desktop first with the assertion still reading
`PIN_ME`, and **only the `unit_tests` target was built** - never `deep_ww_bgs_engine`, because
building that replaces the binary the bot client respawns from. Proof it did not: the engine binary's
sha256 was identical before and after that build.

That run reported the real value, `Cc5`. Then `src/mcts.cpp` alone was swapped for the `d9d4ab4`
version (via `git show` into a temp file, so nothing was discarded), rebuilt, and the same case run
again: the PRE-CHANGE code also produced `Cc5`, and the other six assertions in that case
(principal-variation equality, positive visits at both selected edges) passed on the old code too.
So the pinned literal states that deep search is unchanged, rather than recording the new
implementation's own output. Worth repeating for future slices: a pin measured only on the new code
is a future-regression canary, not a before/after statement.

### Build and unit gates at the candidate SHA

- `make -j6 deep_ww_bgs_engine unit_tests` - clean; the only warning is the pre-existing
  `-Walloc-size-larger-than=` from `folly/MPMCQueue.h`.
- Targeted, each exit 0: `[dispatcher]` 7 cases / 923 assertions (S-CONC's guard, still green),
  `[BGS MCTS]` 9 / 32, `[BGS Session]` 7 / 93.
- Full suite: **96 cases** (91 + 5 new), 89 passed, 6 failed + 1 as expected. The six unexpected
  failures matched the recorded baseline **by name** - no additions, no substitutions - and the case
  count is fully accounted for by the five new cases.

### Process evidence

| probe                               | before (`a4b6783`)                 | after (`3aff1ae`)                  |
| ----------------------------------- | ---------------------------------- | ---------------------------------- |
| band 1/2/4/8, 8x8, `--root-noise 0` | all four "No legal move available" | all four LEGAL complete turns      |
| `--require-move` verdict            | **FAIL, exit 1**                   | **PASS, exit 0**                   |
| band 112 (default noise)            | `>a2.>a1` eval -0.842              | `>a2.>a1` eval -0.8413             |
| band 1000 (default noise)           | `>a2.>a1` eval -0.8261..-0.8270    | `>a2.>a1` eval -0.8270             |
| 5x5 / 12x10 at 1 sample, noise 0    | (not measured)                     | `Cb5.>a1` / `Cb10.>b1`, both legal |

The `--require-move` row is the one that matters most: the gate was run against the OLD binary FIRST
and observed to fail, so it is a gate that discriminates rather than one that has only ever passed.
The 112/1000 rows are the evidence that Superhuman Bot and PuzzleBot are unaffected.

A pleasing detail: on 12x10 the ONE-sample policy pick (`Cb10.>b1`) is the same move the 1000-sample
search chooses. The policy head agrees with deep search at the opening, which is what "weaker bot"
rather than "broken bot" looks like.

Stated limit: 6x6 at 5000 samples answers a legal move on the new binary, but no before-value was
recorded for that exact configuration, so that one shows "still works", not "unchanged". PuzzleBot's
real games are 6x6 **custom-setup**, which the probe cannot construct - it has no custom-initial-state
support. That is S-TIEBREAK's work.

### Production rollout

- Live-game check by CONJUNCTION: three games showed `status: "in-progress"`, and all three had the
  human `connected: false` AND were 154, 247 and 254 minutes stale. Abandoned guest games (task
  `ce4434fc`), not live players.
- Preflight run on the DESKTOP against the file the client actually reads: VALID, 3 bots, and the
  `dw-easy` line showing `--samples 1 ... --root_noise_factor 0`.
- Restarted keepalive-first, with the keepalive session confirmed present before the kill.
- Verified from a log byte offset captured before the restart: `Engine started` for all three bots,
  then `Successfully attached with 3 bot(s)`.
- **Engines proved to be the new binary**, and this is where the method had to be corrected: bare
  `stat -c %i /proc/<pid>/exe` returns the PROCFS SYMLINK's inode - a different number per process
  that can never match the file on disk. With `stat -L` the three pre-restart engines all resolved to
  the deleted inode 17872 (the S-CONC binary) and the three post-restart engines to 41613, the file on
  disk. Filtering to the bot client's children also matters, because `pgrep -f` matches your own
  shell. Both traps are now written up in `info/puzzle-platform.md`.
- Full ROUND TRIPS - connect, survive >5 s, human move, BOT REPLY, resign - green on all three:
  Easy Bot `58ktHD4j`, Superhuman Bot `cc-wh9zI`, PuzzleBot `CzQEe4tH`.

### Reviewer's one requested change

The diff gate came back CHANGES REQUESTED on a single point, and it was a violation of the probe's own
documented contract: `judgeMove` was called only when `response.success === true`, so a failed
response carrying a non-empty ILLEGAL move would bypass the judge and could still report PASS in
report-only mode. Fixed by separating the two questions - any non-empty move is judged always, and
`--require-move` independently requires success AND a passing verdict. Rollout then approved.

---

## S-TIEBREAK (`b4c2b191`) - THE MEASUREMENT, done 2026-07-30

This is the "one thing to measure before writing the threshold in" from the section above. Done, and
it did not come out the way either candidate explanation predicted.

### The eval scale is NOT centred, and it is board-size dependent

`scripts/bgs-engine-probe.ts --scenario band --values 1000`, fresh symmetric `standard` opening,
THREE separate engine processes per board (each with its own random `--seed`, so each gets its own
root Dirichlet noise), against the shipped binary and the production model.

| board          | mover's eval, 3 runs      | spread | move       |
| -------------- | ------------------------- | ------ | ---------- |
| 6x6 (padded)   | -0.6050, -0.6051, -0.6050 | 0.0001 | `Ca5.>a1`  |
| 8x8 (padded)   | -0.8264, -0.8270, -0.8272 | 0.0008 | `>a2.>a1`  |
| 12x10 (NATIVE) | +0.7627, +0.7652, +0.7631 | 0.0025 | `Cb10.>b1` |

1. A perfectly symmetric opening reads nowhere near zero on ANY board, and **the sign flips with
   board size**. The value head is not a calibrated "who is winning" number; it carries a large
   board-size-dependent offset. Consistent with what `shared/domain/custom-setup-verdicts.ts` already
   says: the engine contract promises only a number in [-1, +1] and says nothing about calibration.
2. The padding hypothesis is only PARTLY supported. The native size is the odd one out, so padding
   does shift things - but every size is extreme, so the earlier -0.83 on 8x8 was not merely an
   artefact of a board nobody plays. 8x8 is a recommended size for all three bots.
3. Repeated fresh processes agree to within 0.003, so these are not noise. Do NOT generalise to "the
   eval is deterministic": `custom-setup-verdicts.ts` records a kept puzzle reading 0.691 / 0.715 /
   0.757 across three independent evaluations. Different position, and 5000 samples at parallelism 128
   rather than 1000 at 32. The spread is position- and config-dependent.

### Where -0.9 actually sits for real puzzles: almost exactly at the median

This needed no engine run at all. `shared/domain/generated-custom-setup-verdicts.json` holds 48
candidate 6x6 `custom-setup-standard` positions evaluated offline at **PuzzleBot's exact production
configuration** (`samples=5000 parallel=128`). 36 kept. Half are `mover:1` and half `mover:2`, so the
stored P1-perspective number goes through `moverEvaluation` first.

Kept puzzles, from the MOVER's perspective (the mover is the human solving it):

    n=36   min 0.757   p25 0.874   median 0.912   max 0.992

The bot plays the other side, so at a puzzle's start position **the bot's own eval is -0.757 to
-0.992, median -0.912**. Against Nil's -0.9:

- **21 of 36 (58%)** are already at or below -0.9 at the start, so the fallback fires from the bot's
  first move. That is exactly Nil's stated intent.
- **15 of 36 (42%)** sit between -0.757 and -0.9, so the bot keeps searching at full strength until
  the human makes progress and the eval crosses the line.

So -0.9 is neither a no-op nor always-on; it lands essentially ON the corpus median. The earlier
worry that -0.9 might be only 0.07 away from ordinary play does not apply to puzzles.

### The design question the measurement raises, and the answer to implement

It DOES apply to ordinary games. The BGS adapter serves all three bots, and on 8x8 an even position
already reads -0.827 for the mover - so a Superhuman or Easy game where the bot is merely somewhat
behind could cross -0.9 and start playing naive moves in an ordinary game, with no "the human is
solving a puzzle" story to justify it.

Board task `b4c2b191` is titled "...so PuzzleBot loses gracefully", and every line of Nil's design
note is about puzzles and humans making mistakes. So: implement the threshold as a **per-process
engine flag defaulting to OFF**, enabled at -0.9 for `dw-puzzle` only - exactly the
`--root_noise_factor` pattern from S-SAMPLES. Superhuman and Easy are then untouched by default, and
turning it on for another bot later is a config edit rather than a code change. Put to Nil with the
numbers; proceeding on that assumption because it is the reading that matches the task title, and it
is the choice that cannot surprise anyone.

### Still to measure, and it needs a probe extension

The probe cannot build a custom initial state, so it cannot yet evaluate a real puzzle position or
follow one. Missing:

- The eval TRAJECTORY through a puzzle: does it fall as the human converts, and does it climb back
  above -0.9 when the human errs? **The whole design depends on that recovery, and nothing measured
  so far demonstrates it.**
- How low the eval goes in ordinary 8x8/12x10 games where the bot is merely losing.
- Whether `SimplePolicy`'s argmax actually produces the moves Nil considers graceful. Only he can
  judge that, and it needs a real playtest.

---

## S-TIEBREAK SHIPPED AND PRODUCTION-VERIFIED (`d85d880`, 2026-07-30). CLUSTER COMPLETE.

Board task `b4c2b191` done, and with it all three of Nil's cluster. Same transport-branch process; main
was fast-forwarded to the exact validated SHA and both temporary branches are deleted.

PuzzleBot runs `--samples 5000 --parallel_samples 128 --thread_pool_size 4 --losing_fallback
--losing_fallback_eval -0.9`. Superhuman Bot and Easy Bot pass neither flag.

### The reviewer caught a real hole: "-1.0 is effectively off" was FALSE

The first version of this made `losing_fallback_eval` a plain `float` defaulting to -1.0, described in
three places as effectively disabled. `MCTS::root_value()` reaches exactly -1.0 whenever every sample
ends in a loss, and the condition is `<=`, so the feature WOULD have fired for Superhuman and Easy in
precisely the positions where the config guard and the docs both claimed it was off. I had noticed that
-1.0 is reachable while choosing the default, decided firing there was harmless, and then wrote
"effectively off" anyway - so the code and the claim disagreed, and every downstream argument was built
on the claim.

Fixed the way this repo's own rules already say: **no sentinels, use an optional.**
`std::optional<float>` in the config plus a separate `--losing_fallback` switch, so no number can mean
"on". The comment names the -1.0 boundary so nobody re-introduces a numeric sentinel by simplifying it,
and there is a test at exactly -1.0: disabled must be byte-identical to search, explicitly enabled must
take the naive path.

The reviewer's second round caught the CLI help overstating the contract. It is ASYMMETRIC on purpose:
`--losing_fallback` alone is fine and uses the -0.9 default, while an explicit `--losing_fallback_eval`
without the switch is REFUSED at startup - a command line that looks configured and does nothing is the
same silent-downgrade shape as a bot with no engine command.

### The three flag-contract checks, run before anything else

| launch                                          | result                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| no fallback flags                               | starts, logs `losing_fallback=off`              |
| `--losing_fallback --losing_fallback_eval -0.9` | starts, logs `losing_fallback=-0.900000`        |
| `--losing_fallback_eval -0.9` alone             | **refuses, exit 1**, with the explanatory error |

The first row was the one that mattered: if `gflags`' `is_default` had misfired, the new fail-closed
check would have been a hard startup failure for the two bots that must not have this feature. The
second row also settled a question flagged as unproven at the diff gate - gflags DOES consume a
space-separated NEGATIVE value, so `--losing_fallback_eval -0.9` parses as -0.9 and the `=` form is not
needed.

A harness lesson from those checks: feeding the engine `< /dev/null` makes it hang until the timeout,
because a character device is not pollable and `AsyncPipeReader` never sees EOF. Use a real pipe. The
engine is fine - the A/B/C runs below used a pipe and exited 0 naturally.

### Process evidence: the threshold as the lever, not a contrived position

The probe cannot build a custom-setup position, so rather than inventing a lost board, three runs held
the position (8x8 standard opening), the seed (777) and the sample count (1000) fixed and moved only the
threshold:

| run | flags                                           | bestMove  | fires?            |
| --- | ----------------------------------------------- | --------- | ----------------- |
| A   | none (the shipped default)                      | `>a2.>a1` | -                 |
| B   | `--losing_fallback --losing_fallback_eval 0`    | **`Cc8`** | yes, -0.827 <= 0  |
| C   | `--losing_fallback --losing_fallback_eval -0.9` | `>a2.>a1` | no, -0.827 > -0.9 |

`Cc8` is the cat walking two cells toward its goal: the naive policy, end to end in the shipped binary,
choosing a move the search does not. C is production's exact threshold and reproduces A, which is the
process-level confirmation of the scoping argument - at the number production runs, an ordinary 8x8
position is left to the search.

Precision about those evals (-0.8279 / -0.8271 / -0.8275): the MOVES are identical between A and C, but
the eval varies in the fourth decimal at the same seed, so the search is NOT bit-deterministic across
processes. That matches the 0.0008 spread measured earlier and is not claimed otherwise.

### Build and unit gates at the candidate SHA

- `make -j6 deep_ww_bgs_engine unit_tests` - clean, only the pre-existing folly `MPMCQueue` warning.
  This build was the first compile of ANY of `bgs_engine_main.cpp` for this slice, because that file is
  in neither `core` nor `unit_tests` - so a `unit_tests`-only pre-gate build proves nothing about flag
  code. Worth remembering: it is the only file where the flags live.
- Targeted, each exit 0: `[naive]` 6 cases, `[dispatcher]` 7, `[BGS MCTS]` 9, `[BGS Session]` 7.
- Full suite: **102 cases** (96 + 6 new), 95 passed, 6 failed + 1 as expected, and the six matched the
  recorded baseline BY NAME. No additions, no substitutions.
- Band sanity pass unchanged from the S-SAMPLES after-state, so neither slice moved the other.

### Production rollout

- Live-game check by CONJUNCTION: four games showed `status: "in-progress"`; all four had the human
  `connected: false` AND were 12, 194, 287 and 294 minutes stale. The 12-minute one was worth a second
  look - a guest who made ONE move, left within six seconds, and had been disconnected since. Abandoned,
  not interrupted (task `ce4434fc`).
- Preflight run on the DESKTOP against the file the client actually reads: VALID, and the dw-puzzle line
  showing both flags.
- Restarted keepalive-first, keepalive confirmed present before the kill.
- Verified from a log byte offset captured beforehand: `Engine started` for all three, then
  `Successfully attached with 3 bot(s)`.
- All three engines proved to be inode **41691** with `stat -L`, matching the file on disk, and their
  `/proc/<pid>/cmdline` confirms the scoping in production: only the `--samples 5000` process carries
  `--losing_fallback --losing_fallback_eval -0.9`.
- Full ROUND TRIPS green on all three: PuzzleBot `asANkzJb`, Easy Bot `-vwMNuUO`, Superhuman Bot
  `PSu6RmwV`.

### Two things the rollout revealed, neither a blocker

1. **The bot client does not capture engine stderr.** Nothing matching `bgs_engine_main` appears in
   `~/logs/bot-client-transformer.log`, so an engine's own startup line - including the new
   `losing_fallback=` state - is NOT readable from the client log. The effective state in production is
   therefore established in two steps rather than one: `/proc/<pid>/cmdline` shows the exact argv, and
   the three direct launches above show what that argv produces. Worth knowing that engine-side
   diagnostics are invisible there; it is adjacent to task `5f302c24`.
2. **A restart replays every abandoned game.** Straight after the restart the log shows
   `Applying move ... at ply 57/58/59/60` for `HxJPf_or` in under a second - a resync rebuilding the tree
   for a game whose human left three hours earlier. Exactly the cost task `ce4434fc` describes.

### The one thing that is NOT verified, and cannot be by a probe

Whether the naive moves FEEL graceful rather than broken is Nil's judgement and needs him to play a
puzzle. Everything above shows the bot answers, answers legally, answers differently when the threshold
fires and identically when it does not. None of that is "it stopped feeling broken". Handed to him as a
playtest ask.

---

## Reviewer rulings (plan gate, 2026-07-30) - BINDING

Full gate and amendment rulings from Project Reviewer 1. Recorded here because their session is
cleared between gates and this file is the only durable record.

### Approved

- S-SAMPLES and S-CONC approved to implement. **S-TIEBREAK is NOT approved for code** - it needs a
  measurement pass and a second plan gate first.
- S-CONC as ONE slice / ONE commit for D1-D4: they share one lifetime invariant and one rollout,
  and splitting them would leave known memory-safety holes in the same component.
- The `blockingWait` calls inside MCTS stay out of scope, on the condition that the doc records that
  this depends on `BatchedModel` retaining independent worker threads. It does; noted above.
- The dispatcher extraction is justified, with stronger requirements (below).

### Certainty language I had to soften, and did

- **Board-size independence of the samples threshold is NOT established.** 112 working on both 5x5
  and 12x10 only proves both thresholds are <= 112. The depth-two mechanism is established; the
  claim "does not depend on board size" is not, and has been removed.
- **D2 is a hazard, not an observed corruption on every call.** A cache hit can complete inline, and
  a suspension may happen to resume on the same worker, so the UB is conditional on the continuation
  landing elsewhere. Phrased as a hazard on every evaluate path that can suspend.
- The prior fallback "cannot fire" at 1000/5000 samples became "does not fire in the measured
  production positions" - it is not a structural impossibility.

### Corrections to my design

- **`peek_best_move` cannot return a complete move at ZERO samples** and must keep returning
  nullopt there. With no root child there is no second position to read a policy from without
  evaluating and creating a node, which would mutate the tree and break the read-only scope. The
  planned "complete move after 0 samples" test is deleted. Zero-sample `peek_best_action` still
  falls back to max prior.
- **Root Dirichlet noise cannot be waved away.** I cannot call samples=1 "truly policy-only" while
  25% of the root prior is noise, and the plan cannot say both "approximate" and "in the literal
  sense". Ruling: add a per-process `--root_noise_factor` flag defaulting to the current 0.25,
  validated finite and in [0,1], plumbed into `MCTS::Options`, and set to 0 for **dw-easy only**.
  Pin samples=1 AND root noise=0 in the production config test. The shared default is untouched, so
  Superhuman and PuzzleBot are unaffected.
- **The greedy per-action tie-break is not approved.** The user-visible object is a full move, and a
  first action with an attractive immediate score can block a much better second action while the
  5000-sample tree already contains the grandchildren. The discovery pass must compare full-move
  resistance against the per-action shortcut; one-action scoring is only for a genuine `Turn::Second`
  custom setup.
- **S-TIEBREAK option B (replace the ranking key when lost) is rejected for now.** A root judged
  lost does not make the visit distribution valueless - visits still encode policy and downstream
  evidence, and replacing them can select an unsearched, near-zero-prior action and discard 5000
  samples. Option B also does not avoid magic, it just moves all the judgement into one root
  threshold. Direction is A-like: keep search as primary evidence, use resistance only among
  outcomes that are demonstrably indistinguishable.

### Process amendments

- **The baseline needs an EXACT-SET gate, not a count.** A fixed old failure plus a new regression
  also totals six. Compare the exact six names, and run newly added cases separately requiring exit 0.
- **Two-stage gate for every C++ slice.** Bring the uncommitted diff first; diff sign-off authorises
  the candidate commit/push ONLY. Then pull that exact SHA on the desktop, compile, run the targeted
  tests plus the exact-set baseline, run the offline process probes, and return that evidence for a
  separate ROLLOUT sign-off before any production bot restart. A compile failure means stop - not
  rewriting pushed history. A corrective commit gets its own focused recheck.
- **Deadlock regressions must be time-bounded.** A unit test that calls an unbounded `drain()` can
  hang the whole gate forever. Bounded wait inside, external `timeout` outside, and a timeout is
  reported as a failure.
- **The probe corpus must live somewhere durable**, not in `/tmp`. Hence
  `scripts/bgs-engine-probe.ts`.
- S-SAMPLES probes must parse the returned notation and prove both actions are legal under
  production rules, not merely assert a non-empty string.
- S-TIEBREAK measurement must use fresh bgsIds across repeated engine processes, because root
  Dirichlet noise is seeded from the bgsId - repeating one id looks stable by construction. It must
  also show that the resistance metric actually orders the moves Nil considers graceful, rather than
  assuming a distance ratio is a perceptual proxy.
