/**
 * Nil's review queue (Nil, via Wall Game Growth, 2026-10-28): the page at
 * /review (until 2026-10-31 also the app's "/"; Nil now reviews in his
 * Isomux inbox). Nil, 2026-10-28: "I literally
 * only need to see the videos and captions. Everything else is context i
 * don't need." So it shows every item in review (store.mjs reviewState),
 * oldest first, each with ONLY its video, its caption (the post's text, one
 * line: postCaption), the YouTube title when it differs (a small "YouTube:"
 * line: it is its own text, and Approve binds it), one red line for each sound with a high claim risk
 * that the video plays (Wall Game Director, 2026-10-28: the director kept
 * it on purpose, so Nil sees the risk), one red line when the video posts
 * no Instagram Story (noStoryLine; Wall Game PM, 2026-10-29: Nil approves
 * that knowingly) and three actions:
 *
 *   Approve  -> approved: the item posts at the next slot (Wall Game Worker
 *               1's scheduler), bound to this video and this block
 *   Revise   -> back to the director as a draft, same id, with Nil's notes
 *               (required); it is in review again only with a new render
 *               AND a new block
 *   Discard  -> discarded, with Nil's notes (required)
 *
 * Right after an Approve, the card offers Undo (withdraw: in review again),
 * so a mis-tap on a phone is undone without a confirm dialog. The page has
 * two tabs with their counts (its Social tab left on 2026-10-31):
 * "In review" (the queue) and "Approved" (Nil, 2026-10-30; "#approved" opens it), where each approved item that
 * no slot took yet shows when it posts, its video, its caption and one
 * button, "Undo approval" (the same withdraw), so Nil can take back an
 * approval later too (Nil, 2026-10-29: v-2026-10-28-3 was
 * approved, and he wanted it revised before its slot). A reason shows
 * only when an action cannot work: a refusal, or Approve disabled while
 * another video of the game posts or the render's music may not play
 * (store.mjs approveProblem). No counts, ids, slots or copy-block details:
 * the agents read those from crew.mjs and /api/review/status.
 *
 * Two small buttons in the top corner, − and +, zoom the cards in steps of
 * 25%, up to a video that fills the window (Nil, 2026-10-28: the office's
 * app frame cannot go full screen); the browser keeps the level
 * (localStorage).
 *
 * POST /api/review/<id>/approve|discard|revise takes {notes, videoSha256,
 * copySha256}: the hashes of what the page showed, so Nil approves what he
 * saw, not a newer render. POST /api/review/<id>/withdraw takes {notes}.
 * Every action goes to the feedback log, and the app tells the director AT
 * ONCE (Nil, 2026-10-28: "the feedback i enter in the app should go
 * straight to director"). A failed message does not undo the action: the
 * row is stored and a warning is logged.
 *
 * ONLY NIL REVIEWS. The office sets X-Isomux-Member-Id on each request
 * through the app's address and removes any X-Isomux-* header that the
 * browser sends, so no other member can act. A request with no member did
 * not come through the office: it is refused too. The limit: a process on
 * this box can call the app's port directly and set the header; crew.mjs
 * and the posters never send it, and a test checks that crew cannot reach
 * these routes.
 *
 * The review never writes posting, posted, post-failed or posts{}: those
 * are the poster's.
 */
import { copySha256 } from "./copy.mjs";
import { renderScriptReview, StepRefused } from "./store.mjs";
import { DIRECTOR_AGENT_ID } from "./office.mjs";
import { quoteLines } from "./quote.mjs";
import { claimRisk, soundUses } from "./sounds.mjs";
import { noStoryLine } from "./post-instagram.mjs";

/** The office member who reviews: Nil (his id in the office's users.json). */
export const REVIEWER_MEMBER_ID = "6f26107a";

/** POST /api/review/<item id>/<action>. */
export const REVIEW_ACTION_PATH =
  /^\/api\/review\/(v-\d{4}-\d{2}-\d{2}-[A-Za-z0-9]+)\/(approve|discard|revise|withdraw)$/;

