# Directing the daily video

The director is an agent, Wall Game Director. Each day it picks one game, writes
the edit decision list (EDL) for its video, checks the render, and asks Nil.
Nil asked for this on 2026-10-26: an agent decides where each sound and zoom
goes, instead of fixed rules.

All commands are `node scripts/game-video/daily/crew.mjs <command>`. The app
refuses a step out of order. If you start in a new session, run `status`
first. When the schedule starts you, run `status` first too. If the day
already has a cycle, finish it or stop: do not start another. `pick
--replace` starts the day again, and only Nil's rejection is a reason for it.

## The steps

1. `facts --report ~/.isomux/apps/data/game-video/daily/candidates/<day>.json`
   The timer writes the day's report at 11:30 UTC. Read the top games. The
   `director` lines give the 0-based plies, the cells and the walls (`*` =
   the wall that made the jump).
2. `pick --report <same file> --rank N --caption "<post text>"`
   This caption is the X text, the YouTube title and the start of the
   YouTube description. `--title` sets another title.
3. `storyboard`, then open the PNG it names. It has one tile per position
   (ply N = the position after ply N, 0-based as in the EDL), in the video's
   colours. Yellow marks that ply's walls and pawn move. DANGER, SAVE,
   RELIEF and JUMP badges mark the picked plies. Choose the plies, cells and
   walls that you frame from what you see.
4. `direct --edl <edl.json>`
   Your EDL (below). `status` shows the default ending.
5. `render --wait`
   One render on the 4090. Each render adds one view to the real game, so a
   second render of the same game needs `--force`.
6. `sheet`, then open the PNG it names and judge each still. Then run
   `check --sheet <sha256 from sheet> --verdicts <verdicts.json>`, with one
   verdict per still in sheet order:
   `[{"ply": 9, "kind": "zoom", "ok": true, "note": "^g3 and ^h3 in frame, cat g3, mouse g4"}]`.
   `sheet` also prints the app's measures of the video. A measure that
   FAILED fails the check, whatever the stills show. `loudness` names the
   second of the loudest sound: drop that sound or name a softer one, then
   `direct` again and `render --force`. `safeArea` names a part of the frame
   that the apps would cover: that is a renderer fault, not your list, so
   skip the day and tell the Wall Game PM.
7. `ask --agent <your agent id>`
   This opens Nil's ask with the video and the sheet. When he answers, run
   `answer` (the rule is in the crew.mjs header), and then run `post --day <day>`.
   The ask opens for Nil, not for your manager, and `ask` prints who it
   opened for. If an open ask went to anyone else, run
   `ask --agent <your agent id> --reopen`: it opens the same ask for Nil and
   withdraws the old one.

## A good EDL

- Build it from the close call if the game has one: `scared` on the danger
  ply, then `zoom` with a FAHHH (`fuahhh-N`) on the save ply, framed on the
  save walls and both pawns, then `laugh` on the relief ply. The frame must
  hold every `*` wall of the save and both pawn cells; `direct` refuses a
  zoom that leaves one out.
