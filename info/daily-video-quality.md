# Daily video quality audit

Audit date: 2026-10-26. Scope: the daily short (9:16, 1080x1920, 30 fps)
that `scripts/game-video/daily/` picks, the Director edits and
`render-game-video.mjs` renders. This doc lists what to fix next, after the
six moment effects (blunder, brilliant, trap, race, freeze, react, added in
824c3e34) and the new meme sounds (99cdf108).

## What was audited

Three renders, each watched as stills (one per second, plus key frames):

| Video     | Variant  | Length | Nil's verdict (2026-10-26)                         |
| --------- | -------- | ------ | -------------------------------------------------- |
| XMaenOP1  | Classic  | 28.5 s | Rejected: 4 reasons (see "Already fixed")          |
| N42PHQnw  | Standard | 39.1 s | "this is actually pretty good! i only have nits"   |
| eeFSMEmL  | Standard | 29.7 s | Test render (EDL v4); no verdict on this cut       |

The N42PHQnw file audited is the one Nil judged: the same file was attached to
his approval request and shown to him before his verdict. Its caption in the
video is "Blue dodged it... for now", and the VS overlay still had the 🤖 and
🧑 emojis that he then asked to remove. The text "narwhal thought one wall was
enough" was the post text for X and YouTube, not part of the video.

Times below are seconds into the video. Agents cannot hear, so sound is judged
only from measurements (ffmpeg `ebur128`, `silencedetect` at -40 dB).

Layout facts (measured on the frames, 2026-10-26): the caption line is at
y 343-397, the board at y 436-1483 and x 16-1064, the `wallgame.io` line at
y 1526-1558. With a one-line caption, rows 0-343 and 1558-1920 are plain
black (XMaenOP1's three-line caption starts at y 204).

## Platform guidance used

Only claims we could open and quote:

- TikTok, "Creative best practices" (updated June 2025): "Introduce your
  content proposition in the first 3 seconds for better recall and awareness."
  "Prioritize your hook in the first 6 seconds to boost engagement and
  increase watch time." "We recommend displaying 5-10 words per second when
  using text." https://ads.tiktok.com/help/article/creative-best-practices
- Meta, Instagram Reels video ad spec: "Consider leaving at least 14% of the
  top, 35% of the bottom, and 6% on each side of your asset free from text,
  logos, or [other key creative elements]". On 1080x1920 the safe area is
  x 65-1015, y 269-1248.
  https://www.facebook.com/business/ads-guide/update/video/instagram-reels
- Instagram, "Instagram Ranking Explained" (Mosseri, 2023-05-31): for Reels,
  "The most important predictions we make are how likely you are to reshare a
  reel, watch a reel all the way through", and reels that are "muted or
  contain borders" or "watermarked" are made "less visible".
  https://about.instagram.com/blog/announcements/instagram-ranking-explained
- YouTube Help, content performance: an engaged view is "How many times
  viewers stayed to watch past the initial seconds, not including any loops".
  https://support.google.com/youtube/answer/12220281

Not checked: the loudness that each platform normalizes to (no platform
publishes a number we could open), and TikTok's exact organic safe zone (its
spec says the zone depends on dimension and caption length).

## Backlog, ranked

### 1. A newcomer cannot tell what is at stake

- **Evidence:** nothing on screen says what wins. N42PHQnw shows four animals
  (a cat and a mouse for each side) and three wall colours with no key. The
  eeFSMEmL caption "the bot was 97% winning" names a number that no graphic
  shows. The N42PHQnw caption "Blue dodged it... for now" is the only text for
  all 39 s. Nil, 2026-10-26: "it plays too fast to follow waht's going on.
  maybe slow it down or think of other ways to make it more clear".
- **Fix:** show the race all the time, not only around one move. The new
  `race` kind counts each side's steps to its target for at most 12 plies;
  make a counter that runs for the whole video ("Red 3 / Blue 9"), and flash
  the number that jumps on the key wall. During the VS overlay, show one goal
  line from the variant ("cat catches mouse", "first cat home wins").
