# Wall Game deployment

Production runs on a VPS with Docker, Caddy and PostgreSQL since 2026-10-05.
The live site is https://wallgame.io.

Operators must read the local `ops-private/wallgame-vps-production-20261005.md`
runbook for access, logs, drain, migration and restart rules. Deployment and
production writes require Nil's explicit approval. Run `bun run migrate` only
with the intended database selected and the applicable approval.

Production moved from Fly/Neon to the VPS on 2026-10-05; Fly was deleted on 2026-10-25 and Neon on 2026-11-01.
