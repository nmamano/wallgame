/**
 * Nil's review queue (Nil, via Wall Game Growth, 2026-10-28): the page the
 * game-video app opens on (/, and /review). Nil, 2026-10-28: "I literally
 * only need to see the videos and captions. Everything else is context i
 * don't need." So it shows every item in review (store.mjs reviewState),
 * oldest first, each with ONLY its video, its caption (the post's text, one
 * line: postCaption), the YouTube title when it differs (a small "YouTube:"
 * line: it is its own text, and Approve binds it), one red line for each sound with a high claim risk
 * that the video plays (Wall Game Director, 2026-10-28: the director kept
 * it on purpose, so Nil sees the risk) and three actions:
 *
 *   Approve  -> approved: the item posts at the next slot (Wall Game Worker
 *               1's scheduler), bound to this video and this block
 *   Revise   -> back to the director as a draft, same id, with Nil's notes
 *               (required); it is in review again only with a new render
 *               AND a new block
 *   Discard  -> discarded, with Nil's notes (required)
 *
 * Right after an Approve, the card offers Undo (withdraw: in review again),
 * so a mis-tap on a phone is undone without a confirm dialog. A reason shows
 * only when an action cannot work: a refusal, or Approve disabled while
 * another video of the game posts or the render's music may not play
 * (store.mjs approveProblem). No counts, ids, slots or copy-block details:
 * the agents read those from crew.mjs and /api/review/status.
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
import { StepRefused } from "./store.mjs";
import { DIRECTOR_AGENT_ID } from "./office.mjs";
import { claimRisk, soundUses } from "./sounds.mjs";

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
export const reviewView = (store) => ({
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
  })),
});

/** The director's message about one review action: everything to act on. */
export const directorText = (item, action, notes) =>
  [
    `REVIEW: Nil chose ${action.toUpperCase()} on ${item.id} (game ${item.gameId}).`,
    `Notes, verbatim: ${notes ? JSON.stringify(notes) : "(none)"}`,
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
         margin: 0; padding: 16px 12px 40px; display: flex; justify-content: center; }
  main { width: 100%; max-width: 520px; }
  .card { margin-bottom: 28px; }
  video { display: block; width: 100%; max-height: 78vh; border-radius: 10px; background: #000; }
  .caption { font-size: 17px; line-height: 1.4; margin: 10px 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
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
  .why { color: #fca5a5; font-size: 14px; margin-top: 6px; white-space: pre-wrap; }
  .quiet { color: #94a3b8; text-align: center; margin-top: 40px; }
</style></head>
<body><main id="list"></main>
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
    const row = el("div", "actions");
    const buttons = [["approve", "Approve"], ["revise", "Revise"], ["discard", "Discard"]].map(([action, label]) => {
      const b = el("button", action, label);
      b.disabled = !canReview;
      b.onclick = async () => {
        buttons.forEach((x) => (x.disabled = true));
        why.textContent = "";
        const failed = await post(it.id, action,
          { notes: notes.value, videoSha256: it.videoSha256, copySha256: it.copySha256 });
        if (failed) { why.textContent = failed.error; if (failed.retry) buttons.forEach((x) => (x.disabled = false)); return; }
        done(box, it, action);
      };
      row.append(b); return b;
    });
    if (it.approveProblem) { buttons[0].disabled = true; why.textContent = it.approveProblem; }
    box.append(video, el("div", "caption", it.caption));
    if (it.youtubeTitle) box.append(el("div", "alt", "YouTube: " + it.youtubeTitle));
    for (const key of it.claimRiskSounds) box.append(el("div", "risk", "Uses " + key + ": a claim is possible."));
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

  const load = async () => {
    const list = document.getElementById("list");
    let v;
    try { v = await (await fetch("/api/review/queue")).json(); }
    catch { list.replaceChildren(el("p", "quiet", LOST)); return; }
    list.replaceChildren();
    if (!v.canReview) list.append(el("p", "quiet", "Only Nil reviews these videos; you can watch."));
    if (!v.items.length) { list.append(el("p", "quiet", "Nothing to review.")); return; }
    for (const it of v.items) list.append(card(it, v.canReview));
  };
  load();
</script></body></html>`;
