---
name: past-games-feature
description: Persist remote games and serve replay/past games via GET /api/games/:id
---

# Plan

Implement persistence for completed remote games keyed by nanoid, add replay fallback to GET /api/games/:id, and add a past-games list endpoint with DB filtering and pagination. Fix timer start so clocks begin on the first move and use that timestamp as started_at.

## Requirements
- Persist only remote friend/matchmaking games (no local, no bots).
- Game IDs are nanoid strings used in URLs and stored in the DB.
- started_at is first move time; fix timer to start on first move.
- Persist rating_at_start and current domain outcome_reason values.
- GET /api/games/:id returns live session data when present; otherwise returns replay with kind:"replay" and serialized state built from DB.
- Views increment only when replay is served.
- Past-games list endpoint supports filters and pagination with DB-level filtering, moves_count >= 2, and Guest 1/Guest 2 naming.

## Scope
- In:
  - DB migration for nanoid IDs, match_type, and player_role fields.
  - Persistence module and wiring on game finish.
  - Replay fallback in GET /api/games/:id.
  - Past-games list query and route.
  - Integration tests and doc alignment.
- Out:
  - Local games and bots.
  - New replay endpoints or WebSocket replays.
  - Chat persistence and spectator counts.

## Files and entry points
- server/db/schema/games.ts
- server/db/schema/game-details.ts
- server/db/schema/game-players.ts
- drizzle/* (new migration)
- server/games/store.ts
- server/routes/game-socket.ts
- server/routes/games.ts
- server/db/* (persistence + queries)
- shared/contracts/games.ts
- shared/domain/game-state.ts
- shared/domain/standard-notation.ts
- tests/integration/*
- info/game_persistance.md

## Data model / API changes
- Change game_id columns in games/game_details/game_players to varchar for nanoid.
- Add games.match_type (friend/matchmaking).
- Add game_players.player_role (host/joiner).
- Keep game_players.player_config_type; set "you" for host, and "friend" or "matched user" for joiner based on match_type.
- game_details.config_parameters stores time control config (initialSeconds, incrementSeconds, preset if present) and variant parameters.
- Replay response returns GameSnapshot + SerializedGameState under kind:"replay" using stored moves and config.

## Action items
[ ] Fix timer start: set lastMoveTime on first move, and capture session started_at for persistence.
[ ] DB migration: update schema types and add match_type and player_role fields.
[ ] Persistence: add module to insert games/game_details/game_players in a transaction with idempotency; store rating_at_start and move notations.
[ ] Wire persistence on game end (move/resign/draw/timeout) before session cleanup.
[ ] GET /api/games/:id: if session not found, load from DB and return kind:"replay" with reconstructed state.
[ ] Integration test: replay fallback works for completed game (no live session).
[ ] Views: increment on replay response; add view-count assertion in integration test.
[ ] Past-games query endpoint: DB-level filters, pagination, moves_count >= 2, guest naming.
[ ] Integration tests for past-games endpoint filters and pagination.
[ ] Update info/game_persistance.md to match nanoid IDs, match_type/player_role, and outcome vocab.

## Testing and validation
- Integration: finish game, clear session, GET /api/games/:id returns replay with correct snapshot/state.
- Integration: views increment only for replay.
- Integration: past-games endpoint respects filters and returns correct counts.
- Manual: play remote game, reload URL after completion, verify replay renders.

## Risks and edge cases
- Duplicate persistence on multiple end triggers; guard with idempotency.
- started_at missing for games with < 2 moves (which are skipped).
- Custom time controls require config_parameters for reconstruction.
- Replay uses current user settings for appearance; historical appearance not stored.
- Player name filters require DB-level joins for correct pagination.
