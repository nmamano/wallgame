# Music and sound licenses for the game videos

Whether a video posted by the Wall Game accounts (YouTube, X, TikTok,
Instagram, Facebook, Bluesky, Threads) may play each sound, and what credit
it must carry. Checked 2026-10-28 (Video Editor (renderer)); research only,
nothing was signed up for, bought or asked.

Music in the web app and music in a video posted on another platform are
different uses. A license for the first does not give the second.

**The status of each track is in `music-tracks.mjs` (`license`, `credit`).**
The renderer reads it: a video plays only an `ok` or `ok-with-credit` track,
and its ending carries the credit line (`creditLine`). This file holds the
sources behind each status.

| Sound                                                        | Status            | Open question                                                                                |
| ------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------- |
| Deja Vus (2nd loop), YannZ                                   | ok-with-credit    | (small) our copy is from itch.io; Nil can confirm the download's license .txt says CC BY 4.0 |
| Tea For Two, Aaron Paul Low (Uppbeat)                        | blocked-until-nil | see Uppbeat below                                                                            |
| A Legend, Ian Aisling (Uppbeat)                              | blocked-until-nil | see Uppbeat below                                                                            |
| Skippy Mr. Sunshine, Fernweh Goldfish (Uppbeat)              | blocked-until-nil | see Uppbeat below                                                                            |
| JDSherbert sound packs (move clicks, start, end, win, shake) | ok-with-credit    | none                                                                                         |
| Meme sounds from freesound.org                               | ok (CC0)          | none; see `meme-sounds.md`                                                                   |
| Meme sounds from myinstants.com                              | not cleared       | claim risk per clip in `meme-sounds.md`                                                      |

## Credit lines

- On the video: `creditLine` in `music-tracks.mjs`, for example
  `Music: Deja Vus by YannZ (CC BY 4.0) · Sounds: JDSherbert`.
- In the post text, per track played:
  - Deja Vus: `Music: "Deja Vus" by YannZ (https://yannz41.itch.io), CC BY 4.0`
  - An Uppbeat track (if Nil clears it): the line from `credits.txt`,
    `Music from #Uppbeat (free for Creators!): <track URL> License code: <code>`
  - JDSherbert, always: `Sounds by JDSherbert – https://jdsherbert.itch.io`

## Uppbeat (Tea For Two, A Legend, Skippy)

Source: the Uppbeat User Agreement, https://uppbeat.io/user-agreement, read
from the web.archive.org snapshot of 2026-02-17 (uppbeat.io refused
automated reads). Check the current version when logged in; Uppbeat renamed
its plans on 2025-05-20.

- Who: clause 4.3, "If you are a Free User, you must be an individual or a
  freelancer and you may use the Content only in material published by
  yourself." Clause 4.5, Uppbeat Creator: "an individual or an organisation
  that is a Micro Organisation" ("Businesses or organisations with 5
  employees or less"), "in material published by yourself or your
  organisation". Clause 4.6, Uppbeat Pro: "an organisation of any scale".
- Promotion: clause 4.1.1, "Not being Paid Advertising (unless you hold a
  Paid Subscription to Uppbeat Pro)". Paid Advertising: "Any material created
  by you or on your behalf with paid distribution and with the sole function
  of promoting a product or service." Clause 4.2: "Your material may include
  affiliations or sponsorships."
- Platforms: clause 5.1.1, "Open distribution platforms (such as YouTube,
  TikTok, Instagram, Facebook, Patreon, Twitch etc) where the material is
  directly published by you". The web app itself: clause 5.1.5, "Any
  web-based game or app".
- Credit: clause 6.3, "If you are a Free User, you must ensure that the
  appropriate Credit is given whenever you use any Music Track. This is a
  material term of this Agreement." The Credit is per track: "In respect of
  each Music Track, the credit provided by us to you on Content download from
  the Platform which must be used in conjunction with all uses of such
  Content by Free Users." So one code per track, in every post with it.
- Claims: clause 3.6, "In respect of YouTube use of each Music Track, we
  require that you follow all of our directions, including use of the Credit
  (where appropriate) to eliminate YouTube Copyright Claims", with no
  guarantee. Safelisting is for paid plans only. Nothing covers Meta or
  TikTok matching.

**Open question (Nil):** whose Uppbeat account made the three codes in
`credits.txt`, and are the Wall Game accounts published by him as an
individual or by an organisation? As an individual on the free plan: ok with
credit. As an organisation: Creator or Pro is needed. The answer sets the
three statuses in `music-tracks.mjs`.

## Deja Vus, YannZ (pack "Contemplative Fantasy")

- Our copy came from https://yannz41.itch.io (credits.txt); the itch.io page
  refused automated reads.
- OpenGameArt lists the same pack,
  https://opengameart.org/content/free-contemplative-fantasy-music-pack,
  under "License(s): CC-BY 4.0": "You're free to use the tracks in both
  commercial and non-commercial projects as long as you provide proper
  credit."
- In that page's comments (2025-04-21) a moderator said the pack's own
  license file had a "Prohibited Uses" section that conflicts with CC BY.
  YannZ answered: "I'm happy to adjust the submission and remove the
  additional clauses (no resale/redistribution, etc.) so that the pack is
  fully compliant with CC-BY 4.0 ... I'll also make sure the .txt license in
  the download is updated to reflect only the CC-BY 4.0 terms."
- CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) allows any use,
  commercial and promotional included, with attribution.
- Claims: the album is on Spotify, so a distributor may have registered it in
  YouTube Content ID. A claim would be disputed with the CC BY 4.0 grant.

## JDSherbert (Tabletop Games SFX Pack, Pixel Game Essentials SFX Pack)

`assets/audio/wav_sd/LICENSE.pdf` (byte-identical to
`assets/audio/pixel_game_essentials/LICENSE.pdf`):

- "You can use these assets in any project, including free or commercial
  work such as games, films, apps, or videos."
- "You can sell or share your finished project that includes these assets."
- "You must credit me somewhere visible in your project (credits,
  description, or readme)." Example: "Sounds by JDSherbert –
  https://jdsherbert.itch.io"

## Meme sounds

See `meme-sounds.md`: the freesound.org clips are CC0 (no credit, no claim
kept); the myinstants.com clips are other people's uploads of others' works,
with a claim-risk note per clip (high: `win-2`, `shotgun-1`, `shotgun-4`,
`laugh-1`).
