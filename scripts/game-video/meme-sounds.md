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

## Meme list, cycle 1 (buzzer, levelwin, accomplished, whistle)

Director Rewriter, 2026-10-30 (improvement loop step 2): eight sounds for
the moments of the director's meme list. The rules are those of the
families above: CC0 on freesound.org, and the page says how the sound was
made; a myinstants bite needs a known origin. Four passed and four were
refused (below). None is a voice. The files are Freesound's "HQ preview"
mp3 (128 kbps), fetched 2026-10-30; the levels in `meme-sounds.mjs` were
measured the same day.

| Key            | Freesound title          | Length | Uploader                | Why it is safe                                                                     | Claim risk     | Source page                                                         |
| -------------- | ------------------------ | ------ | ----------------------- | ---------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| buzzer-1       | Wrong Buzzer             | 0.5 s  | KevinVG207              | "Generated in Audacity" by the uploader                                            | Low            | https://freesound.org/people/KevinVG207/sounds/331912/              |
| levelwin-1     | Level win.wav            | 3.5 s  | Tuudurt                 | Made by the uploader with Reason 4.0 and an M-Audio MIDI controller, Estonia, 2014 | Low            | https://freesound.org/people/Tuudurt/sounds/258142/                 |
| accomplished-1 | Retro "Accomplished" SFX | 0.4 s  | suntemple               | Made by the uploader for their own game, Element Puzzle                            | Low            | https://freesound.org/people/suntemple/sounds/253177/               |
| whistle-1      | THE WHISTLE.wav          | 3.5 s  | beautifuldaymonster1968 | Whistled by the uploader, "for a TV series titled After Sundown"; a cut, see below | Low; see below | https://freesound.org/people/beautifuldaymonster1968/sounds/699254/ |

whistle-1 is a cut of the 42 s upload. The cut point comes from the
upload's level per 100 ms, not from listening: the first phrase is about
-28 to -36 dB from 0 to 2.5 s, and from 3.1 to 3.7 s only its reverb
remains (-47 to -52 dB), about 20 dB under the phrase. The cut ends there,
at 3.5 s, after a 0.8 s fade. It is not used until Nil hears it. Two
points for his ear: the page calls the tune "Morricone-inspired", so a
music publisher could claim it if it quotes a film theme (for example
"The Good, the Bad and the Ugly"); and no TV series "After Sundown" was
found on 2026-10-30 (only a 2023 Thai film and a 2006 US film, which are
other works), so no released soundtrack of it was found.

| Key       | Made from        | Length | Command (ffmpeg, from the downloaded preview)                                                         |
| --------- | ---------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| whistle-1 | Freesound 699254 | 3.5 s  | `-i whistle.mp3 -af "atrim=0:3.5,afade=t=out:st=2.7:d=0.8" -c:a libmp3lame -b:a 128k -ar 44100 -ac 2` |

Refused on 2026-10-30:

- jaildoor-1 (TurtleLG, Freesound 80449): CC0 on its page, but the page
  says it is "a cut from hugeSlidingDoorSlamECM800.wav with added sounds".
  That recording is UATaudio's Freesound 31154, under CC BY 3.0, which
  needs a credit; the added sounds are not named.
- coconut-1 ("CUFFEM COCONUT", myinstants): no known origin. Know Your Meme
  has no entry, and the streamer stories are not confirmed. The hit may be
  the Sound Ideas library effect "COCONUT HIT 01".
- rizz-1 ("rizz sound effect", myinstants): no known origin. Fan videos say
  it comes from the film Kill Bill (2003); not confirmed.
- bonecrack-1 ("Bone Crack", myinstants): no known origin. No page names a
  library, a creator or a first video.

## Meme list, cycle 2 (slam, tada, tick, wind, whoosh, chomp, hit, uhoh, fall, fightbell, buzzer-2)

Director Rewriter, 2026-10-30, after Nil's C26 ("more variety of memes and
sound effects"): eleven sounds for the moments of the director's meme list.
Ten are CC0 on freesound.org, and each page says how the sound was made
(the Director Rewriter read each page on 2026-10-30; the renderer checked
the CC0 licence on each page the same day). buzzer-2 is our own, made with
ffmpeg. None is a voice: chomp-1 is a mouth's bite, with no word. The files
are Freesound's "HQ preview" mp3 (128 kbps), fetched 2026-10-30; the levels
in `meme-sounds.mjs` were measured the same day.

