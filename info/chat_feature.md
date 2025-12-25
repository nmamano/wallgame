## Channels

The chat has 3 "channels", which are always visible but may be disabled:

- the "game chat", seen by all the players but not the audience. It's disabled to spectators.
- the "team chat", seen only by players on the same team. Disabled in 1v1 variants. Only for variants where more than 1 player in the same team. It's disabled to spectators.
- the "audience chat", seen only by the audience. It's disabled to players.

Disabled means: the channel tab is clickable but read-only; the chat is grayed out with a message that explains why, like "Game chat is disabled for spectators."

When a spectator starts spectating, we don't need to load the history of messages that happened so far. The spectator can simply receive new messages in the "audience chat" as they happen.

The default chat opened when clicking the chat tab is the "game chat" for players and the "audience chat" for spectators.

## Features

- Plain text only. No markdown, no embeds, no images.
- make 'enter' in the input field send the message.

## UI

The UI is mostly done. It is missing:

- the Send button.
- highlighting the chat tab if a message comes in while the chat tab is closed, so the user visually notices it.

Message formatting:
- For logged in users: "Username": "Message".
- For guests: "Guest {index}": "Message".
- Don't do optimistic UI for sent messages. While waiting for server to respond, just add a visual indicator to the text input (like graying it out, making it unmodifiable) to signifiy that the message is being sent.

Guest indices start at 1, and increase for each new socket not connected to a logged in user (without reusing numbers if sockets are disconnected). Indexing is scoped per game session

Make the UI consistent with the move history component:

- same highlight style for incoming messages when chat is closed as for incoming moves when move history is closed.
- Chat tab highlight should ignore self messages
- the chat should auto scroll to the bottom when already scrolled to the bottom.
- the inner scroll bar should be hidden.

## Past games

Chat is not persisted to the database.

For past games, the entire Chat tab is disabled; that means the tab is clickable but read-only, but all the channels are disabled with a message like "Chat is not preserved."

## Moderation

We keep moderation minimalistic and deterministic.

- Rate limiting to 1 message per second per socket connection. For rate-limiting, don't use a package. This should be a simple per-socket in-memory check, not framework middleware.
- Max message length of 280 chars. The input field should not allow more than that.
- No need to be logged in to chat.
- Server-side blocklist for obvious slurs/spam patterns, with a generic error like "Message not allowed". Use the obscenity package.

When the server rejects a message, the UI should send a system message in red in the chat feed which is local only and only seen by the sender. It should say "Message not allowed" (moderation) or "Failed to send message" (default, server connection issues) or "Message too long" (if user somehow managed to send a message longer than 280 chars), depending on the server response.


## Claude plan feedback

1. Currently all variants are 1v1, but later we'll add variants with teams. So you must do the proper wiring: Team chat must exist and be enabled for variants with multiple players per team, and disabled only in 1v1 variants.

2. Don't do optimistic UI for sent messages. While waiting for server to respond, just add a visual indicator to the text input (like graying it out, making it unmodifiable) to signifiy that the message is being sent.

3. For rate-limiting, don't use a package, as that may not work well with websockets. This should be a simple per-socket in-memory check, not framework middleware.

4. For guest indexing, ensure indexing is scoped per game session.

5. Just to confirm: rejected user message is never echoed, and system messages are local-only and not broadcast
