# Meme sound candidates for the daily game video

Board task e8d26610, step 2. The wallz and mix looks play a meme sound on each
swing move (`swing`) and as the winner's colour floods the board (`flood`).
The active pick is one line each in `SOUNDS` in `render-game-video.mjs`;
every candidate is a key in `MEME_SOUNDS` there.

The clips are not in this repository. They are other people's uploads, kept
in the gitignored `assets/meme-sounds/<key>.mp3` on the render boxes.
`sync-render-kit.sh` copies them to the 4090.

All found 2026-10-26 on myinstants.com, the one site that shows play counts.
Views are the counts on that site on that day.

| Key       | What it is                                          | Length | Views     | Source page                                                             |
| --------- | --------------------------------------------------- | ------ | --------- | ----------------------------------------------------------------------- |
| fuahhh-1  | "Fahhh", the standard upload                        | 2.3 s  | 2,609,957 | https://www.myinstants.com/en/instant/fahhh-42300/                      |
| fuahhh-2  | "FAHHHHH", a longer yell                            | 1.7 s  | 344,051   | https://www.myinstants.com/en/instant/fahhhhh-89304/                    |
| fuahhh-3  | "ACTUALLY GOOD FAHHHH sfx", 320 kbps                | 2.3 s  | 52,583    | https://www.myinstants.com/en/instant/actually-good-fahhhh-sfx-34105/   |
| shotgun-1 | Fortnite pump shotgun blast, boosted until it clips | 3.5 s  | 474,860   | https://www.myinstants.com/en/instant/pump-shotgun-fortnite-loud-10601/ |
| shotgun-2 | "GunShottttt", one clean blast                      | 1.3 s  | 668,356   | https://www.myinstants.com/en/instant/gunshottttt-97863/                |
| shotgun-3 | Shotgun pump "cha-chk" only, no blast               | 1.1 s  | 72,606    | https://www.myinstants.com/en/instant/shotgun-reload-23461/             |
| shotgun-4 | "fahhh" and a pump shotgun in one clip              | 2.1 s  | 170,995   | https://www.myinstants.com/en/instant/fahhh-pump-sound-49422/           |
| win-1     | "Emotional damage" (Steven He)                      | 3.4 s  | 1,497,445 | https://www.myinstants.com/en/instant/emotional-damage-meme-74555/      |
| win-2     | GTA San Andreas "mission passed"                    | 7.5 s  | 290,252   | https://www.myinstants.com/en/instant/gta-sa-mission-passed/            |

## Copyright risk

A YouTube claim is the known risk (task e8d26610). Swap the clip in `SOUNDS`.

- High: `win-2` is a Rockstar Games music sting. `shotgun-1` names Fortnite
  (Epic Games). `shotgun-4` probably holds the same Fortnite blast.
- Lower: the fahhh clips are a recording of a streamer (Taileons, per Know
  Your Meme), not a studio, and the sound is used everywhere. `win-1` is a
  creator's catchphrase, the same kind of risk.
- Unchecked: `shotgun-2` and `shotgun-3` name no owner. The `shotgun-3` file
  name points to a SoundBible upload; its licence is not confirmed.
