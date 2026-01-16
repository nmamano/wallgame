- Sometimes the showcase page doesn't show a game for a while.

<-- GET /api/games/showcase
Failed to fetch showcase game: 191 | return nextState;
192 | }
193 |
194 | private applyGameActionMutable(action: GameAction): void {
195 | if (this.status !== "playing") {  
196 | throw new Error("Game is not playing");
^
error: Game is not playing
at applyGameActionMutable (C:\Users\Nilo\repos\wallgame\shared\domain\game-state.ts:196:13)
at applyGameAction (C:\Users\Nilo\repos\wallgame\shared\domain\game-state.ts:190:15)  
 at <anonymous> (C:\Users\Nilo\repos\wallgame\server\db\game-queries.ts:224:31)  
 at forEach (1:11)
at <anonymous> (C:\Users\Nilo\repos\wallgame\server\db\game-queries.ts:221:9)

--> GET /api/games/showcase 500 153ms
<-- GET /api/games/showcase
Failed to fetch showcase game: 191 | return nextState;
192 | }
193 |
194 | private applyGameActionMutable(action: GameAction): void {
195 | if (this.status !== "playing") {
196 | throw new Error("Game is not playing");
^
error: Game is not playing
at applyGameActionMutable (C:\Users\Nilo\repos\wallgame\shared\domain\game-state.ts:196:13)
at applyGameAction (C:\Users\Nilo\repos\wallgame\shared\domain\game-state.ts:190:15)
at <anonymous> (C:\Users\Nilo\repos\wallgame\server\db\game-queries.ts:224:31)  
 at forEach (1:11)
at <anonymous> (C:\Users\Nilo\repos\wallgame\server\db\game-queries.ts:221:9)

--> GET /api/games/showcase 500 154ms
<-- GET /api/games/showcase
--> GET /api/games/showcase 200 150ms
<-- GET /api/games/showcase

- Sometimes rematching a bot fails and gets in an invalid state.