| Key         | Freesound title                     | Length | Uploader      | Why it is safe                                                          | Claim risk | Source page                                               |
| ----------- | ----------------------------------- | ------ | ------------- | ----------------------------------------------------------------------- | ---------- | --------------------------------------------------------- |
| slam-1      | Metal Door Slam_SoundSmith.wav      | 1.2 s  | Lunardrive    | A metal industrial door, recorded, "no effects"                         | Low        | https://freesound.org/people/Lunardrive/sounds/48980/     |
| tada-1      | TaDa!.wav                           | 4.2 s  | jimhancock    | A brass sting made in GarageBand; a cut, see below                      | Low        | https://freesound.org/people/jimhancock/sounds/376318/    |
| tick-1      | Clock ticking                       | 3.0 s  | Mortifreshman | A large mechanical clock (a MIG cockpit clock), recorded; a cut         | Low        | https://freesound.org/people/Mortifreshman/sounds/237210/ |
| wind-1      | Wind blowing into some cactus spine | 3.5 s  | felix.blume   | A field recording, Atacama desert (Schoeps + Sound Devices 744T); a cut | Low        | https://freesound.org/people/felix.blume/sounds/156414/   |
| whoosh-1    | Cartoony whooshes                   | 0.3 s  | BranRainey    | Recorded by the uploader for his web series; one whoosh of several      | Low        | https://freesound.org/people/BranRainey/sounds/142348/    |
| chomp-1     | Open Mouth Chomp.wav                | 1.4 s  | princessemilu | The uploader's own mouth, recorded; a cut                               | Low        | https://freesound.org/people/princessemilu/sounds/457475/ |
| hit-1       | Damage sound effect                 | 0.3 s  | Raclure       | "Created using Audacity"                                                | Low        | https://freesound.org/people/Raclure/sounds/458867/       |
| uhoh-1      | uh oh.mp3                           | 2.8 s  | nomiqbomi     | A sting made with organ and modulated guitar; a cut                     | Low        | https://freesound.org/people/nomiqbomi/sounds/578797/     |
| fall-1      | Cartoon Fall                        | 2.1 s  | plasterbrain  | "Made in Hybrid3"; the page says it "evokes" a game, not that it is one | Low        | https://freesound.org/people/plasterbrain/sounds/395443/  |
| fightbell-1 | Boxing Bell Signals                 | 2.0 s  | Mateusz_Chenc | A bicycle bell, recorded with a Zoom H1; the first signal only          | Low        | https://freesound.org/people/Mateusz_Chenc/sounds/520998/ |
| buzzer-2    | (our own)                           | 0.7 s  | renderer      | Two square waves, made with ffmpeg                                      | None       | none                                                      |

The cut points come from each upload's level per 100 ms (per 10 ms for the
short ones), not from listening:

- tada-1: the upload starts with 0.38 s of silence; the cut starts after it,
  so the sting hits on its event. Its tail is under -58 dB after 4.5 s.
- tick-1: the ticking is even from the start (about -48 dB, a tick each
  0.2 s); the first 3 s.
- wind-1: one gust, from 109.3 s: about -40 dB, then -32 dB at 110 s, then
  -42 dB at 112.5 s.
- whoosh-1: the upload is about ten short whooshes, each 0.1 to 0.2 s, with
  silence between; the cut is the fourth (0.59 to 0.83 s), the longest of
  the first five.
- chomp-1: the first 0.4 s is quiet mouth noise (about -47 dB); the bite is
  at 0.8 to 1.0 s of the upload.
- uhoh-1: the sting is at -16 to -19 dB for 0.8 s and falls to -41 dB by
  2.7 s; the cut ends at 2.8 s after a 0.8 s fade.
- fightbell-1: the upload has three bell signals (at 0.08, 9.3 and 17.8 s);
  the cut is the first one and its ring, faded out by 2.0 s. Whether that
  signal is one strike or a "ding ding" pair is not clear from the level.
- buzzer-2: 110 Hz and 116 Hz square waves together (they beat 6 times a
  second), 0.7 s; buzzer-1 is a different, higher buzz.

Four of them were limited in the file (Wall Game Director, 2026-10-30:
"bring them to the level of our usual hits"). Their peaks are high for
their loudness, so the true-peak ceiling (-10 dBTP) held them near -29
LUFS (tick-1, whoosh-1) and -25 (chomp-1, hit-1), against -21 for the
others. Each cut is raised, then limited at -12 dBFS (`alimiter`, 1 ms
attack, 50 ms release), so memeGain can bring it up: tick-1, chomp-1 and
hit-1 now play at -21 LUFS, whoosh-1 at -23. whoosh-1 is 0.24 s, shorter
than the 400 ms loudness window, so it reads low; to get it to -23 the
limiter cuts its peak by about 16 dB, more than the others; a listener
should check that it still sounds like a whoosh.

