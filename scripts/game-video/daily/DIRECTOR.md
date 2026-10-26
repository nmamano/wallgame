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
7. `ask --agent <your agent id>`
   This opens Nil's ask with the video and the sheet. When he answers, run
   `answer` (the rule is in the crew.mjs header), and then run `post --day <day>`.

## A good EDL

- Build it from the close call if the game has one: `scared` on the danger
  ply, then `zoom` with a FAHHH (`fuahhh-N`) on the save ply, framed on the
  save walls and both pawns, then `laugh` on the relief ply. The frame must
  hold every `*` wall of the save and both pawn cells; `direct` refuses a
  zoom that leaves one out.
- If the game has no close call, put the FAHHH and the zoom on the largest
  wall jump. Frame them on its `*` walls.
- Use few effects. One FAHHH per video unless two moves are equally strong.
- The video caption has 6 words and 32 characters at most. It says Red and
  Blue, not names. The renderer shows an AI in red and a human in blue; in a
  human vs human game, seat 1 is red and seat 2 is blue. `facts` gives each
  seat's colour.
- `ending`: use the default from `status` unless the game needs another one.
- `music`: always name a track, and vary it. Do not use the last track,
  which `status` shows (posted, or waiting for an answer on another day).
  The names are in `scripts/game-video/music-tracks.mjs`. A list without
  music gets a random track; that is only for a hand render.
- The schema and the sound names are in `scripts/game-video/edl.mjs` and
  `scripts/game-video/meme-sounds.mjs`.

```json
{
  "version": 1,
  "gameId": "W2SLwv69",
  "caption": "Red was 1 square away",
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
- The sheet has one still for each event. A stamp or sound still needs only
  the correct ply.

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
