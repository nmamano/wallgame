# TODO

- Finish move with 0 actions doesn't work.

## Backlog

### Spectator freeze when opening game URL directly

**Symptom:**
When Browser 3 opens `/game/:id` directly as a spectator (while a game is
in progress between two other players), the page becomes unresponsive.
The board shows "Waiting for another player to join before the match starts."
Navigating to the same game via the "live games" page works fine.

**Reproduction steps:**

1. Browser 1: Create a game (host)
2. Browser 2: Open the game URL and join
3. Browser 3: Open the same game URL directly (paste into address bar)
4. Expected: Browser 3 enters spectator mode, sees the live game
5. Actual: Page freezes, shows "Waiting for another player to join before
   the match starts", all clicks/interactions are unresponsive

**Known facts (from instrumentation):**

- The Radix Dialog `pointer-events: none` stuck on `<body>` is a SECONDARY
  symptom, NOT the root cause. Preventing the dialog from opening did not
  fix the freeze.
- The spectator websocket opens successfully (`spectator-client.ts` logs
  confirm this).
- `access` resolves correctly to `kind: "spectator"`, `lifecycle: "ready"`.
- `isReadOnlySession` transitions from `false` to `true` after access resolves.
- `isMultiplayerMatch` transitions from `false` to `true` after access resolves.
- The freeze persists even with no Radix Dialog opening at all.
- The "live games" page path works — the difference is that the game
  is already known to be in-progress before navigation, so the access
  resolve may complete faster or with different initial state.

**State transition timeline (from console logs):**

1. Initial render: `isReadOnlySession=false`, `isMultiplayerMatch=false`,
   `authoritativeLifecycle=null`
2. Radix Dialog opens (`matchingIsOpen=true` due to null fallback),
   sets `pointer-events: none` on `<body>`
3. ~200ms later: access resolves to `kind="spectator"`, `lifecycle="ready"`
4. `isReadOnlySession=true`, `authoritativeLifecycle="ready"`
5. `matchingIsOpen=false`, Dialog closes
6. Spectator websocket opens
7. Page remains frozen despite correct state transitions

**Code flow for spectator (key variables):**

- `hasLocalConfig = false` (no session storage for this game)
- `isRemoteFlow = true` (`shouldUseOnlineSession = !hasLocalConfig`)
- During loading: `access=null`, `accessKind=null`, `isSpectatorSession=false`,
  `isReadOnlySession=false`
- After resolve: `access={kind:"spectator",...}`, `isSpectatorSession=true`,
  `isReadOnlySession=true`
- `authoritativeMatchStatus` comes from `access.matchStatus` (for spectators)
- `isAuthoritativeWaiting = isRemoteFlow && !isReadOnlySession && (authoritativeLifecycle === "waiting" || authoritativeLifecycle == null)`
- `matchingPanelOpen` uses the same null fallback
- `matchingIsOpen = !isReadOnlySession && matchingPanelOpen`
- `boardShouldRender = isReadOnlySession || !isAuthoritativeWaiting`

**Tried and failed:**

1. Removing `authoritativeLifecycle == null` fallback from
   `isAuthoritativeWaiting` / `matchingPanelOpen` / `matchingCanAbort`
   — Broke the joiner flow. The board mounted then unmounted during
   loading because `isAuthoritativeWaiting` flipped `false→true`,
   causing `boardShouldRender` to flip `true→false`.
2. Adding `&& access != null` guard to `matchingIsOpen` (line ~3430)
   — Successfully prevented the dialog from opening during loading.
   No more `pointer-events: none` stuck on `<body>`.
   But the page STILL froze. This proves the freeze has a deeper cause.

**Key files:**

- `frontend/src/hooks/use-game-page-controller.ts`
  - Lines ~1576-1587: `isAuthoritativeWaiting`, `matchingPanelOpen`,
    `matchingCanAbort` definitions (with null fallback)
  - Line ~3430: `matchingIsOpen` definition
  - Lines ~3433-3434: `boardShouldRender` definition
  - Lines ~3405-3409: `waitingMessage` definition
- `frontend/src/components/matching-stage-panel.tsx` — Wraps Radix Dialog, receives `isOpen` prop
- `frontend/src/routes/game.$id.tsx` — Route component that renders MatchingStagePanel and board
- `frontend/src/components/ui/dialog.tsx` — Radix Dialog wrapper with animations
- `spectator-client.ts` — Spectator websocket client

**Next steps when revisited:**

- The freeze is NOT from pointer-events. Investigate what blocks
  interaction after the spectator websocket opens.
- Check if there's an overlay, invisible element, or z-index issue
  blocking clicks in the spectator path.
- Check if there's an infinite re-render loop (React Profiler or
  Performance tab).
- Check board component rendering when `isAuthoritativeWaiting`
  transitions from `true` to `false` for spectators.
- Instrument the route component (`game.$id.tsx`) to see what DOM
  elements are actually rendered on screen during the freeze.
- In frozen state, check DevTools Elements panel: what's at the
  click coordinates? Is there an invisible overlay?
- Use Chrome Performance tab to check if the main thread is blocked
  or if it's a layout/paint issue.
- Compare what differs between the "live games" navigation path vs
  the direct URL path — the former works, the latter doesn't.
