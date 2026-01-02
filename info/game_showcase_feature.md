When the user is at the home page, there is a game showcase section.

It should work like this:

1. We pull a random game from the database.
  - Any finished game in the DB that would appear in the Past games page is eligible (any variant or board dimensions). The two features expose the same data.
  - Exception: filter out games with fewer than 10 moves.
  - If the same game is picked twice in a row by chance, that's fine. No need to do special handling for that.
2. We display it in the showcase.
  - Only the board component itself, not timers, move history, controles, etc. For that, you need to go to the actual replay.
  - We can display a little title `"Game showcase: <player1> vs <player2> (<date>)"` at the top of the showcase panel.
    - The date, names, and player pawn styles and colors are the same as displayed in the Past games page. That is: we use the player's name and pawn styles and colors as they were saved in the DB when the game was played.
3. The moves autoplay, at 1 ply per second.
  - There is a pause toggle in the showcase panel. It pauses move autoplay (and therefore also fetching new games).
4. When the game ends, a new random game is pulled from the DB, and we repeat.
  - Pause for 5 seconds at the ending position before pulling a new game.
5. Clicking anywhere on the showcase panel (other than the pause toggle) opens the game in the "replay" mode, similar as if we clicked on it from the past games list.
  - It opens at the same ply as when clicked.
6. Error handling:
  - If there are any issues, like not being able to fetch a game, the showcase panel shows an empty 8x8 board without any error message.
    - The component can retry every 60 seconds to see if the issue is resolved.
