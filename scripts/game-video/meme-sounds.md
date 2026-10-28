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
the clips here are sound effects, not cuts from a film, TV show, song or
commercial record. Each one is on freesound.org under Creative Commons 0
(public domain: no credit needed, no claim kept). For 19 of the 27, the page
says how the uploader recorded or made the sound; the table gives that
reason. The 8 rows marked WEAKER have a CC0 licence but no page text that
says how the sound was made; prefer another candidate of the same family. The
listening page and `crew.mjs sounds` show these notes from
`MEME_SOURCE_NOTES` in `meme-sounds.mjs`.

Refused on the way: every candidate whose page named a film, a TV show or a
game (a Batman stab, a "Mission Impossible" recreation, a Roblox clip), a
digitized vintage film library (craigsmith's R07 series), and a scratch built
from another upload that is now missing. One exception: `oof-1` names a game
because it is an homage to the Roblox "oof" (first made for Interplay's
Messiah). It is not that clip: the uploader recorded it in their own voice
(the page names the microphone), so Content ID has no matching fingerprint. The task asked for a "dun-dun-dun"
for the trap: no CC0 three-note clip was found whose page shows it is
original, so the `sting` family has one-hit stings instead.

The files are Freesound's "HQ preview" mp3 (128 kbps); the original download
needs a login. Downloads are the counts on freesound.org on 2026-10-26. The
level of each clip is in `meme-sounds.mjs`, measured the same day.

| Key        | Freesound title             | Length | Downloads | Uploader              | Why it is safe                                                                                                             | Source page                                                       |
| ---------- | --------------------------- | ------ | --------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| boom-1     | Drama Boom 02               | 3.7 s  | 589       | modusmogulus          | Recorded by the uploader: a drawer hit with a glove on a stick                                                             | https://freesound.org/people/modusmogulus/sounds/802074/          |
| boom-2     | JM_FX_Boom 01a              | 4.8 s  | 5,079     | Julien_Matthey        | WEAKER: the page says only "Boom Hit with some reverb and atmospheric effect"                                              | https://freesound.org/people/Julien_Matthey/sounds/201571/        |
| boom-3     | Boom_C_06                   | 1.6 s  | 1,056     | cabled_mess           | Generated by the uploader with the ChipTone tool                                                                           | https://freesound.org/people/cabled_mess/sounds/350977/           |
| oof-1      | Oof (original)              | 0.3 s  | 2,028     | unfa                  | The uploader's own voice (Behringer B-1); an homage, not the Roblox clip                                                   | https://freesound.org/people/unfa/sounds/719053/                  |
| oof-2      | HomemadeOof.wav             | 0.5 s  | 3,037     | LucyTheDev            | The uploader's own voice                                                                                                   | https://freesound.org/people/LucyTheDev/sounds/438912/            |
| bruh-1     | Bruh Sound Effect #1        | 0.8 s  | 2,532     | Autellaem             | WEAKER: the page says only "Bruh sound effect by Autellaem" and has the tag "meme", so it may be a copy of the famous clip | https://freesound.org/people/Autellaem/sounds/534387/             |
| bruh-2     | bruh.m4a                    | 1.4 s  | 755       | ivar.nohre            | WEAKER: the page says only "bruh"                                                                                          | https://freesound.org/people/ivar.nohre/sounds/506582/            |
| scratch-1  | record_scratch.wav          | 0.5 s  | 19,342    | ludvique              | Recorded by the uploader: a cartridge pressed on a vinyl record                                                            | https://freesound.org/people/ludvique/sounds/71853/               |
| scratch-2  | Record Scratch #6           | 1.9 s  | 4,961     | musicvision31         | A needle on a vinyl record; no music under it                                                                              | https://freesound.org/people/musicvision31/sounds/431779/         |
| scratch-3  | Vinyl Scratch.wav           | 0.6 s  | 2,814     | Espinho123            | WEAKER: "made from 3 composite sounds", which are not named                                                                | https://freesound.org/people/Espinho123/sounds/647583/            |
| airhorn-1  | Airhorn                     | 1.7 s  | 17,790    | jacksonacademyashmore | WEAKER: "made in audacity", source not named; 64 kbps                                                                      | https://freesound.org/people/jacksonacademyashmore/sounds/414208/ |
| airhorn-2  | airhorn-short.wav           | 5.1 s  | 11,836    | guitarguy1985         | WEAKER: the page says only "Quick air horn with echo"                                                                      | https://freesound.org/people/guitarguy1985/sounds/68999/          |
| airhorn-3  | Industrial Air Horn         | 2.6 s  | 8,905     | mcpable               | A field recording: an air horn on an oil rig in Alberta                                                                    | https://freesound.org/people/mcpable/sounds/131930/               |
| letsgo-1   | Let's Go (male)             | 1.5 s  | 1,847     | dastudiospr           | The page says "Male voice says: Let's Go!" and names the speaker and the place (Daniel Alvarez, Ponce, Puerto Rico)        | https://freesound.org/people/dastudiospr/sounds/529817/           |
| letsgo-2   | lets go.wav                 | 1.2 s  | 2,175     | ashjenx               | The uploader's own voice ("me saying lets go")                                                                             | https://freesound.org/people/ashjenx/sounds/132685/               |
| trombone-1 | wah wah sad trombone.wav    | 5.3 s  | 22,895    | kirbydx               | The uploader plays the stock wah-wah figure on a trombone (Zoom H2next)                                                    | https://freesound.org/people/kirbydx/sounds/175409/               |
| trombone-2 | horn_fail_wahwah_1.wav      | 4.3 s  | 6,017     | TaranP                | The uploader plays a French horn (Zoom H4n); three notes                                                                   | https://freesound.org/people/TaranP/sounds/362206/                |
| trombone-3 | Fail.mp3                    | 2.2 s  | 11,931    | LittleRainySeasons    | Made by the uploader in 3ML Piano Editor for an animation                                                                  | https://freesound.org/people/LittleRainySeasons/sounds/335906/    |
| sting-1    | Shock Stab 12               | 3.7 s  | 781       | nomiqbomi             | An orchestral stab the uploader made (pack made in Logic Pro X)                                                            | https://freesound.org/people/nomiqbomi/sounds/578382/             |
| sting-2    | Dissonant Piano Stinger.mp3 | 3.5 s  | 1,367     | XfiXy8                | Recorded by the uploader: an out-of-tune piano, SM58                                                                       | https://freesound.org/people/XfiXy8/sounds/467289/                |
| sting-3    | Piano Cord.wav              | 1.8 s  | 1,642     | ecfike                | The uploader plays one minor piano chord                                                                                   | https://freesound.org/people/ecfike/sounds/183500/                |
| ding-1     | Correct.mp3                 | 1.1 s  | 34,079    | LittleRainySeasons    | Made by the uploader in 3ML Piano Editor                                                                                   | https://freesound.org/people/LittleRainySeasons/sounds/335908/    |
| ding-2     | correct                     | 0.4 s  | 13,705    | ertfelda              | The uploader plays a Yamaha PSS-270 keyboard                                                                               | https://freesound.org/people/ertfelda/sounds/243701/              |
| ding-3     | Correct Bell                | 1.6 s  | 2,824     | Fupicat               | Made by the uploader with BeepBox                                                                                          | https://freesound.org/people/Fupicat/sounds/538147/               |
| ooh-1      | Crowd gasp.wav              | 1.6 s  | 2,961     | RadioCounseling       | 14 voices, all the uploader's own                                                                                          | https://freesound.org/people/RadioCounseling/sounds/635110/       |
| ooh-2      | crowd `oh - - disappointed  | 5.0 s  | 1,928     | mrrap4food            | WEAKER: the page says only "crowd disappointed"                                                                            | https://freesound.org/people/mrrap4food/sounds/619007/            |
| ooh-3      | Gasp.wav                    | 1.5 s  | 12,933    | Dvideoguy             | WEAKER: the page says only "crowd gasping"                                                                                 | https://freesound.org/people/Dvideoguy/sounds/207779/             |

## Get-away voices (family seeya)

Wall Game Director, 2026-10-26, after Nil's review of ask ac64cf6d: "how
about some meme audio at that point, like, 'see ya' or smth?", for the
moment the prey gets away. The rules are the same as for the families above:
CC0 on freesound.org, a voice or an effect and not a cut from a film, TV
show, song or record, and the page says how the sound was made. The files
are Freesound's "HQ preview" mp3. Nil keeps or drops each one on
`/daily/sounds`.

| Key     | Freesound title                       | Length | Downloads | Uploader  | Why it is safe                                                                                    | Source page                                           |
| ------- | ------------------------------------- | ------ | --------- | --------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| seeya-1 | see ya bye.sesxfinal_mixdown.mp3final | 2.6 s  | 143       | 12062482p | WEAKER: the page says only "ending a phone call"; a voice says "see ya, bye"                      | https://freesound.org/people/12062482p/sounds/502456/ |
| seeya-2 | bye#1                                 | 1.0 s  | 0         | Ayetherah | The uploader's own voice for a voice pack (Shure SM58, M-Audio M-Track Duo)                       | https://freesound.org/people/Ayetherah/sounds/865466/ |
| seeya-3 | mmbye.wav                             | 0.9 s  | 1,061     | Reitanna  | The uploader's own voice: a sarcastic "mmbye"; her profile names the microphones she records with | https://freesound.org/people/Reitanna/sounds/343893/  |

Refused: a "whoosh away" (three CC0 candidates): each page says only "made
in audacity" or "a remix of a remix", so none says where its sound came
from.

## Famous meme bites (families alert to ambulance, and boom-4, bruh-3)

Wall Game Director, 2026-10-28, from its research for the model video
("UFC 333 in 6 Minutes"): the famous bites that meme editors use, one
moment each (`MEME_FAMILIES`). Unlike the families above, these are the
real meme clips, not CC0 sound-alikes, so most have an owner. Each is the
most-played upload on myinstants.com (views on 2026-10-28), or a cleaner
second upload. The files are those uploads; reveal-1 and violin-1 are
copied without their extra stream (cover art in reveal-1, an empty one in
violin-1), with the same audio bytes.
`boom-4` is the real vine boom and `bruh-3` the real bruh clip, next to the
CC0 sound-alikes of those families.

The app refuses a high claim risk sound in a list unless the director names
it in `claimRiskOk` (routes.mjs). None of the High ones goes in a video
without Nil's OK. A Medium or Low rating is not a promise: any upload can be
claimed.

| Key         | What it is                                                 | Length | Views      | Source page                                                                   | Origin                                                                                                                                                                                                                    | Claim risk                                           |
| ----------- | ---------------------------------------------------------- | ------ | ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| boom-4      | Vine Boom: one deep bass "boom" hit.                       | 1.3 s  | 11,789,848 | https://www.myinstants.com/en/instant/vine-boom-sound-70972/                  | Bluezone Corporation sound library, 2012 ("Cinematic Session", file Bluezone-Cimpact-sound-001). King Bach made it popular on Vine.                                                                                       | Medium (commercial library effect; Bluezone owns it) |
| alert-1     | Metal Gear Solid alert "!" sting.                          | 1.6 s  | 1,406,327  | https://www.myinstants.com/en/instant/metal-gear-solid-alert/                 | Metal Gear Solid game series, Konami.                                                                                                                                                                                     | High (Konami game audio)                             |
| clang-1     | Metal pipe falls and clangs on the floor.                  | 2.8 s  | 1,982,630  | https://www.myinstants.com/en/instant/metal-pipe-clang-80894/                 | YouTuber Jixaw used it first, 17 Sep 2020 (Know Your Meme). The source of the audio is not known. Some people say it is a Battlefield 4 asset. Nobody confirmed this.                                                     | Low (no known owner; game claim unconfirmed)         |
| bell-1      | Undertaker bell: one deep gong hit.                        | 4.2 s  | 938,728    | https://www.myinstants.com/en/instant/the-undertaker-bell-30938/              | The Undertaker entrance theme, WWE (music by Jim Johnston).                                                                                                                                                               | High (WWE entrance music, WWE claims actively)       |
| dundun-1    | "Dun dun dunnn" dramatic brass sting.                      | 5.1 s  | 1,645,106  | https://www.myinstants.com/en/instant/dun-dun-dunnnnnnnn-68584/               | Old stock sting. The meme version is usually "Shock Horror (a)" by Dick Walter, KPM music library, 1983. We did not confirm that this file is that cue.                                                                   | Medium (possibly KPM library cue; unconfirmed)       |
| dundun-2    | Shorter "dun dun duuun" sting.                             | 2.4 s  | 60,727     | https://www.myinstants.com/en/instant/dun-dun-duuun/                          | Same as dundun-1. Not confirmed.                                                                                                                                                                                          | Medium (possibly KPM library cue; unconfirmed)       |
| reveal-1    | Among Us role reveal ("shhh", then the reveal sting).      | 4.6 s  | 3,403,235  | https://www.myinstants.com/en/instant/among-us-role-reveal-sound-34956/       | Among Us game (Innersloth, 2018). The sound plays at the start of a round.                                                                                                                                                | High (Innersloth game audio)                         |
| wow-1       | Anime "Wow!" female voice, with echo and sparkle effects.  | 4.2 s  | 4,625,201  | https://www.myinstants.com/en/instant/anime-wow/                              | Konami arcade game Parodius Da! (1990). The echo version is from the Fairy Tail OVA 3 "Memory Days" (2012) (Know Your Meme).                                                                                              | High (Konami game and anime audio)                   |
| wow-2       | Anime "Wow!" voice only, with no background.               | 1.5 s  | 24,417     | https://www.myinstants.com/en/instant/anime-wow-no-background/                | Same as wow-1.                                                                                                                                                                                                            | High (Konami game and anime audio)                   |
| bruh-3      | A man says "Bruh."                                         | 0.9 s  | 5,797,106  | https://www.myinstants.com/en/instant/bruh/                                   | Voice of Viner Headgraphix, in a Vine by CallHimBzar, 1 May 2014 ("Bruh Sound Effect #2", Know Your Meme).                                                                                                                | Medium (voice clip of a known creator)               |
| fail-1      | SpongeBob "fail" / disappointed lap-steel sting.           | 3.4 s  | 2,871,115  | https://www.myinstants.com/en/instant/spongebob-fail-11236/                   | SpongeBob SquarePants (Nickelodeon). The cue is usually called "Steel Sting". It is possibly a production-library cue. Not confirmed.                                                                                     | High (Nickelodeon TV show music cue)                 |
| horn-1      | The Price Is Right losing horn ("wah wah wah wahhh").      | 5.1 s  | 505,792    | https://www.myinstants.com/en/instant/the-price-is-right-losing-horn/         | The Price Is Right (CBS / Fremantle) game show. Cue "The Lose" by Edd Kalehoff.                                                                                                                                           | High (TV game show music cue)                        |
| getout-1    | A man screams "GET OUT!"                                   | 1.0 s  | 3,040,298  | https://www.myinstants.com/en/instant/tuco-get-out-30566/                     | NOT from Breaking Bad. Know Your Meme: the voice only sounds like Tuco. It is an unknown streamer in a GTA 5 roleplay server (Paradise State RP). First known post 10 May 2023.                                           | Medium (unknown streamer's clip; not AMC audio)      |
| pointing-1  | Spider-Man meme song (a short part of a Spider-Man theme). | 12.4 s | 1,966,609  | https://www.myinstants.com/en/instant/spiderman-meme-song-37638/              | Most likely the 1967 Spider-Man TV theme (Bob Harris and Paul Francis Webster). The pointing image is from the 1967 episode "Double Identity". We did not confirm which recording this file uses.                         | High (Marvel / Disney theme song)                    |
| violin-1    | Sad violin phrase ("the meme one").                        | 4.6 s  | 3,423,188  | https://www.myinstants.com/en/instant/sad-violin-the-meme-one/                | Know Your Meme: "Sad Violin" is "Sad Romance" by Ji Pyeong-keyon, from the 2003 Korean TV drama "Over the Green Fields". The file name is "tf_nemesis.mp3". This can mean a Team Fortress 2 (Valve) asset. Not confirmed. | High (TV drama soundtrack or game audio)             |
| ambulance-1 | "Call an ambulance! ... But not for me."                   | 5.0 s  | 15,287     | https://www.myinstants.com/en/instant/call-an-ambulance-but-not-for-me-55557/ | 2018 ad for Silver Series Self-Defense (a Las Vegas class for people 65 and older). Facebook page "Las Vegas Gunfights" posted it on 30 Aug 2018 (Know Your Meme).                                                        | Medium (ad of a small company)                       |

Nil rated the 16 clips by ear on the numbered reel `sound-reel-3.mp4`
(through the Wall Game Director's ask 26bdf770, 2026-10-28): "all the sound
reel are good". He keeps all 16, so each is "ok" on `/daily/sounds` (a sound
with no choice). His keep does not change the claim risk: a High one still
needs `claimRiskOk` in its list.

### Short cuts (bell-2, pointing-2)

pointing-1 is 12.4 s and bell-1 is 4.2 s, too long for a video of about
27 s, and an edit list cannot shorten a sound. Wall Game Director,
2026-10-28: cut a short one of each. The cuts are ours, made from the same
upload, so they keep their source's claim risk (High). The cut points come
from the clip's loudness per 100 ms, not from listening:

- bell-2 keeps the hit and the start of its natural decay, about 10 dB
  under the hit at 2.2 s, then a fade. Wall Game Director, 2026-10-28: OK
  to use.
- pointing-2 is NOT a clean cut. pointing-1 has no gap between words:
  nowhere in its first 8 s is it under -30 dB for 0.1 s (measured
  2026-10-28; its quietest 100 ms after the start, at 4.18 s, peaks at
  -23.5 dB). At 2.5 to 2.8 s it is -15 to -14 dB, so pointing-2 is a
  0.25 s fade over sung music and may cut a word. Wall Game Director,
  2026-10-28: not used until Nil hears it.

| Key        | Made from  | Length | Command (ffmpeg, from `assets/meme-sounds`)                                                                |
| ---------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| pointing-2 | pointing-1 | 2.8 s  | `-i pointing-1.mp3 -af "atrim=0:2.8,afade=t=out:st=2.55:d=0.25" -c:a libmp3lame -b:a 128k -ar 44100 -ac 2` |
| bell-2     | bell-1     | 2.2 s  | `-i bell-1.mp3 -af "atrim=0:2.2,afade=t=out:st=1.4:d=0.8" -c:a libmp3lame -b:a 128k -ar 44100 -ac 2`       |

Findings that change the research file: the "GET OUT" voice is not from
Breaking Bad (Know Your Meme: a GTA 5 roleplay streamer who sounds like
Tuco, 2023); the vine boom comes from a commercial sound library (Bluezone,
2012); the metal pipe has no known owner.

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