/**
 * The caption Nil reads: the post's text on X, one line, without the music
 * credit that Growth puts after " · music:". The other platforms' lines
 * may differ (the YouTube title is its own text; Bluesky adds a link,
 * TikTok and Instagram add hashtags), and Approve binds the whole block.
 * @param {Record<string, string>} block Growth's copy block (copy.mjs)
 */
export const postCaption = (block) =>
  (block.x ?? "").split(/\s+·\s+music:/i)[0].trim();

/**
 * What the page shows: every item in review, oldest first, with only what
 * Nil sees and what his actions send back.
 * @param {ReturnType<import("./store.mjs").openStore>} store
 */
/**
 * The line at the top of a card whose game has another video (Nil,
 * 2026-10-29, CASES.md C15: "if you show me 2 versions of the same game,
 * let me know"), from store.sameGame, the rule pick uses; null when the
 * game has no other item.
 * @param {{ gameId: string }} item
 * @param {{ id: string, shown: string }[]} others
 */
export const versionLine = (item, others) => {
  if (others.length === 0) return null;
  // A count, not a rank: every card of the game says the same, so the
  // older card never reads as the remake (VR1 and Wall Game PM, review 79).
  const list = others.map((o) => `${o.id} (${o.shown})`).join(", ");
  return `one of ${others.length + 1} videos of game ${item.gameId}; the other${others.length > 1 ? "s are" : " is"} ${list}`;
};

/**
 * The line on a card whose video renders a script carried over Nil's revise
 * (store.recordScriptUnchanged), or null: no fresh reviewer read the script
 * after his revise, and Nil must not think one did (VR1, review 100).
 * @param {{ carried?: { from: string } } | null} scriptReview the review
 *   the render passed under (store.renderScriptReview)
 */
export const carriedScriptLine = (scriptReview) =>
  scriptReview?.carried
    ? `Script unchanged (carried from the script review of ${scriptReview.carried.from.slice(0, 16).replace("T", " ")} UTC).`
    : null;

/**
 * The line on an approved card: when it posts. The post queue is
 * store.approvedQueue (oldest approval first), and the next slot takes its
 * head (scheduler.mjs status nextSlot); the others wait their turn (Wall
 * Game PM, 2026-10-30: Nil must see why the card is there).
 * @param {number} index the item's place in the post queue
 * @param {{ pacific: string, willPost: boolean, why: string | null }} nextSlot
 */
export const approvedLine = (index, nextSlot) =>
  index > 0
    ? "Approved: posts after the video above."
    : nextSlot.willPost
      ? `Approved: posts at ${nextSlot.pacific}.`
      : `Approved: no slot posts it yet (${nextSlot.why ?? "no slot"}).`;

/**
 * @param {ReturnType<import("./store.mjs").openStore>} store
 * @param {{ pacific: string, willPost: boolean, why: string | null }} nextSlot
 */
