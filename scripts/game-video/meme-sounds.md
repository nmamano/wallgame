# Meme sound candidates for the daily game video

Board task e8d26610, step 2. The daily look plays a meme sound over the VS
names (`vsMeme`), on each swing move (`swing`), on the impact of the ending
(`finish`), and in the close-call beat: as the mouse is scared (`scared`) and
as it laughs after the save (`laugh`).
The director names each cue by its key in the EDL (`edl.mjs`); every
candidate is a key in `MEME_SOUNDS` in `meme-sounds.mjs`. The VS and
finish sounds are one line each in `SOUNDS` in `render-game-video.mjs`.

The clips are not in this repository. They are other people's uploads, kept
in the gitignored `assets/meme-sounds/<key>.mp3` on the render boxes.
`sync-render-kit.sh` copies them to the 4090.

The first five families were all found 2026-10-26 on myinstants.com, the one site that shows play counts.
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

## Original sound effects (families boom to ooh)

Task e8d26610, 2026-10-26 (Nil: "more meme effects and sounds and animations,
to be used contextually by the director"). Ten families, 27 clips. Nil keeps
or drops each one by ear on the game-video app's `/daily/sounds` page. The
moment that each family is for is in `MEME_FAMILIES` in `meme-sounds.mjs`.

WHY THESE ARE SAFE FOR CONTENT ID. Content ID matches a video against
reference files that rights owners submit: songs, records, films and TV. So
every clip here is a sound effect that its uploader recorded or made, not a
cut from a film, TV show, song or commercial record. Each one is on
freesound.org under Creative Commons 0 (public domain: no credit needed, no
claim kept), and each page says how the sound was made. The table gives that
reason. Rows marked WEAKER have a CC0 licence but no page text that says how
the sound was made; prefer another candidate of the same family.

Refused on the way: every candidate whose page named a film, a TV show or a
game (a Batman stab, a "Mission Impossible" recreation, a Roblox clip), a
digitized vintage film library (craigsmith's R07 series), and a scratch built
from another upload that is now missing. The task asked for a "dun-dun-dun"
for the trap: no CC0 three-note clip was found whose page shows it is
original, so the `sting` family has one-hit stings instead.

The files are Freesound's "HQ preview" mp3 (128 kbps); the original download
needs a login. Downloads are the counts on freesound.org on 2026-10-26. The
level of each clip is in `meme-sounds.mjs`, measured the same day.

| Key        | Freesound title             | Length | Downloads | Uploader              | Why it is safe                                                           | Source page                                                       |
| ---------- | --------------------------- | ------ | --------- | --------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| boom-1     | Drama Boom 02               | 3.7 s  | 589       | modusmogulus          | Recorded by the uploader: a drawer hit with a glove on a stick           | https://freesound.org/people/modusmogulus/sounds/802074/          |
| boom-2     | JM_FX_Boom 01a              | 4.8 s  | 5,079     | Julien_Matthey        | A sound designer's own boom hit with reverb; no other source named       | https://freesound.org/people/Julien_Matthey/sounds/201571/        |
| boom-3     | Boom_C_06                   | 1.6 s  | 1,056     | cabled_mess           | Generated by the uploader with the ChipTone tool                         | https://freesound.org/people/cabled_mess/sounds/350977/           |
| oof-1      | Oof (original)              | 0.3 s  | 2,028     | unfa                  | The uploader's own voice (Behringer B-1); an homage, not the Roblox clip | https://freesound.org/people/unfa/sounds/719053/                  |
| oof-2      | HomemadeOof.wav             | 0.5 s  | 3,037     | LucyTheDev            | The uploader's own voice                                                 | https://freesound.org/people/LucyTheDev/sounds/438912/            |
| bruh-1     | Bruh Sound Effect #1        | 0.8 s  | 2,532     | Autellaem             | Says "by Autellaem"; how it was made is not stated                       | https://freesound.org/people/Autellaem/sounds/534387/             |
| bruh-2     | bruh.m4a                    | 1.4 s  | 755       | ivar.nohre            | WEAKER: the page says only "bruh"                                        | https://freesound.org/people/ivar.nohre/sounds/506582/            |
| scratch-1  | record_scratch.wav          | 0.5 s  | 19,342    | ludvique              | Recorded by the uploader: a cartridge pressed on a vinyl record          | https://freesound.org/people/ludvique/sounds/71853/               |
| scratch-2  | Record Scratch #6           | 1.9 s  | 4,961     | musicvision31         | A needle on a vinyl record; no music under it                            | https://freesound.org/people/musicvision31/sounds/431779/         |
| scratch-3  | Vinyl Scratch.wav           | 0.6 s  | 2,814     | Espinho123            | WEAKER: "made from 3 composite sounds", which are not named              | https://freesound.org/people/Espinho123/sounds/647583/            |
| airhorn-1  | Airhorn                     | 1.7 s  | 17,790    | jacksonacademyashmore | WEAKER: "made in audacity", source not named; 64 kbps                    | https://freesound.org/people/jacksonacademyashmore/sounds/414208/ |
| airhorn-2  | airhorn-short.wav           | 5.1 s  | 11,836    | guitarguy1985         | A quick air horn with echo, uploaded in 2009                             | https://freesound.org/people/guitarguy1985/sounds/68999/          |
| airhorn-3  | Industrial Air Horn         | 2.6 s  | 8,905     | mcpable               | A field recording: an air horn on an oil rig in Alberta                  | https://freesound.org/people/mcpable/sounds/131930/               |
| letsgo-1   | Let's Go (male)             | 1.5 s  | 1,847     | dastudiospr           | A male voice actor's line, uploaded by the studio                        | https://freesound.org/people/dastudiospr/sounds/529817/           |
| letsgo-2   | lets go.wav                 | 1.2 s  | 2,175     | ashjenx               | The uploader's own voice ("me saying lets go")                           | https://freesound.org/people/ashjenx/sounds/132685/               |
| trombone-1 | wah wah sad trombone.wav    | 5.3 s  | 22,895    | kirbydx               | The uploader plays the stock wah-wah figure on a trombone (Zoom H2next)  | https://freesound.org/people/kirbydx/sounds/175409/               |
| trombone-2 | horn_fail_wahwah_1.wav      | 4.3 s  | 6,017     | TaranP                | The uploader plays a French horn (Zoom H4n); three notes                 | https://freesound.org/people/TaranP/sounds/362206/                |
| trombone-3 | Fail.mp3                    | 2.2 s  | 11,931    | LittleRainySeasons    | Made by the uploader in 3ML Piano Editor for an animation                | https://freesound.org/people/LittleRainySeasons/sounds/335906/    |
| sting-1    | Shock Stab 12               | 3.7 s  | 781       | nomiqbomi             | An orchestral stab the uploader made (pack made in Logic Pro X)          | https://freesound.org/people/nomiqbomi/sounds/578382/             |
| sting-2    | Dissonant Piano Stinger.mp3 | 3.5 s  | 1,367     | XfiXy8                | Recorded by the uploader: an out-of-tune piano, SM58                     | https://freesound.org/people/XfiXy8/sounds/467289/                |
| sting-3    | Piano Cord.wav              | 1.8 s  | 1,642     | ecfike                | The uploader plays one minor piano chord                                 | https://freesound.org/people/ecfike/sounds/183500/                |
| ding-1     | Correct.mp3                 | 1.1 s  | 34,079    | LittleRainySeasons    | Made by the uploader in 3ML Piano Editor                                 | https://freesound.org/people/LittleRainySeasons/sounds/335908/    |
| ding-2     | correct                     | 0.4 s  | 13,705    | ertfelda              | The uploader plays a Yamaha PSS-270 keyboard                             | https://freesound.org/people/ertfelda/sounds/243701/              |
| ding-3     | Correct Bell                | 1.6 s  | 2,824     | Fupicat               | Made by the uploader with BeepBox                                        | https://freesound.org/people/Fupicat/sounds/538147/               |
| ooh-1      | Crowd gasp.wav              | 1.6 s  | 2,961     | RadioCounseling       | 14 voices, all the uploader's own                                        | https://freesound.org/people/RadioCounseling/sounds/635110/       |
| ooh-2      | crowd `oh - - disappointed  | 5.0 s  | 1,928     | mrrap4food            | WEAKER: the page says only "crowd disappointed"                          | https://freesound.org/people/mrrap4food/sounds/619007/            |
| ooh-3      | Gasp.wav                    | 1.5 s  | 12,933    | Dvideoguy             | WEAKER: the page says only "crowd gasping"                               | https://freesound.org/people/Dvideoguy/sounds/207779/             |

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
