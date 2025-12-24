# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See .cursor/rules/ for general agent rules.

## Project Overview

Wallgame is a real-time multiplayer strategy board game (cats vs mice) built as a TypeScript monorepo. It supports local play, online multiplayer with matchmaking, spectator mode, game replay, rankings, and puzzle challenges.

## Commands

```bash
# Development
bun run dev                    # Start backend server (port 3000)
cd frontend && bun run dev     # Start Vite frontend (port 5173) - use this for development

# Build & Deploy
bun run build                  # Build frontend (tsc + vite)
bun run migrate                # Run Drizzle database migrations

# Code Quality
bun run format                 # Format with Prettier
bun run lint                   # Lint with ESLint (auto-fix)

# Testing & CI
bun run test                   # Run tests (uses WSL)
bun run ci                     # Full CI: format check, lint, test, build
```

**Development ports:** Frontend dev server on 5173 proxies API/WebSocket to backend on 3000. Always use port 5173 for development.

## Architecture

### Tech Stack

- **Frontend:** React 19, TanStack Router, TanStack Query, Tailwind CSS v4, Radix UI
- **Backend:** Hono on Bun, PostgreSQL with Drizzle ORM, Kinde auth
- **Shared:** Zod schemas for API contracts in `shared/contracts/`

### Project Structure

```
frontend/src/
  routes/        # TanStack Router file-based pages
  components/    # React UI components
  hooks/         # Game orchestration hooks
  lib/           # Controllers, game client, utilities
  game/          # Local game state logic

server/
  routes/        # Hono API handlers + WebSocket
  db/            # Drizzle schema and queries
  games/         # Game session management

shared/
  contracts/     # API types with Zod validation (frontend-server boundary)
  domain/        # Game rules, state, grid logic
```

### Controller-Centric Game Flow

The core architectural pattern abstracts transport differences between play modes:

- **GamePlayerController interface** - Unified API for all seat interactions
  - `LocalHumanController`: UI-driven local players
  - `RemotePlayerController`: Online players via WebSocket
  - `EasyBotController`: AI opponents
  - `SpectatorController`: Read-only viewing

- **Key hooks:**
  - `use-game-page-controller.ts`: Main orchestrator owning game state and `historyCursor`
  - `use-online-game-session.ts`: WebSocket handshake and spectator setup
  - `use-meta-game-actions.ts`: Draw offers, takebacks, resign, chat

- **Seat registries:**
  - `seatActionsRef`: Maps PlayerId → Controller (controllable seats only)
  - `seatViewsRef`: Seat metadata (name, avatar, connection status)

### Key Design Decisions

1. **Transport-agnostic UI:** Controllers hide whether moves are local or networked
2. **Server-authoritative:** Online games wait for server confirmation before applying moves
3. **Spectator-first:** Spectator path is a first-class flow, not an error fallback
4. **History as pure snapshot:** `buildHistoryState()` creates immutable snapshots; `historyCursor` (null = live, number = ply index)
5. **Seat credentials:** Server mints ephemeral `{token, socketToken}` pairs per seat; all WebSocket actions verified against session tokens

## Code Style

- Use Bun, not npm
- Architecture-first: no backwards compatibility hacks needed
- Type-driven: prefer required fields over optionals
- Explicit over implicit: avoid race conditions with clear state transitions
- All frontend-server boundary types go in `shared/contracts/` with Zod schemas