export const reviewView = (store, nextSlot) => ({
  items: store.inReview().map((it) => ({
    // For the action's address and the video's; the page does not show it.
    id: it.id,
    videoSha256: it.render.video.sha256,
    // Recomputed, as store.review compares it: a stored hash from an
    // older definition would refuse every action on the item.
    copySha256: copySha256(it.copy.block),
    caption: postCaption(it.copy.block),
    // The YouTube title is its own text, and Approve binds it too: the
    // card shows it when it is not the caption (Wall Game Director,
    // 2026-10-28; also while YouTube is a dry run).
    youtubeTitle:
      it.copy.block.youtubeTitle === postCaption(it.copy.block)
        ? null
        : it.copy.block.youtubeTitle,
    // Why Approve cannot work now, or null: the page disables it.
    approveProblem: store.approveProblem(it),
    // Each sound with a high claim risk that the video plays, once: the
    // director kept it on purpose, and Nil must see the risk.
    claimRiskSounds: [
      ...new Set(
        soundUses(it.edl.doc)
          .map(([, key]) => key)
          .filter((key) => claimRisk(key)),
      ),
    ],
    noStory: noStoryLine(it.render.video),
    version: versionLine(it, store.sameGame(it)),
    scriptCarried: carriedScriptLine(renderScriptReview(it)),
  })),
  // Approved and no slot took it yet (a slot makes it posting), in post
  // order: Nil may still take the approval back (withdraw).
  // A held item (store.hold) is still approved, so it is listed, after the
  // queue, with its hold.
  approved: [
    ...store
      .approvedQueue()
      .map((it, i) => ({ it, when: approvedLine(i, nextSlot) })),
    ...store.held().map((it) => ({
      it,
      when: `Approved, held: it does not post (${it.hold.why}).`,
    })),
  ].map(({ it, when }) => ({
    id: it.id,
    // Approve requires a block today; a guard keeps the page usable if an
    // approved item ever has none (VR1, review 80).
    caption: it.copy ? postCaption(it.copy.block) : "(no post text)",
    when,
  })),
});

/** The director's message about one review action: everything to act on. */
export const directorText = (item, action, notes) =>
  [
    `REVIEW: Nil chose ${action.toUpperCase()} on ${item.id} (game ${item.gameId}).`,
    ...(notes ? ["Notes, verbatim:", ...quoteLines(notes)] : ["Notes: (none)"]),
    `Video: ${item.render.video.path}`,
    {
      revise: `It is a draft again: make a new render, then get a new block from Wall Game Growth (both after this revise).`,
      approve: "It is approved and posts at the next slot.",
      discard:
        "It is discarded; carry its game over to a new item only if Nil's notes ask for it.",
      withdraw:
        "Nil took back his approval: it is in review again, with the same video and block. Nothing posts.",
    }[action],
  ].join("\n");

/** A refusal with its HTTP status (403: who; 409: the item's state). */
export class ReviewRefused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * One review action. Refuses anyone but the reviewer (and a request with
 * no member), then lets the store check the item and the hashes. The
 * director is told after the action is stored; `directorTold` says whether
 * the office took the message.
 * @param {object} deps
 * @param {ReturnType<import("./store.mjs").openStore>} deps.store
 * @param {{ id: string, name: string } | null} deps.member
 * @param {string} deps.id
 * @param {"approve" | "discard" | "revise" | "withdraw"} deps.action
 * @param {{ notes?: unknown, videoSha256?: unknown, copySha256?: unknown }} deps.body
 * @param {(targetAgentId: string, text: string) => Promise<void>} deps.send
 * @param {{ warn: (m: string) => void }} [deps.log]
 */
export const reviewAction = async ({
  store,
  member,
  id,
  action,
  body,
  send,
  log = console,
}) => {
  if (!member) {
    throw new ReviewRefused(
      403,
      "open /review through the office (the app's address), signed in as Nil",
    );
  }
  if (member.id !== REVIEWER_MEMBER_ID) {
    throw new ReviewRefused(403, "only Nil reviews videos");
  }
  const notes = typeof body.notes === "string" ? body.notes : "";
  let item;
  try {
    item =
      action === "withdraw"
        ? store.withdraw(id, { notes, by: member.name, memberId: member.id })
        : store.review(id, {
            action,
            notes,
            videoSha256: body.videoSha256,
            copySha256: body.copySha256,
            by: member.name,
            memberId: member.id,
          });
  } catch (err) {
    if (err instanceof StepRefused) throw new ReviewRefused(409, err.message);
    throw err;
  }
  let directorTold = true;
  try {
    await send(DIRECTOR_AGENT_ID, directorText(item, action, notes));
  } catch (err) {
    directorTold = false;
    log.warn(
      `review ${action} ${id}: the director was not told: ${err.message}`,
    );
  }
  return { item, directorTold };
};