| Key         | Made from         | Length | Command (ffmpeg, from the downloaded preview)                                                                                                |
| ----------- | ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| tada-1      | Freesound 376318  | 4.2 s  | `-af "atrim=0.38:4.5,asetpts=PTS-STARTPTS,afade=t=out:st=3.32:d=0.8"`                                                                        |
| tick-1      | Freesound 237210  | 3.0 s  | `-af "atrim=0:3,afade=t=in:d=0.02,afade=t=out:st=2.7:d=0.3"`                                                                                 |
| wind-1      | Freesound 156414  | 3.5 s  | `-af "atrim=109.3:112.8,asetpts=PTS-STARTPTS,afade=t=in:d=0.3,afade=t=out:st=2.7:d=0.8"`                                                     |
| whoosh-1    | Freesound 142348  | 0.3 s  | `-af "atrim=0.59:0.83,asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=0.2:d=0.04"`                                                     |
| chomp-1     | Freesound 457475  | 1.4 s  | `-af "atrim=0.4:1.75,asetpts=PTS-STARTPTS,afade=t=in:d=0.02"`                                                                                |
| uhoh-1      | Freesound 578797  | 2.8 s  | `-af "atrim=0:2.8,afade=t=out:st=2.0:d=0.8"`                                                                                                 |
| fightbell-1 | Freesound 520998  | 2.0 s  | `-af "atrim=0.05:2.0,asetpts=PTS-STARTPTS,afade=t=out:st=1.4:d=0.55"`                                                                        |
| buzzer-2    | ffmpeg (no input) | 0.7 s  | `-f lavfi -i "aevalsrc='0.35*(sgn(sin(2*PI*110*t))+sgn(sin(2*PI*116*t)))':s=44100:d=0.7" -af "afade=t=in:d=0.01,afade=t=out:st=0.55:d=0.15"` |

Then the limited four (after the cut above): tick-1 `volume=29.6dB`,
whoosh-1 `volume=10.8dB`, chomp-1 `volume=5.6dB`, hit-1 `volume=2.1dB`,
each followed by `alimiter=limit=0.251:attack=1:release=50:level=disabled`.
Each is then written with `-c:a libmp3lame -b:a 128k -ar 44100 -ac 2`.
slam-1 and fall-1 are the previews as fetched; hit-1 is the preview,
limited.

## For -15 v4 (eternity-1, rewind-1)

Nil, 2026-11-01 (revise of v-2026-10-31-15, CASES C39): "one eternity later
has a sponge bob voice line, no? add it."

- eternity-1: the narrator's "One eternity later", from the meme pack's
  "Meme Videos/SpongeBob Time Cards In Order By Time.mp4" (Nil's pack, a
  compilation upload with no origin page). The card shows from about
  198.2 s; its audio starts after the edit's digital silence at
  198.25-198.29 s, and "later" ends in the dip before the next card's "so
  much later" (200.22 s). A transcript (Whisper small, on the 4090,
  2026-11-01) reads "one eternity later" at 198.0-200.24 s. HIGH claim
  risk (Nickelodeon): Nil asked for it, so it is OK'd for -15 v4.
- rewind-1: ours, made with ffmpeg (no input): two rising tones with a fast
  flutter and a little noise, a tape-rewind whir.
- crickets-1 and sneak-1: ours, for the two silent green-screen clips
  (Wall Game Director, 2026-11-01): two crickets chirping in the quiet
  (with gs-confused-travolta, tag huh), and a tiptoe pizzicato of eight
  plucked notes (with gs-terio-ooh, tag missed-punish).
- forward-1: ours, the same recipe higher and shorter, the fast-forward
  back to now (Wall Game Director, 2026-11-01: without it the flashback's
  past and forward ran 2.2 s quiet).

