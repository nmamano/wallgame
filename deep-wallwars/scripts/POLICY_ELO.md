# Policy Elo planner and runner

`policy_elo_plan.py` reads the condition registry, every configured evidence
source, the model inventory, and a measured loadability map. It emits only the
pairings that still need clean games. Unsupported artifacts remain in the plan as
explicit unavailable evidence; they never reach the runner.

Each loadability row must name the probed input contract and carry both the exact
model SHA-256 and engine SHA-256. Planning stops if a probe belongs to a different
artifact or engine. Both endpoints of every planned edge must have a current
supported probe.

If the base and extension directories contain different artifacts for one
generation, planning stops. An operator can select the extension artifact only
with both `--prefer-extension-duplicates` and a recorded `--duplicate-reason`.

The plan freezes SHA-256 hashes for the engine, benchmark, condition registry,
loadability map, and every model. The runner verifies all of them before it starts
an engine process.

`policy_elo_batch.py` gives each benchmark invocation an immutable attempt journal,
new engine seed, and balanced even game count. It imports all complete rows from
old journals before it plans a replacement attempt. A torn final row is preserved
under the experiment's `torn/` directory and is never accepted. A malformed
complete row stops the batch.

Every completed game is immediately written and fsynced to either `accepted/` or
`quarantine/`. No-legal-move outcomes and legality errors can never enter the
accepted index. Stable game identities deduplicate retries, and a duplicate ID
with different content stops the batch. Each runner invocation appends its own
start/completion or failure history under `run-attempts/`; reruns do not overwrite
earlier history.

The benchmark and both engine grandchildren run in one new process group. Any
parse, archive, cancellation, or benchmark failure terminates that full group.
Attempt metadata fixes the engine seed, submitted game range, Random Start seed
type, and alternating seats; recovery rejects a journal that mixes those values.

The app snapshot builder is the federated fit reader. It combines the enriched
canonical archive with the legacy and phase7 sources registered in
`policy_elo_conditions.json`. Thus, reused clean evidence remains part of the fit
without copying or rewriting its immutable source journals.