- Read how the game ends before you write the story. The close call's fact
  says who wins. When the hunter still wins a few moves after the relief,
  the save only delayed the loss: no `laugh`, and the payoff says so (for
  example "2 to 8. Not enough."). `direct` refuses a laugh on a relief that
  the hunter wins within 10 plies (rehearsal, 2026-10-26: this was true of
  all three close calls in the day's top five).
- If the game has no close call, put the FAHHH and the zoom on the largest
  wall jump. Frame them on its `*` walls and on the pawn whose walk jumped,
  so the viewer sees whom the wall stops.
- Use few effects. One FAHHH per video unless two moves are equally strong.
- The video caption has 6 words and 32 characters at most. It says Red and
  Blue, not names. The renderer shows an AI in red and a human in blue; in a
  human vs human game, seat 1 is red and seat 2 is blue. `facts` gives each
  seat's colour.
- `payoff` (`{"ply": N, "text": "..."}`) is a second caption beat: from the
  move of ply N on, its text replaces the caption. Use it in most videos:
  whenever the game has one key wall (the save, or the largest jump in
  `facts`). Put N on that wall's ply. The caption sets up the stakes, and
  the payoff says what the wall did. With no single key wall, keep one
  caption. Same limits as the caption, Red and Blue, not names. Keep each
  beat to one line: a two-line beat makes the board smaller for the whole
  video (measured 2026-10-26: 720 px against 785 px).
- A number in a caption is a promise about the race counter. The setup
  caption is read at the start, so a number in it must be on the counter
  then (the storyboard's `steps` line of the start tile and ply 0). "Red
  was 2 steps from winning" over a counter that says 10 is wrong for most
  of the video: say the stakes in words ("Can Blue keep Red out?") and
  keep the number for the payoff. A number in the payoff must be on the
  counter just before or just after the payoff's move ("2 to 8", "now it's
  8"). `direct` refuses a number that the counter does not show then.
  Take numbers from the `steps` lines, not from a JUMP badge: it adds the
  mover's own change (+13 for a wall that took Blue from 7 to 19). Write
  step counts in digits, and other counts in words ("two Blue walls").
- `ending`: use the default from `status` unless the game needs another one.
- `music`: always name a track, and vary it. Do not use the last track,
  which `status` shows (posted, or waiting for an answer on another day).
  The names are in `scripts/game-video/music-tracks.mjs`. A list without
  music gets a random track; that is only for a hand render.
- The schema and the sound names are in `scripts/game-video/edl.mjs` and
  `scripts/game-video/meme-sounds.mjs`.
- Moment effects: see "Which effect for which fact" below. Use one or two
  per video, not all. `storyboard --edl <edl.json>` shows each one on its
  ply before the render.
- `vsSound` and `finishSound` name the sounds of the VS punch and the finish.
  Without them the video plays the defaults (`crew.mjs sounds` names them).
  If Nil dropped a default, name a kept sound.
- Sounds: run `crew.mjs sounds`. It gives each family's moment (a reveal, a
  blunder, the trap closes, a good move, a close call, the win, the loss)
  and the sounds that Nil kept on the app's `/daily/sounds` page. Name a kept
  sound that fits the moment. Use a sound that Nil has not heard yet only
  when no kept sound fits. `direct` refuses a sound that Nil dropped.

## Which effect for which fact

Every effect marks a fact that `facts` printed or that you saw on the
storyboard. An effect with no fact behind it is noise. A viewer does not know
the game, so each effect must make one thing clear: who is close to winning,
or which wall changed that.

| The fact                                                                                 | The effect                                    | Where                                                                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Close call: the cat gets 1-2 squares from the mouse                                      | `scared`                                      | danger ply, the mouse's cell                                                                |
| The wall that saves it (`save ply walls ...*`)                                           | `zoom` + a FAHHH, or `freeze`                 | save ply: zoom frame = the `*` walls and both pawns; freeze = the same ply, before it lands |
| The mouse is safe again                                                                  | `laugh`                                       | relief ply, the mouse's cell                                                                |
| The largest wall jump (`wall jump: ply N`, the first one listed)                         | `trap`, or `zoom` when there is no close call | jump ply, `walls` = its `*` walls                                                           |
| A walk jumps on one move (the save, or a jump)                                           | `race`                                        | that ply; no fields. The counter itself shows all video long, this flashes it               |
| The move that let the cat in (the storyboard shows the mouse's side gave up a wall line) | `blunder`                                     | that ply, the mover's pawn                                                                  |
| The save, or the winner's largest jump, was the move of the game                         | `brilliant`                                   | that ply, the mover's pawn                                                                  |
| A move that needs a laugh more than an explanation                                       | `react`                                       | that ply, next to the pawn it is about                                                      |

Rules:

- Few effects: one FAHHH per video, and at most two of the moment effects
  (`blunder`, `brilliant`, `trap`, `race`, `freeze`, `react`). Do not put two
  of them on one ply.
- `freeze` and `zoom` both mark one move. Use one of them on a ply, not both.
- On a ply with a zoom, put a `blunder`, `brilliant` or `react` on a cell
  inside the zoom frame, or leave it out: the zoom hides the rest of the
  board.
- `brilliant` and `blunder` judge a move. Use them only when the storyboard
  shows it: a save that walks the cat from 2 to 12 is brilliant; a wall that
  costs 4 squares is not.
- A `stamp` or a `trap` word lands 0.3 s after the move, in the band of the
  board (top, middle or bottom) where it hides the least of the move, and a
  long word shrinks to fit. Still check its still: if it hides a pawn of the
  moment, use `react` or the caption instead.
- The race counter (each side's steps, over the board) is on for the whole
  video. `race` flashes it: use it on the ply where a number changes a lot
  (for example 2 to 12). If it changes by 1 or 2, leave it out.
- `startPly` and `coldOpenPly` are in the schema for Nil's hook test
  (2026-10-26). Do not use them until Wall Game PM says that Nil chose.
- `fastForward` is in the schema for Nil's choice of video length
  (2026-10-26). Do not use it until Wall Game PM says that Nil chose. Then:
  put `"fastForward": true` on a pace range of quiet plies (no close call
  and no wall jump in `facts`), at 0.2 s per move (the video shows "x4") or
  0.25-0.3 s ("x3"). The opening before the first key wall and the moves
  between two beats are the usual ranges. Keep the 2 plies before a key
  wall at normal pace or slower, so the viewer sees the threat before the
  wall (Nil, 2026-10-26: "it plays too fast to follow"). Keep the payoff
  ply out of a range: a caption that changes at x4 is hard to read.
  `direct` refuses a range with an event or the cold open in it, or one
  that reaches the last move.
- `vsSound` is the first sound of the video: a reveal sound. `finishSound`
  fits how it ended: a win sound when the human won, a loss sound when the
  AI won, and a win sound in a human vs human game. `crew.mjs sounds` gives
  each family's moment.

```json
{
  "version": 1,
  "gameId": "W2SLwv69",
  "caption": "Can Blue keep Red out?",
  "ending": "gg",
  "pace": [{ "fromPly": 7, "toPly": 11, "secondsPerMove": 1.2 }],
  "events": [
    { "ply": 8, "kind": "scared", "cell": "g4", "sound": "scared-2" },
    {
      "ply": 9,
      "kind": "zoom",
      "frame": ["^g3", "^h3", "g3", "g4"],
      "sound": "fuahhh-1"
    },
    { "ply": 10, "kind": "laugh", "cell": "g4", "sound": "laugh-2" }
  ]
}
```

## Judging a still

A still is ok only when all of these are true:

- It is the ply that the EDL names.
- A zoom or a FAHHH shows the wall that it is about, and both pawns of the
  close call are in the frame.
- A scared or laugh still shows the effect on the correct pawn.
- A blunder, brilliant or react still shows its mark next to the correct
  pawn, and the mark does not hide the pawns of the moment.
- A trap still lights every `*` wall of the jump. A freeze still shows the
  position before the move, with the camera on the move's cell.
- A race still shows the counter flashing, both numbers in the sides'
  colours, and they match the walks in `facts` (for example 12 after the
  save).
- A stamp or trap text does not hide the pawns or the wall it is about.
- The sheet has one still for each event. A sound still needs only the
  correct ply.

Write what you see in the note. If a still is not ok, record the check
(the ask stays closed, and the render cannot be checked again), fix the
EDL, `direct` again and `render --force`.
Do this one time only. Each render is one more view of the game.

## Skip the day

Skip the day, and tell the Wall Game PM why, when:

- `facts` prints "no candidates" (it gives the reason).
- No game in the top 5 has a moment worth a FAHHH.
- The render fails two times, or the second check fails too.

Do not post a weak video to keep a streak.
