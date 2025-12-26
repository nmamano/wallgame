# Music feature (v1)

## Scope of this doc

This document covers background music.

Context:

- Global sound policy exists
- Settings page exists
- Sound toggle is already wired and persisted
- SFX playback already works

Non-goals:

- No redesign of SFX
- No crossfades
- No volume sliders yet
- No new persistence mechanism

## Goals

- Play background music only on the game screen.
- Add a separate Music on/off setting in Settings.
- Keep music independent from SFX playback (different lifetime), but:
  - share browser audio unlock state
  - share the same persistence mechanism as SFX and dark mode (local storage)
- Keep implementation simple: one track at a time, sequential playlist.

## Settings & policy (new)

### New global setting

Introduce a new persisted global setting:

- musicEnabled: boolean

Rules:
- soundEnabled should be renamed to sfxEnabled. It is only for SFX.
- musicEnabled only gates background music.
- There is no master toggle.

### Persistence

- musicEnabled is persisted exactly like sfxEnabled:
  - saved locally for guests
  - saved to account for logged-in users
- Same load timing guarantees (no flash on page load).

### Settings UI

- Add a new toggle under Style:
  - Label: Music
- Behavior:
  - Toggle reflects musicEnabled
  - Toggling updates the global policy immediately

### Game page UI

Add the Music toggle to the same panel in the game page as the SFX toggle, next to each other.

### MusicController

- Lives in frontend/src/lib/music.ts
- Created when the game screen mounts
- Destroyed when leaving the game screen

Responsibilities:
- Play and pause music
- Track switching
- React to policy changes (musicEnabled)
- Clean up all audio elements on teardown

## Fetch / preload strategy

- Only one track plays at a time.
- Preload exactly one next track.

State:
- current audio element
- next audio element

Flow:
- Play current
- Preload next
- On track end, swap and continue
- Cycle through the playlist

## Integration with existing audio systems

- SFX system remains untouched.
- Music reads:
  - musicEnabled
- Music reacts to changes:
  - flag becomes false → pause immediately
  - flag is true → start or resume if game screen is mounted

## Autoplay / browser unlock

- Music must not introduce its own gesture listeners.
- Use the same audio unlocked signal already used by SFX.

Behavior:
- If audio is not unlocked yet, music waits.
- Once unlocked, music may start if policy allows.
- Music never blocks SFX or gameplay.

## Failure handling

- Music errors are isolated.
- Failed track → skip to next.
- No retries that block UI or gameplay.

## Out of scope

- Music volume slider
- Shuffle or random playback
- Crossfades
- Music outside the game screen
