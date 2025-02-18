---
layout: base.njk
title: Choosing a tech stack (WIP)
date: 2025-02-13
tags: posts
---

# Choosing a tech stack

One of the first choices for a new project is the tech stack. To choose, we should start from the features we need.

## Features

In this case, the easiest way to think about the feature set is that we are building a lichess (lichess.org) clone, except for a different game.

In particular, the two most distinguishing features are real-time games and the game AI (a.k.a. engine).

### Main features

- Real-time turn-based multiplayer games.
- Engine: high volume of runs involving MCTS and many ML model inferences.
- User accounts.
  - Ideally, supporting something like google log-in.
  - Mix of non-logged-in and logged-in users.
  - Goal: <= 2 clicks to start playing.
- Single player modes:
  - Puzzles.
  - Analysis board.
  - Play vs AI.
- Satisfying visuals and animations.
- Phone and tablet support.

### Minor features

- Different game settings.
- Settings with more than 2 players.
- Going back to see previous moves during a game.
- Find recent games.
- Find your history of past games.
- Multi-game matches.
- Leaderboards.
- ELO system (Glicko-2).
- Ability to spectate public on-going games.
- Lobby: people can broadcast if they are looking for someone to play (private games are also allowed).
- Match-making: pairing up players with similar ELO and same time control.
- Blog: e.g., for dev journaling--you are reading it.
- Presence indicator to know if your opponent left.
- Out-of-board interactions: resign, offer draw, request takeback, and increase the opponent's remaining time.
- Board highlights (ability to highlight things without making a move).

### Non-functional requirements.

- This app will be heavy on business logic (_both_ frontend and backend). E.g.:
  - the game logic requires graph algorithms like bridge detection.
  - premoves are frontend-only and tricky.
  - network time needs to be handled rigorously in the game clock management.
- Websocket support for real-time communication and broadcasting.
- WebAssembly support (for the engine (MCTS and model inference), which is implemented in C++).
- Simple DB schema. We probably just need 'game' and 'user' concepts.
- Small storage needs. All games should be stored but they shouldn't take much space.
- No media assets. We don't have to deal with heavy data like images or video.
- Tests.
- CD.
- Dev environment.

### Non-MVP features

All of these probably make sense, but that's a problem for future me.

- Allowing users to provide their own AIs. (No idea how this will work yet.)
- Mobile apps.
- Sound effects and music.
- Model training. This will be an offline process, and the model will be uploaded to the backend.
- Puzzle generation. This will be an offline process, and the puzzles will be uploaded to the DB.
- Tournaments.
- Keyboard support.
- User friend system.
- In-game chat.
- Ads.
- In-game purchases.
- Continue games from a different device/after closing the browser (logged-in users only).
- Light/dark theme.

# Goals for a stack

- Minimize dependencies.
- Simplicity.
- Avoid framework lock in.
- Avoid hosting provider lock in.
- Popular stack.
- Strong typing. Preferably with consistent types across frontend and backend.
- Focus on UX instead of UI.

Personal preferences:

- Not OOP or purely functional. I favor procedural programming with minimum side-effects.
- SQL DB, with no ORM if possible.
- Monolith over microservices.

Open questions:

- Is serverless viable? perhaps even better?

# Tech Stack 1: All-In On JS

The idea of this tech stack is to try to leverage the JS ecosystem as much as possible, by using it both in frontend and backend. The advantages are:

- Since the app is heavy in business logic, we can factor it out and reuse it across frontend and backend. This is the main reason.
- Frontend-backend communication may work better if they are implemented in the same language. (e.g., the websocket implementation).
- More personal experience (e.g., it's the language of the other wallwars, so I may be able to reuse stuff).
- It's the most popular so, I'm hoping I'll have an easier time finding already built solutions for things like authentication.
- Probably easier for LLMs to give good suggestions.
- Working with a language I can tolerate (TypeScript, not JS).
- Maybe in the future, the react frontend can become the basis for reactnative mobile apps.

## Components

After researching, this seems to be the state of things as of 2025