export const REVIEW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wall Game videos</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f1c; color: #e2e8f0;
         margin: 0; padding: var(--top) 12px 40px; display: flex; justify-content: center; }
  /* --z: the zoom (Nil, 2026-10-28); 1 is the size a phone always had.
     --top: the space above the first card, for the zoom buttons. */
  :root { --top: 50px; }
  main { width: 100%; max-width: calc(520px * var(--z, 1)); }
  .card { margin-bottom: 28px; }
  /* The box is the picture's own shape (9:16 until its size loads): no bars. */
  video { display: block; width: auto; height: auto; max-width: 100%; max-height: min(calc(78vh * var(--z, 1)), calc(100vh - var(--top) - 8px));
          aspect-ratio: auto 9 / 16; margin: 0 auto; border-radius: 10px; background: #000; }
  .caption { font-size: 17px; line-height: 1.4; margin: 10px 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
  textarea.need { border-color: #f87171; }
  textarea { width: 100%; box-sizing: border-box; min-height: 44px; background: #0b1222; color: #e2e8f0;
             border: 1px solid #334155; border-radius: 8px; padding: 8px; font: inherit; font-size: 15px; }
  .actions { display: flex; gap: 8px; margin-top: 8px; }
  button { flex: 1; padding: 12px; border-radius: 8px; border: 0; font-weight: 700; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: 0.45; cursor: default; }
  .approve { background: #16a34a; color: #fff; } .revise { background: #ca8a04; color: #1a1005; }
  .discard { background: #475569; color: #fff; }
  .undo { flex: 0 0 auto; padding: 8px 14px; background: #334155; color: #fff; font-size: 14px; }
  .done { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 15px; }
  .alt { color: #94a3b8; font-size: 14px; margin: -4px 2px 10px; overflow-wrap: anywhere; }
  .risk { color: #f87171; font-size: 15px; font-weight: 700; margin: 0 2px 10px; }
  .version { color: #fbbf24; font-size: 15px; font-weight: 700; margin: 0 2px 10px; }
  .why { color: #fca5a5; font-size: 14px; margin-top: 6px; white-space: pre-wrap; }
  .zoom { position: fixed; top: 8px; right: 8px; z-index: 1; display: flex; gap: 6px; }
  .zoom[hidden] { display: none; }
  .zoom button { flex: none; width: 34px; height: 34px; padding: 0; font-size: 20px; line-height: 1;
                 background: rgba(51, 65, 85, 0.85); color: #fff; }
  .quiet { color: #94a3b8; text-align: center; margin-top: 40px; }
  .tabs { display: flex; gap: 8px; margin: 0 0 16px; }
  .tabs button { flex: 0 0 auto; padding: 9px 14px; background: #1e293b; color: #cbd5e1; font-size: 15px; }
  .tabs button.on { background: #e2e8f0; color: #0b0f1c; }
</style></head>
<body><div class="zoom" id="zoom" hidden><button id="zoom-out" aria-label="Smaller videos">−</button><button id="zoom-in" aria-label="Larger videos">+</button></div>
<main><nav class="tabs" id="tabs"></nav><div id="list"></div></main>
<script>
  // NOTHING HERE MAY USE innerHTML: captions and refusals are untrusted text.
  const el = (tag, cls, text) => { const n = document.createElement(tag);
    if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };

  const LOST = "No answer from the app: reload the page.";

  /** null when the action is stored, or {error, retry}: no retry when the
   * answer was lost, because the action may be stored. */
  const post = async (id, action, body) => {
    let res;
    try {
      res = await fetch("/api/review/" + encodeURIComponent(id) + "/" + action, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } catch { return { error: LOST, retry: false }; }
    if (res.ok) return null;
    const out = await res.json().catch(() => ({}));
    return { error: out.error || "HTTP " + res.status, retry: true };
  };

  const card = (it, canReview) => {
    const box = el("section", "card");
    const video = el("video"); video.controls = true; video.playsInline = true; video.preload = "metadata";
    // "#t=0.5": a phone shows that frame before play, not a black box.
    video.src = "/api/daily/video?item=" + encodeURIComponent(it.id) + "#t=0.5";
    const notes = el("textarea"); notes.placeholder = "Notes (needed to revise or discard)";
    const why = el("div", "why");
    /** A refusal, right under the buttons, scrolled into view. */
    const refused = (text) => { why.textContent = text; why.scrollIntoView({ block: "nearest" }); };
    const row = el("div", "actions");
    const buttons = [["approve", "Approve"], ["revise", "Revise"], ["discard", "Discard"]].map(([action, label]) => {
      const b = el("button", action, label);
      b.disabled = !canReview;
      b.onclick = async () => {
        why.textContent = ""; notes.classList.remove("need");
        // Revise and Discard need a note (the same rule as store.mjs review,
        // which stays the judge: change both together): say so here,
        // before anything is sent, and put the cursor in the note box (Nil,
        // 2026-10-30: a Revise with no note looked done but was refused).
        if (action !== "approve" && !notes.value.trim()) {
          refused("Write a note first: " + (action === "revise" ? "what should change?" : "why discard it?"));
          notes.classList.add("need"); notes.focus();
          return;
        }
        buttons.forEach((x) => (x.disabled = true));
        const failed = await post(it.id, action,
          { notes: notes.value, videoSha256: it.videoSha256, copySha256: it.copySha256 });
        if (failed) { refused(failed.error); if (failed.retry) buttons.forEach((x) => (x.disabled = false)); return; }
        done(box, it, action);
      };
      row.append(b); return b;
    });
    if (it.approveProblem) { buttons[0].disabled = true; why.textContent = it.approveProblem; }
    if (it.version) {
      // A new line after the game, so an item id never breaks at its "-".
      const line = el("div", "version");
      it.version.split("; ").forEach((part, i, all) => {
        if (i) line.append(document.createElement("br"));
        line.append(part + (i < all.length - 1 ? ";" : ""));
      });
      box.append(line);
    }
    box.append(video, el("div", "caption", it.caption));
    if (it.youtubeTitle) box.append(el("div", "alt", "YouTube: " + it.youtubeTitle));
    for (const key of it.claimRiskSounds) box.append(el("div", "risk", "Uses " + key + ": a claim is possible."));
    if (it.noStory) box.append(el("div", "risk", it.noStory));
    if (it.scriptCarried) box.append(el("div", "alt", it.scriptCarried));
    box.append(notes, row, why);
    return box;
  };

  /** The card after an action: one line, and Undo right after an Approve. */
  const done = (box, it, action) => {
    const line = el("div", "done");
    line.append(el("span", null, { approve: "Approved.", revise: "Sent back to the director.", discard: "Discarded." }[action]));
    const why = el("div", "why");
    if (action === "approve") {
      const undo = el("button", "undo", "Undo");
      undo.onclick = async () => {
        undo.disabled = true;
        const failed = await post(it.id, "withdraw", { notes: "" });
        if (failed) { why.textContent = failed.error; undo.disabled = !failed.retry; return; }
        load();
      };
      line.append(undo);
    }
    box.replaceChildren(el("div", "caption", it.caption), line, why);
  };

  /** An approved item that no slot took: its video, caption and Undo approval. */
  const approvedCard = (it, canReview) => {
    const box = el("section", "card");
    const video = el("video"); video.controls = true; video.playsInline = true; video.preload = "metadata";
    video.src = "/api/daily/video?item=" + encodeURIComponent(it.id) + "#t=0.5";
    const why = el("div", "why");
    const undo = el("button", "undo", "Undo approval");
    undo.disabled = !canReview;
    undo.onclick = async () => {
      undo.disabled = true; why.textContent = "";
      const failed = await post(it.id, "withdraw", { notes: "" });
      if (failed) { why.textContent = failed.error; undo.disabled = !failed.retry; return; }
      load();
    };
    const line = el("div", "done"); line.append(undo);
    box.append(el("div", "version", it.when), video, el("div", "caption", it.caption), line, why);
    return box;
  };

  // Two tabs (Nil, 2026-10-30: "make tabs for the pending queue vs
  // approved queue so i can find"), with their counts. "#approved" in the
  // address opens that tab, so a link can point at it. The Social tab left
  // on 2026-10-31 (the stats are in the Growth app).
  const TABS = [["review", "In review"], ["approved", "Approved"]];
  let tab = location.hash === "#approved" ? "approved" : "review";

  const load = async () => {
    const list = document.getElementById("list");
    const tabs = document.getElementById("tabs");
    let v;
    try { v = await (await fetch("/api/review/queue")).json(); }
    catch { list.replaceChildren(el("p", "quiet", LOST)); return; }
    const of = { review: v.items, approved: v.approved };
    tabs.replaceChildren(...TABS.map(([key, label]) => {
      const b = el("button", key === tab ? "on" : "", of[key] ? label + " (" + of[key].length + ")" : label);
      b.onclick = () => {
        tab = key;
        history.replaceState(null, "", key === "review" ? location.pathname + location.search : "#" + key);
        load();
      };
      return b;
    }));
    list.replaceChildren();
    if (!v.canReview) list.append(el("p", "quiet", "Only Nil reviews these videos; you can watch."));
    document.getElementById("zoom").hidden = !of[tab].length;
    if (tab === "review") {
      if (!v.items.length) list.append(el("p", "quiet", "Nothing to review."));
      for (const it of v.items) list.append(card(it, v.canReview));
    } else {
      if (!v.approved.length) list.append(el("p", "quiet", "No approved video waits for a slot."));
      for (const it of v.approved) list.append(approvedCard(it, v.canReview));
    }
    const first = list.querySelector("video");
    if (first) first.addEventListener("loadedmetadata", syncZoom);
    syncZoom();
  };

  // Zoom (Nil, 2026-10-28: "zoom in/out buttons"; the app frame cannot go
  // full screen): steps of 25%, kept in localStorage. "+" stops when a step
  // would not make the first video larger: it fills the window.
  const ZOOM_KEY = "review-zoom", ZOOM_MIN = -3, ZOOM_MAX = 8;
  const zoomIn = document.getElementById("zoom-in"), zoomOut = document.getElementById("zoom-out");
  const stored = () => { try { return Number(localStorage.getItem(ZOOM_KEY)); } catch { return 0; } };
  let zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(stored()) || 0));
  const applyZoom = (k) => document.documentElement.style.setProperty("--z", String(1.25 ** k));
  /** The area of the picture that the first video shows, in CSS pixels. */
  const shown = () => {
    const v = document.querySelector("video"); if (!v) return 0;
    const r = v.getBoundingClientRect();
    if (!v.videoWidth) return r.width * r.height;
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    return v.videoWidth * v.videoHeight * s * s;
  };
  /** Measured: one step up makes the first video larger. */
  const grows = () => { const now = shown(); applyZoom(zoom + 1); const next = shown(); applyZoom(zoom); return next > now + 1; };
  function syncZoom() { zoomOut.disabled = zoom <= ZOOM_MIN; zoomIn.disabled = zoom >= ZOOM_MAX || !grows(); }
  const setZoom = (k) => {
    zoom = k; applyZoom(zoom); syncZoom();
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch {}
  };
  zoomIn.onclick = () => setZoom(zoom + 1);
  // A level kept from a larger window can be above the one that fills this
  // window: step down until the video gets smaller, so no tap is lost.
  zoomOut.onclick = () => {
    const now = shown(); let k = zoom - 1; applyZoom(k);
    while (k > ZOOM_MIN && shown() >= now - 1) applyZoom(--k);
    setZoom(k);
  };
  addEventListener("resize", syncZoom);
  applyZoom(zoom);
  load();
</script></body></html>`;
