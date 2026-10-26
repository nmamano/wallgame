# Meme sound candidates for the daily game video

Board task e8d26610, step 2. The daily look plays a meme sound over the VS
names (`vsMeme`), on each swing move (`swing`), on the impact of the ending
(`finish`), and in the close-call beat: as the mouse is scared (`scared`) and
as it laughs after the save (`laugh`).
The director names each cue by its key in the EDL (`edl.mjs`); every
candidate is a key in `MEME_SOUND_GAINS` in `meme-sounds.mjs`. The VS and
finish sounds are one line each in `SOUNDS` in `render-game-video.mjs`.

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
| scared-1  | "Oh Noh Cartoon", a cartoon "oh no"                 | 1.7 s  | 90,581    | https://www.myinstants.com/en/instant/oh-noh-cartoon-75602/             |
| scared-2  | "Man screaming aaaah", a stock scream               | 2.1 s  | 165,650   | https://www.myinstants.com/en/instant/man-screaming-aaaah-32768/        |
| scared-3  | "Shocked sound"                                     | 1.5 s  | 1,738,965 | https://www.myinstants.com/en/instant/shocked-sound-37548/              |
| laugh-1   | The Simpsons, Nelson's "HA-HA!"                     | 1.9 s  | 355,945   | https://www.myinstants.com/en/instant/the-simpsons-nelsons-ha-ha/       |
| laugh-2   | "cat laugh meme 1", a wheezing cat laugh            | 3.6 s  | 1,502,670 | https://www.myinstants.com/en/instant/cat-laugh-meme-1-15761/           |
| laugh-3   | "Chipmunk Laugh"                                    | 2.6 s  | 463,141   | https://www.myinstants.com/en/instant/chipmunk-laugh-62540/             |

## Copyright risk

A YouTube claim is the known risk (task e8d26610). Name another key in the EDL, or swap the clip in `SOUNDS`.

- High: `win-2` is a Rockstar Games music sting. `shotgun-1` names Fortnite
  (Epic Games). `shotgun-4` probably holds the same Fortnite blast. `laugh-1`
  is a clip of The Simpsons (20th Television, Disney).
- Lower: the fahhh clips are a recording of a streamer (Taileons, per Know
  Your Meme), not a studio, and the sound is used everywhere. `win-1` is a
  creator's catchphrase, the same kind of risk.
- Unchecked: `shotgun-2` and `shotgun-3` name no owner. The `shotgun-3` file
  name points to a SoundBible upload; its licence is not confirmed.
  `scared-1` carries the tag #creycee, which may name its creator. `laugh-3`
  may come from Alvin and the Chipmunks; its origin is not confirmed.
  `scared-2`, `scared-3` and `laugh-2` name no owner.
