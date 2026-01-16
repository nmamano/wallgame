# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `.cursor/rules/` for general agent rules and `/info/` for detailed design documentation.

## Project Overview

Wallgame is a real-time multiplayer strategy board game with:

- Local play, online multiplayer with matchmaking, spectator mode, game replay
- Rankings, puzzle challenges, and solo campaigns
- Advanced AI powered by MCTS + neural networks (Deep-Wallwars engine)
- Custom bot integration via WebSocket protocol

## Monorepo Structure

```
wallgame/
├── frontend/                 # React 19 web application
├── server/                   # Hono backend (API + WebSocket)
├── shared/                   # Shared TypeScript (contracts + domain logic)
├── deep-wallwars/            # C++ AI engine + Python training pipeline
├── dummy-engine/             # Reference bot implementation
├── official-custom-bot-client/  # Bot integration client
├── tests/                    # Integration tests
├── drizzle/                  # Database migrations (SQL)
├── scripts/                  # Build & migration scripts
├── assets/                   # Game assets, fonts, models
└── info/                     # Design documentation (26 .md files)
```

## Commands

```bash
# Development
bun run dev                    # Start backend server (port 3000)
cd frontend && bun run dev     # Start Vite frontend (port 5173)

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

For Deep-Wallwars build and training instructions, see `info/deep-wallwars-integration.md`.

**Development ports:** Frontend on 5173 proxies API/WebSocket to backend on 3000. Always use port 5173 for development.

## Subprojects

### Frontend (`frontend/`)

React single-page application for the game UI.

**Tech:** React 19, Vite, TanStack Router, TanStack Query, Tailwind CSS v4, Radix UI, Lucide icons

```
frontend/src/
├── routes/          # TanStack Router file-based pages
├── components/      # React UI components (26 directories)
├── hooks/           # Game orchestration hooks
├── lib/             # Controllers, game client, utilities
├── game/            # Local game state logic
├── types/           # TypeScript interfaces
└── assets/          # Images, icons
```

**Key files:**

- `src/main.tsx` - Application entry point
- `src/hooks/use-game-page-controller.ts` - Main game orchestrator
- `src/hooks/use-online-game-session.ts` - WebSocket handshake
- `src/lib/controllers/` - Player controller implementations

### Server (`server/`)

Hono-based backend handling HTTP API, WebSocket connections, and game sessions.

**Tech:** Hono on Bun, PostgreSQL with Drizzle ORM, Kinde OAuth

```
server/
├── index.ts         # Main entry point (Hono setup)
├── kinde.ts         # OAuth authentication
├── routes/          # Hono API route handlers
├── db/              # Database layer
│   └── schema/      # Drizzle schema definitions
├── games/           # Game session management
│   ├── rating-system.ts
│   ├── persistence.ts
│   └── custom-bot-store.ts
└── chat/            # In-game chat features
```

### Shared (`shared/`)

TypeScript code shared between frontend and server.

```
shared/
├── contracts/       # API types with Zod validation
│   ├── websocket-messages.ts   # Game state updates, move commands
│   ├── custom-bot-protocol.ts  # Engine integration API
│   ├── games.ts, user.ts, ranking.ts, etc.
└── domain/          # Game rules & logic
    ├── game-state.ts           # Board state representation
    ├── game-utils.ts           # Move validation
    ├── classic-setup.ts        # Game variant configs
    └── dummy-ai.ts             # Simple AI implementations
```

### Deep-Wallwars (`deep-wallwars/`)

Advanced AI engine using Monte Carlo Tree Search with neural network evaluation.

**Tech:** C++17, CMake, CUDA, TensorRT, Python (PyTorch + FastAI for training)

```
deep-wallwars/
├── src/             # C++ source files (25+ files)
│   ├── game/        # Game logic
│   ├── mcts/        # Monte Carlo Tree Search
│   └── nn/          # Neural network integration
├── scripts/         # Python training scripts
│   └── training.py  # Main training orchestrator
├── models_*/        # Trained models (.pt, .onnx, .trt)
└── data_*/          # Self-play game data (CSV)
```

**Training loop:** Self-play (C++ MCTS) → CSV data → PyTorch training → TensorRT export

### Dummy Engine (`dummy-engine/`)

Reference bot implementation demonstrating the bot protocol.

**Tech:** Pure TypeScript/Bun (no dependencies)

Compiles to standalone executable. Simple AI that walks toward goal.

### Official Custom Bot Client (`official-custom-bot-client/`)

WebSocket client for connecting external bot engines to the game server.

**Tech:** TypeScript, Zod

```
official-custom-bot-client/src/
├── index.ts         # Main entry point
├── ws-client.ts     # WebSocket protocol
├── engine-runner.ts # External engine process management
└── dumb-bot.ts      # Fallback implementation
```

### Tests (`tests/`)

Integration and game logic tests.

```
tests/
├── integration/     # Integration test suites
└── game/            # Game logic tests
```

Run with `bun run test` (uses WSL).

### Database (`drizzle/`)

Drizzle ORM migrations. 15+ SQL migration files.

Schema defined in `server/db/schema/` (users, games, ratings, puzzles, etc.)

## Architecture

### Controller-Centric Game Flow

The core pattern abstracts transport differences between play modes:

- **GamePlayerController interface** - Unified API for all seat interactions
  - `LocalHumanController`: UI-driven local players
  - `RemotePlayerController`: Online players via WebSocket
  - `EasyBotController`: AI opponents
  - `SpectatorController`: Read-only viewing

- **Seat registries:**
  - `seatActionsRef`: Maps PlayerId → Controller (controllable seats)
  - `seatViewsRef`: Seat metadata (name, avatar, connection status)

### Data Flow

```
Frontend (React)
    ↓ WebSocket / HTTP
Server (Hono)
    ├→ PostgreSQL (Drizzle ORM)
    ├→ Bot Client → Deep-Wallwars Engine (AI)
    └→ Shared Domain (game rules)
```

### Key Design Decisions

1. **Transport-agnostic UI:** Controllers hide whether moves are local or networked
2. **Server-authoritative:** Online games wait for server confirmation before applying moves
3. **Spectator-first:** Spectator path is a first-class flow, not an error fallback
4. **History as pure snapshot:** `buildHistoryState()` creates immutable snapshots; `historyCursor` (null = live, number = ply index)
5. **Seat credentials:** Server mints ephemeral `{token, socketToken}` pairs per seat

## Code Style

- Use Bun, not npm
- Architecture-first: no backwards compatibility hacks needed
- Type-driven: prefer required fields over optionals
- Explicit over implicit: avoid race conditions with clear state transitions
- All frontend-server boundary types go in `shared/contracts/` with Zod schemas

## Documentation

See `/info/` for detailed design docs including:

- `architecture.md` - System design overview
- `deep-wallwars-integration.md` - AI engine integration
- `bot_protocol_3.md` - Custom bot communication protocol
- `universal_model.md` - Latest training model documentation

## Deployment

- **Platform:** Fly.io (https://wallgame.fly.dev)
- **Database:** Neon PostgreSQL
- **Config:** `fly.toml`, `Dockerfile`
- **Migrations:** Auto-run via `release_command` in fly.toml