- **Owner:** `stage.html`, `render-game-video.mjs` (counter and goal line),
  `race-replay.ts` (numbers), `edl.mjs` (a whole-video race), `DIRECTOR.md`.

### 2. The first 3.4 s are a still name card

- **Evidence:** the VS overlay holds 4.0 s and the first move waits until its
  exit starts at 3.4 s (`__VS_OVERLAY` in `stage.html`, `firstMoveAt` in
  `render-game-video.mjs`). N42PHQnw and eeFSMEmL show only the card for
  0-3 s (the older XMaenOP1 card held 2 s). The key moment of eeFSMEmL (zoom,
  then "NOPE") is at 11-12 s, and the first sound above -40 dB is at about
  0.5 s. TikTok asks for the content proposition in the first 3 s. Nil wants
  both sides: 2026-10-26 00:11, "the vs screen ... probably will lose us
  viewers? what if it appears as an overlay while the game itself starts
  playing, maximize stimuli"; 02:14, "wait to start playing the
  game until after the banner starts disappearing".
- **Fix:** a cold open. The video starts on the key position for about 1 s
  (the wall that matters glows, the caption is already up), then cuts to the
  VS overlay and the game. Also let the Director start at a later ply, so the
  quiet opening (eeFSMEmL plies 0-8, 4.5 s) is cut. Render both versions side
  by side for Nil; this changes his 02:14 request, so it is his choice.
- **Owner:** `edl.mjs` (a `teaser` and a `startPly`), `render-game-video.mjs`,
  `DIRECTOR.md`.

### 3. Goals, counters and edges sit where the apps paint their buttons

- **Evidence:** the board ends at y 1483, but Meta's safe area ends at
  y 1248, so the bottom 235 px (almost two rows) can be covered by the
  caption and buttons. In Classic the two houses sit in exactly those bottom
  corners (XMaenOP1 at 3.0 s: the houses in a1 and h1 are at y 1372-1455, and
  the red one reaches x 1030). The board's outer columns pass the 6% side
  margin by 49 px, on the side where the apps put their buttons. The `race`
  counter (now in HEAD) is drawn under the board (y > 1483), which is
  completely inside the covered band. `wallgame.io` at y 1526-1558 is also
  inside it.
- **Fix:** move the stack up and shrink the board to fit the safe area (for
  example a 900 px board at x 90-990, top at y ~330, caption above it at
  y 269+). Put the race counter above the board, next to the caption.
  Add a check in `crew.mjs check` that fails a render whose caption, counter
  or goal cells are outside the safe rectangle.
- **Owner:** `render-game-video.mjs` (`WALLZ_LAYOUT`), `stage.html`,
  `crew.mjs`.

### 4. Stamps cover the move they mark

- **Evidence:** eeFSMEmL at 12.0 s: "NOPE" covers the upper half of both
  cats and the red walls above them, next to the glowing key wall. The viewer
  reads the word while the pawns it is about are half hidden.
- **Fix:** place a stamp in the half of the board away from the event cell
  and its walls, or in the caption band. Let the move be seen for about 0.3 s
  before the stamp lands.
- **Owner:** `stage.html`, `render-game-video.mjs`.

### 5. Videos run long for what they show

- **Evidence:** N42PHQnw is 39.1 s for 57 plies; the middle runs at about
  0.6 s per move on average, mostly with no event. Mosseri names "watch a
  reel all the way through" as one of the most important Reels predictions.
  Nil liked the Director's variable pace (2026-10-26: "i like that the
  director adjusted the speed of moves based on how much action was going
  on"), but he also said "it plays too fast to follow" (item 1).
- **Fix:** give the Director a fast-forward range (several plies at 0.2-0.3 s
  with a small "x4" tag) and a target of 20-25 s. Keep the slow pace only
  around the key wall. Faster quiet stretches pull against his "too fast to
  follow", so render a short and a current-length cut side by side, and let
  Nil choose.
- **Owner:** `edl.mjs` (pace limits), `DIRECTOR.md`, `storyboard.ts` (mark
  quiet stretches).

