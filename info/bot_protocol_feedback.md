We are simplifying the custom bot protocol. Please refactor the existing implementation to match the following model.

NEW MODEL (non-negotiable):

- The protocol is strictly REQUEST → RESPONSE.
- The server ONLY sends game state when it needs a decision from the bot.
- There are NO standalone state, turn, draw-offer, rematch-offer, or notification messages.
- Everything the server wants from the client is expressed as a request.

Server → Client:
- type: "request"
- requestId
- kind: "move" | "draw" | "rematch"
- full SerializedGameState (always included)

Bot → Server:
- type: "response"
- requestId
- action

Semantics:
- The client is idle unless there is an outstanding request.
- Each request represents a single decision window.
- The set of valid responses is fully determined by the request kind; the server rejects any response that does not match the request kind.
- If the client responds with an illegal action, the server sends a nack and the SAME request remains active.
- The server MAY issue new requests, which invalidate all prior ones:
  - for example, if the opponent offers a draw, and then makes a move, the draw request is invalidated

Important removals:
- Delete sendStateToBot, sendTurnToBot, sendDrawOfferToBot, sendRematchOfferToBot.
- Replace them with a single sendBotRequest(kind, payload).
- Remove moveCount / expectedMoveCount checks from the bot protocol layer. We can use requestId.
- No ordering dependencies remain because there is only one request message valid at a time.

Takebacks: No changes. Remain server-only.

Disconnect: No changes. Treated as resignation.

Please refactor the EXISTING implementation to follow this model.

At the end:
- List the remaining server→bot message types.
- List the remaining bot→server message types.
- Call out any protocol changes you believe are strictly necessary.
