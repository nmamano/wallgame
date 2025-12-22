# Premove feature

Premoves are a local-only feature.

It allows users to pre-stage actions during the opponent's turn.

As soon as it's your turn, pre-staged actions become automatically staged. If the max number of actions is staged (2), then they are comitted into a move.

Semantically, premoves can be seen as: "as soon as the opponent moves, I made these actions instantly." That means premove legality is re-checked at execution time, not just at queue time.

Mental model: premoves are a queued intent for the next move, not a prediction of future board states.

Always respect the rules in `.cursor/rules/basic-rules.mdc`.

## Semantics

- The "Finish move" button cannot be premoved.
- The "Clear staged actions" button works for premoved actions.
- The visual of the actions (walls and pawn moves) should clearly indicate when actions are premoves.
- Premoved actions must be "locally legal" - Legal if the opponent just skipped their next move. When the opponent move comes, premoved actions may become illegal. Those don't get staged, they get removed.
- You can only premove actions for the next move (i.e., up to 2 actions). You can't queue additional actions for future moves. 
- Like normal moves, premoves cannot be made when viewing move history. Like normal staged actions, premoves are not cleared when viewing move history. If you go back to a previous move and then back to the present, the present will still have the premoved actions. If an opponent move comes in while you are viewing a past move, the premoves automatically become staged, and maybe even an actual move if the conditions are satisfied.
- Premoves should be cleared on game end.
- The server must ensure that at least 0.1s pass for each player's move.

## Invariants

Local-only: premoves never change server state and are never sent over the wire.

Scope: a premove is only for the next move and contains at most 2 actions total.

No history editing: while viewing move history, you cannot add/remove/modify premoves.

Persistence across history: navigating into history does not clear premoves; navigating back to present shows the same queued premoves (unless they have been promoted/dropped due to game updates).

Local legality at queue time: the premove queue must always represent a set of actions that would be legal to stage right now if it were your turn (max-actions and per-action legality), given the current position.

Revalidation at execution time: when it becomes your turn (typically after an opponent move arrives), queued premoves are rechecked against the new current position; any illegal queued actions are removed, legal ones become staged.

Sequential legality: legality during promotion is evaluated against the current position plus the already-accepted promoted actions in that same promotion pass.

Atomic promotion: promotion from premove to staged happens in one controller step with a deterministic order (the order the user queued them).

Auto-commit: if after promotion staged reaches 2 actions, it auto-commits as a move. The Finish Move button itself is not premovable.

Clear semantics: "Clear staged actions" clears both staged and premoved actions.

Game end: premoves are cleared on game end (and on any full reset/resync that discards local intent).

Minimum move time: any auto-committed move resulting from premoves still respects the server-enforced minimum 0.1s per player move.

Stable ordering: the premove queue has a defined order (the order the user entered actions), and that order is preserved.

Deterministic application: when promoting premoves at turn start, apply actions in that preserved order. If an action becomes illegal given the current position plus the actions already accepted in this promotion pass, drop it and continue. Do not reorder to "make it work."

No rule duplication: there must be exactly one source of truth for "is this action legal to stage given the current position and already-queued actions." Premoves and normal staging must both use it.

No state cloning / fake turns for validation: do not validate premoves by cloning game state, flipping turn, and simulating moves. Validation is per-action against the real current position plus queued actions.

No bypassing the commit pipeline: auto-commit from premoves must go through the same commit path as the normal UI (same gating, same timers, same server constraints). Do not call a special commit that skips checks.

Premove is visually unique: premove visuals must be distinct from any existing hover and staged preview states.

UI contracts stay honest: do not hack button enablement by passing combined arrays to satisfy a length check. Expose an explicit boolean/count for "has pending local actions" and clear both staged and premoved in one handler.

Turn-start detection uses capability, not identity: promotion should trigger on the transition from "cannot act" to "can act" (your existing derived predicate), not brittle checks like turn === activeLocalPlayerId that can change in local modes.

Promotion is atomic: do not stage premove actions one-by-one in a way that causes transient UI states (or partially commits) mid-promotion; compute the result in a single controller update.

Acting capability invariant: premove promotion triggers exactly when the local player transitions from “cannot legally act” to “can legally act”, regardless of game mode (local, bot, friend, spectator, replay resolution).

## Suggestions, not mandatory

- It may be cleaner to stage both premoves at once, instead of sequentially, to avoid weird intermediate steps.
- Make the premove state machine explicit and testable. 