### 6. The end does not loop, and it goes silent first

- **Evidence:** all three audited renders end on a zoomed "CAUGHT" frame (the
  replay ending) and start on the VS card, so a loop is a hard cut between two
  unrelated frames. HEAD rotates three endings (replay, gg, ko) and stamps
  HOME in Classic; each ending still ends far from the opening frame. Each mix
  falls below -40 dB for 1.5-1.8 s just before the end (XMaenOP1 25.1-26.6 s,
  N42PHQnw 35.7-37.2 s, eeFSMEmL 26.0-27.8 s). On a phone, that sounds like the
  video stopped.
- **Fix:** end on a frame that leads into the first one (for example the
  final position with the opening caption, which matches a cold open from
  item 2). Keep a quiet bed under the replay's hush instead of silence;
  confirm with Nil that the hush is wanted at all.
- **Owner:** `stage.html` (endings), `render-game-video.mjs` (mix).

### 7. A third wall colour has no meaning for a viewer

- **Evidence:** N42PHQnw and eeFSMEmL show brown walls from the first frame,
  next to the red and blue walls the players place. With Red vs Blue as the
  only story (Nil, 2026-10-26: "Red vs Blue always is probably best"), a third
  colour is noise.
- **Fix:** draw walls that were on the board at the start in a muted grey in
  the daily look.
- **Owner:** `stage.html` (daily colours).

### 8. The frame has black borders and a watermark

- **Evidence:** with a one-line caption, rows 0-343 and 1558-1920 are plain
  black (37% of the frame). Instagram makes reels that "contain borders" or
  are "watermarked" less visible; whether its check treats a black background
  or our own URL that way is not checked.
- **Fix:** fill the frame with the board theme's background (a soft gradient
  or the board's grid, faded) so there is no flat band. Move `wallgame.io`
  into the caption band, or show it only on the end frame.
- **Owner:** `stage.html`, `render-game-video.mjs`.

### 9. One caption for the whole video

- **Evidence:** each video shows one caption from 0 s to the end. TikTok
  suggests 5-10 words per second when text is used. Our inference, not
  TikTok's claim: a 6-word line is read in about a second, so for the other
  30 s the text adds nothing new. Nil, 2026-10-26 on
  XMaenOP1: "Caption was actually way too long" (22 words over 3 lines).
- **Fix:** two short beats: a setup line until the key wall ("Red is 3 steps
  from winning"), then the payoff ("now it's 19"). The Director writes both.
- **Owner:** `edl.mjs` (caption beats), `stage.html`, `DIRECTOR.md`.

### 10. No measured check of meme loudness against the music

- **Evidence:** integrated loudness is -21.8 to -23.3 LUFS with peaks up to
  -3.6 dBFS (2026-10-26). Nil, 2026-10-26: "some sound effects, like the baby
  cry and the initial shotgun, are a bit too loud". The renderer now aims each
  meme at -21 LUFS, but no check compares a sting with the music under it.
- **Fix:** add the loudest momentary loudness minus the integrated loudness
  to `crew.mjs check`, and fail a render above a limit that Nil approves by
  ear on two or three samples.
- **Owner:** `crew.mjs` (check), `render-game-video.mjs` (gains).

## Already fixed (do not reopen)

From Nil's feedback on 2026-10-26, now in HEAD:

- "the end said "CAUGHT" but actually in this game mode it's not catching,
  it's getting home": a Classic win stamps HOME (`FINISH_WORD`).
- "the FAH effects are on the wrong moves": the picker uses walking-distance
  jumps, and the Director places each effect from a storyboard of the game.
- "zoomed in on the wall on the left instead of the one that actually blocked
  tthe cat": the Director names the zoom frame in the EDL.
- "just use Blue and Red": the overlay says "AI" / "Human" (or "Human" /
  "Human"), and the caption says Red and Blue, not names.
- "Maybe remove the emojis" and "wait to start playing the game until after
  the banner starts disappearing": done in the VS overlay.
- "the final effect is too similar to wallz": three own endings, rotated.