| Key        | Made from         | Length | Command (ffmpeg)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eternity-1 | the pack's video  | 1.9 s  | `-ss 198.29 -to 200.17 -i <video> -vn -af "afade=t=in:st=0:d=0.01,afade=t=out:st=1.82:d=0.06"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| forward-1  | ffmpeg (no input) | 0.8 s  | `-f lavfi -i "aevalsrc='0.35*sin(2*PI*(420*t+1600*t*t))*(0.55+0.45*sin(2*PI*43*t))+0.25*sin(2*PI*(840*t+3200*t*t))*(0.5+0.5*sin(2*PI*61*t))+0.12*(random(0)-0.5)':s=44100:d=0.8" -af "highpass=f=180,lowpass=f=7000,afade=t=in:st=0:d=0.03,afade=t=out:st=0.6:d=0.2"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| crickets-1 | ffmpeg (no input) | 3.0 s  | `-f lavfi -i "aevalsrc='0.35*sin(2*PI*4400*t)*gt(sin(2*PI*32*t),0.3)*lt(mod(t,0.6),0.14)+0.22*sin(2*PI*4900*t)*gt(sin(2*PI*36*t),0.3)*lt(mod(t+0.3,0.75),0.12)+0.01*(random(0)-0.5)':s=44100:d=3.0" -af "highpass=f=1500,afade=t=in:st=0:d=0.2,afade=t=out:st=2.6:d=0.4"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| sneak-1    | ffmpeg (no input) | 2.3 s  | `-f lavfi -i "aevalsrc='0.25*(gte(t,0.00)*exp(-14*(t-0.00))*(sin(2*PI*147*(t-0.00))+0.4*sin(4*PI*147*(t-0.00))+0.2*sin(6*PI*147*(t-0.00)))+gte(t,0.28)*exp(-14*(t-0.28))*(sin(2*PI*165*(t-0.28))+0.4*sin(4*PI*165*(t-0.28))+0.2*sin(6*PI*165*(t-0.28)))+gte(t,0.56)*exp(-14*(t-0.56))*(sin(2*PI*175*(t-0.56))+0.4*sin(4*PI*175*(t-0.56))+0.2*sin(6*PI*175*(t-0.56)))+gte(t,0.84)*exp(-14*(t-0.84))*(sin(2*PI*196*(t-0.84))+0.4*sin(4*PI*196*(t-0.84))+0.2*sin(6*PI*196*(t-0.84)))+gte(t,1.12)*exp(-14*(t-1.12))*(sin(2*PI*175*(t-1.12))+0.4*sin(4*PI*175*(t-1.12))+0.2*sin(6*PI*175*(t-1.12)))+gte(t,1.40)*exp(-14*(t-1.40))*(sin(2*PI*165*(t-1.40))+0.4*sin(4*PI*165*(t-1.40))+0.2*sin(6*PI*165*(t-1.40)))+gte(t,1.68)*exp(-14*(t-1.68))*(sin(2*PI*147*(t-1.68))+0.4*sin(4*PI*147*(t-1.68))+0.2*sin(6*PI*147*(t-1.68)))+gte(t,1.96)*exp(-14*(t-1.96))*(sin(2*PI*110*(t-1.96))+0.4*sin(4*PI*110*(t-1.96))+0.2*sin(6*PI*110*(t-1.96))))':s=44100:d=2.3" -af "afade=t=in:st=0:d=0.01,afade=t=out:st=2.1:d=0.2"` |
| rewind-1   | ffmpeg (no input) | 1.1 s  | `-f lavfi -i "aevalsrc='0.35*sin(2*PI*(260*t+900*t*t))*(0.55+0.45*sin(2*PI*31*t))+0.25*sin(2*PI*(520*t+1800*t*t))*(0.5+0.5*sin(2*PI*47*t))+0.12*(random(0)-0.5)':s=44100:d=1.1" -af "highpass=f=180,lowpass=f=6000,afade=t=in:st=0:d=0.04,afade=t=out:st=0.9:d=0.2"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Each is written with `-c:a libmp3lame -b:a 128k -ar 44100 -ac 2`.

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

## nono-1

Nil, 2026-11-01, to the Wall Game Director, with the file "No No No No -
Sound - SR.mp3" (15.7 s, 48 kHz stereo; no credit or origin in it): "this
sound effect is funny".

- nono-1: "Oh no no no no." A transcript (Whisper small, on the 4090,
  2026-11-01) reads the file as "Bruh. Look at this dude." (0.0-1.6 s),
  "Wait till you see the f-" (2.7-4.3 s; the "f-" is cut off and reads as
  the start of a swear word), then "Oh no no no no." (4.34-7.10 s). The
  cut starts in the silence at 4.34 s, after the "f-", and ends in the dip
  at 7.13 s; nothing before "Oh" is heard. MEDIUM claim risk: a voice from
  a recording of unknown origin.

| Key    | Made from  | Length | Command (ffmpeg)                                                                          |
| ------ | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| nono-1 | Nil's file | 2.8 s  | `-ss 4.34 -to 7.13 -i <file> -vn -af "afade=t=in:st=0:d=0.01,afade=t=out:st=2.73:d=0.06"` |

## Laughs and fear sounds, Freesound CC0 voices (2026-11-01)

Nil, C33: "you reuse the same laugh effect and the same 'oh no' a lot. try
more variety". The pack's own laughs and screams had no origin, so the
Director Rewriter fetched these nine (meme-pack bfdfc22: each page shows
"Creative Commons 0", and each page's text says the uploader recorded or
performed the sound; page, uploader and sha256 are in the director's
meme-pack.md). LOW claim risk. A key is `<family>-<n>`, so the director's
scream-f-2 and scream-m-2 are scream-1 and scream-2 here: one family, one of
the two a video. The files are Freesound's HQ preview mp3.

Words check (Whisper small, on the 4090, 2026-11-01), on the whole upload
and again on each cut. Agents cannot hear, so this and the cut points come
from Whisper and the level per 20 ms, not from listening:

- haha-1: "Uh-huh" (0-0.4 s), one short laugh; the whole upload.
- giggle-1: 30 s of a pitched-up voice that also says words ("It's me!",
  "Bye", 18-26 s). The cut, 6.40-7.32 s, reads as "Hahahaha!" only.
- crowdlaugh-2: Whisper writes different words on each pass ("Incredible,
  that's very important"; on the cut alone "Really Hetty Pie", then "Ha!"):
  guesses at crowd noise, not speech, and the page says "no dialogue". The
  cut is the loudest laugh, 8.95-10.75 s, with soft edges. A buried real
  voice cannot be ruled out by Whisper alone.
- evillaugh-2: "Ha ha ha ha ha!" (0-2 s); the whole upload.
- gasp-2: no words: a quiet whimper, then a gasp at 0.4-0.85 s; the whole
  upload.
- uhoh-3: "Uh oh." (0-0.4 s); the first 0.58 s. A voice (VOICE_KEYS).
- scream-1 (the director's scream-f-2, a woman): no words on the upload (on the short cut, Whisper guesses
  noise as words in other languages). Short screams at 1.5, 2.6, 3.6 and
  5.5 s; the cut is the first, 1.46-2.22 s.
- scream-2 (the director's scream-m-2, a man): one long even scream, 0.2-6.3 s ("AHHHH"); the cut is its
  first 1.6 s, faded out.
- nooo-1: "Nooo." (0-1.1 s); the whole upload.

Five had peaks high for their loudness (haha-1, giggle-1, evillaugh-2,
uhoh-3, nooo-1; giggle-1 and evillaugh-2 also over 0 dBFS in the upload),
so memeGain's true-peak ceiling would hold them under -21 LUFS. Each cut is
raised, then limited at -12 dBFS (`alimiter=limit=0.251:attack=1:release=50:level=disabled`),
as in cycle 2. evillaugh-2 still plays at about -22 LUFS: more gain only
limits it harder.

| Key          | Made from        | Length | Command (ffmpeg, from the downloaded preview)                                                                                |
| ------------ | ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| haha-1       | Freesound 572606 | 0.6 s  | `-af "atrim=0.02:0.62,asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=0.45:d=0.15"`, then `volume=6dB` and the limiter |
| giggle-1     | Freesound 243378 | 1.0 s  | `-af "atrim=6.40:7.32,asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=0.8:d=0.12"`, then `volume=1dB` and the limiter  |
| crowdlaugh-2 | Freesound 581528 | 1.8 s  | `-af "atrim=8.95:10.75,asetpts=PTS-STARTPTS,afade=t=in:d=0.15,afade=t=out:st=1.4:d=0.4"`                                     |
| evillaugh-2  | Freesound 478934 | 2.3 s  | `-af "atrim=0:2.3,afade=t=out:st=2.2:d=0.1"`, then `volume=2dB` and the limiter                                              |
| gasp-2       | Freesound 318078 | 1.0 s  | `-af "atrim=0:1.0,afade=t=out:st=0.9:d=0.1"`                                                                                 |
| uhoh-3       | Freesound 801391 | 0.6 s  | `-af "atrim=0:0.58,afade=t=out:st=0.48:d=0.1"`, then `volume=1dB` and the limiter                                            |
| scream-1     | Freesound 319258 | 0.8 s  | `-af "atrim=1.46:2.22,asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=0.66:d=0.1"`                                     |
| scream-2     | Freesound 169628 | 1.6 s  | `-af "atrim=0.10:1.70,asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=1.3:d=0.3"`                                      |
| nooo-1       | Freesound 818202 | 1.1 s  | `-af "atrim=0.02:1.12,asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=1.0:d=0.1"`, then `volume=1dB` and the limiter   |
