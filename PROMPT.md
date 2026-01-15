@plan.md @activity.md @info/v3_migration_plan.md

We are implementing the V3 Bot Protocol Migration in this repository.

First read activity.md to see what was recently accomplished and the current state.

Open plan.md and find the SINGLE highest priority task where passes is false. Tasks are ordered by dependency - complete them in order.

Work on EXACTLY ONE task:

1. Read the detailed specification in info/v3_migration_plan.md for context on what to implement
2. Implement the changes described in the task steps
3. After implementing, verify your changes:
   - Run `cd frontend && bunx tsc --noEmit` for frontend type checking
   - Run `cd server && bunx tsc --noEmit` for server type checking
   - Run `cd shared && bunx tsc --noEmit` for shared type checking
   - Run `bun run lint` from root for linting
4. Fix any type errors or lint issues before marking complete

After verification passes:

1. Update that task's passes in plan.md from false to true
2. Append a dated progress entry to activity.md describing:
   - What you changed
   - Which files were modified
   - What verification commands you ran
   - Any notable decisions or issues encountered
3. Make one git commit for that task only with a clear message following the format:
   "V3 migration: [phase] - [brief description]"

Do not git init, do not change remotes, do not push.

ONLY WORK ON A SINGLE TASK PER ITERATION.

When ALL tasks have passes true, output exactly: <promise>COMPLETE</promise>
