/**
 * Nil's review queue (Nil, via Wall Game Growth, 2026-10-28): the /review
 * page of the game-video app. It shows the oldest item in review (store.mjs
 * reviewState) with everything that will post, and three actions:
 *
 *   Approve  -> approved: the item posts at the next slot (Wall Game Worker
 *               1's scheduler), bound to this video and this block
 *   Discard  -> discarded, with Nil's notes (required)
 *   Revise   -> back to the director as a draft, same id, with Nil's notes
 *               (required); it is in review again only with a new render
 *               AND a new block
 *
 * Below it, the READY items (approved, no slot took them yet), each with
 *
 *   Withdraw -> in review again (Nil's notes optional): Approve is one tap,
 *               so a mis-tap is undone without a confirm dialog
 *
 * Only one video of a game posts: Approve is refused while another item of
 * the game is approved, posting, posted or post-failed (ONE_POST_STATES).
 *
 * POST /api/review/<id>/approve|discard|revise takes {notes, videoSha256,
 * copySha256}: the hashes of what the page showed, so Nil approves what he
 * saw, not a newer render. POST /api/review/<id>/withdraw takes {notes}. Every action goes to the feedback log, and the
 * app tells the director AT ONCE (Nil, 2026-10-28: "the feedback i enter in
 * the app should go straight to director"). A failed message does not undo
 * the action: the row is stored and the page says "Director not told".
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
import { copyLines } from "./copy.mjs";
import { MUSIC_TRACKS } from "../music-tracks.mjs";
import { StepRefused } from "./store.mjs";
import { DIRECTOR_AGENT_ID } from "./office.mjs";

/** The office member who reviews: Nil (his id in the office's users.json). */
export const REVIEWER_MEMBER_ID = "6f26107a";

/** POST /api/review/<item id>/<action>. */
export const REVIEW_ACTION_PATH =
  /^\/api\/review\/(v-\d{4}-\d{2}-\d{2}-[A-Za-z0-9]+)\/(approve|discard|revise|withdraw)$/;

/** One post every 24 h (Growth's cadence), so n approved items are n days. */
const POSTS_PER_DAY = 1;
/** Nil's last review is marked when it is older than this. */
export const REVIEW_STALE_HOURS = 48;

const PLATFORM_NAMES = {
  x: "X",
  youtube: "YouTube",
  tiktok: "TikTok draft",
  instagram: "Instagram",
  facebook: "Facebook",
  bluesky: "Bluesky",
  threads: "Threads",
};

/**
 * The line next to Approve: where an approved item goes. The slot fixes the
 * platforms (the ones live then), so the line names no time and says what
 * is live now. TikTok posts as an inbox draft that Nil finishes.
 * @param {Record<string, string>} modes platform -> "live" | "dry-run"
 */
export const approveLine = (modes) => {
  const live = Object.keys(PLATFORM_NAMES)
    .filter((p) => modes[p] === "live")
    .map((p) => PLATFORM_NAMES[p]);
  return `Posts at the next slot to every platform that is live then; now: ${live.length ? live.join(", ") : "none (a dry run posts nothing)"}.`;
};

/** The credit line of each track the video plays, in order. */
const musicOf = (render) =>
  (render.music ?? []).map((cue) => {
    const track = MUSIC_TRACKS.find((t) => t.slug === cue.track);
    return {
      track: cue.track,
      fromPly: cue.fromPly,
      credit: track?.license === "ok-with-credit" ? track.credit : null,
      title: track?.title ?? cue.track,
    };
  });

/**
 * What the page shows: the oldest item in review (or null) and the queue's
 * counts.
 * @param {ReturnType<import("./store.mjs").openStore>} store
 * @param {{ modes: Record<string, string>, nowMs: number }} at
 */
export const reviewView = (store, { modes, nowMs }) => {
  const counts = store.counts();
  const next = store.inReview()[0] ?? null;
  const last = store.lastReview();
  const ageHours = last ? (nowMs - Date.parse(last.at)) / 3_600_000 : null;
  return {
    item: next && {
      id: next.id,
      gameId: next.gameId,
      players: next.candidate.seats.map((s) => s.name),
      caption: next.caption,
      // The director's one line to Nil (store.setNote), frozen in review.
      directorNote: next.directorNote?.text ?? null,
      payoff: next.payoff?.text ?? null,
      videoSha256: next.render.video.sha256,
      copySha256: next.copy.sha256,
      copyVersion: next.copy.block.version,
      // Growth's block, word for word, as it posts.
      copy: copyLines(next.copy.block),
      music: musicOf(next.render),
      durationSeconds: next.render.video.durationSeconds ?? null,
      // Other videos of this game that are not discarded.
      sameGame: store.sameGame(next),
      // Earlier review actions on this item (after a revise).
      reviews: next.reviews.map((r) => ({
        action: r.action,
        notes: r.notes,
        at: r.at,
      })),
    },
    review: { count: counts.inReview, target: store.queue().reviewTarget },
    ready: {
      count: counts.approved,
      days: counts.approved / POSTS_PER_DAY,
      // In the order they post; each one Nil may withdraw.
      items: store.approvedQueue().map((it) => ({
        id: it.id,
        players: it.candidate.seats.map((s) => s.name),
        caption: it.caption,
        approvedAt: it.approval.at,
      })),
    },
    lastReview: last && {
      at: last.at,
      itemId: last.itemId,
      action: last.action,
      ageHours: Math.floor(ageHours),
      stale: ageHours > REVIEW_STALE_HOURS,
    },
    approveLine: approveLine(modes),
  };
};

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
<title>Wall Game: review</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f1c; color: #e2e8f0;
         margin: 0; padding: 20px 14px; display: flex; justify-content: center; }
  main { width: 100%; max-width: 560px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  .counts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .pill { padding: 3px 10px; border-radius: 999px; font-size: 13px; font-weight: 700; background: #1e293b; }
  .warn { background: #7f1d1d; }
  .box { padding: 12px 14px; border-radius: 8px; background: #121a2e; border: 1px solid #334155;
         font-size: 14px; line-height: 1.5; margin-bottom: 12px; overflow-wrap: anywhere; }
  .muted { color: #94a3b8; font-size: 13px; }
  .cap { white-space: pre-wrap; overflow-wrap: anywhere; background: #0b1222; padding: 6px 8px; border-radius: 6px; margin: 3px 0; }
  .err { color: #fca5a5; white-space: pre-wrap; }
  .ok { color: #86efac; }
  video { display: block; max-width: 100%; max-height: 75vh; margin: 0 auto 10px; border-radius: 8px; background: #000; }
  textarea { width: 100%; box-sizing: border-box; min-height: 80px; background: #0b1222; color: #e2e8f0;
             border: 1px solid #334155; border-radius: 6px; padding: 8px; font: inherit; }
  .actions { display: flex; gap: 8px; margin-top: 10px; }
  button { flex: 1; padding: 10px; border-radius: 8px; border: 0; font-weight: 700; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .approve { background: #16a34a; color: #fff; } .revise { background: #ca8a04; color: #1a1005; }
  .discard { background: #475569; color: #fff; }
  .note { background: #1e3a5f; border-color: #3b82f6; font-weight: 600; }
  h2 { font-size: 16px; margin: 18px 0 8px; }
  .ready { display: flex; align-items: center; gap: 10px; }
  .ready div { flex: 1; }
  .withdraw { flex: 0 0 auto; padding: 8px 12px; font-size: 14px; background: #334155; color: #fff; }
</style></head>
<body><main>
  <h1>Wall Game videos: review</h1>
  <div id="counts" class="counts"></div>
  <div id="result"></div>
  <div id="item"></div>
  <div id="ready"></div>
<script>
  // NOTHING HERE MAY USE innerHTML: player names, captions and notes are untrusted.
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag);
    if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };

  const showCounts = (v) => {
    const c = $("counts"); c.replaceChildren();
    c.append(el("span", "pill" + (v.review.count < v.review.target ? " warn" : ""),
      "REVIEW " + v.review.count + " of " + v.review.target));
    c.append(el("span", "pill", "READY " + v.ready.count + " = " + v.ready.days + " day" + (v.ready.days === 1 ? "" : "s") + " of posts"));
    const last = v.lastReview;
    c.append(el("span", "pill" + (last && last.stale ? " warn" : ""),
      last ? "Your last review: " + last.ageHours + " h ago" + (last.stale ? " (over 48 h)" : "") : "No review yet"));
  };

  const showItem = (v) => {
    const box = $("item"); box.replaceChildren();
    const it = v.item;
    if (!it) { box.append(el("div", "box muted", "Nothing to review now.")); return; }
    const head = el("div", "box");
    head.append(el("div", null, it.id + ": " + it.players.join(" vs ")));
    if (it.caption) head.append(el("div", null, "On the video: " + it.caption));
    if (it.payoff) head.append(el("div", null, "Payoff: " + it.payoff));
    for (const m of it.music) head.append(el("div", "muted", "Music: " + m.title + (m.credit ? " (credit: " + m.credit + ")" : "")));
    for (const r of it.reviews) head.append(el("div", "muted", "Your " + r.action + " at " + r.at + (r.notes ? ": " + r.notes : "")));
    for (const o of it.sameGame) head.append(el("div", "err", "Another video of this game: " + o.id + " (" + o.state + ")"));
    const video = el("video"); video.controls = true; video.playsInline = true;
    video.src = "/api/daily/video?item=" + encodeURIComponent(it.id);
    if (it.directorNote) box.append(el("div", "box note", "Director: " + it.directorNote));
    const copy = el("div", "box");
    copy.append(el("div", "muted", "Post text by Wall Game Growth (" + it.copyVersion + "), word for word:"));
    for (const l of it.copy) copy.append(el("div", "cap", l));
    const act = el("div", "box");
    act.append(el("div", "muted", v.approveLine));
    const notes = el("textarea"); notes.placeholder = "Notes for the director (needed for Discard and Revise)";
    act.append(notes);
    const row = el("div", "actions");
    const buttons = [["approve", "Approve"], ["revise", "Revise"], ["discard", "Discard"]].map(([action, label]) => {
      const b = el("button", action, label);
      b.onclick = () => send(it, action, notes.value, buttons);
      row.append(b); return b;
    });
    if (!v.canReview) {
      buttons.forEach((b) => (b.disabled = true));
      act.append(el("div", "muted", "Only Nil reviews videos; you can watch."));
    }
    act.append(row);
    box.append(video, head, copy, act);
  };

  const showReady = (v) => {
    const box = $("ready"); box.replaceChildren();
    if (!v.ready.items.length) return;
    box.append(el("h2", null, "Ready to post (oldest first)"));
    const notes = el("textarea"); notes.placeholder = "Notes for the director (optional for Withdraw)";
    notes.style.minHeight = "40px";
    const buttons = [];
    for (const r of v.ready.items) {
      const row = el("div", "box ready");
      row.append(el("div", null, r.id + ": " + r.players.join(" vs ") + (r.caption ? " / " + r.caption : "")));
      const b = el("button", "withdraw", "Withdraw");
      b.disabled = !v.canReview;
      b.onclick = () => send(r, "withdraw", notes.value, buttons);
      buttons.push(b); row.append(b); box.append(row);
    }
    box.append(notes);
  };

  const send = async (it, action, notes, buttons) => {
    buttons.forEach((b) => (b.disabled = true));
    const res = await fetch("/api/review/" + encodeURIComponent(it.id) + "/" + action, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes, videoSha256: it.videoSha256, copySha256: it.copySha256 }),
    });
    const out = await res.json().catch(() => ({ error: "HTTP " + res.status }));
    const r = $("result"); r.replaceChildren();
    if (!res.ok) {
      r.append(el("div", "box err", out.error || "HTTP " + res.status));
      buttons.forEach((b) => (b.disabled = false));
      return;
    }
    r.append(el("div", "box " + (out.directorTold ? "ok" : "err"),
      it.id + ": " + action + " saved. " + (out.directorTold ? "The director was told." : "Director not told (the action counts; the director reads the log).")));
    load();
  };

  const load = async () => {
    const v = await (await fetch("/api/review/queue")).json();
    showCounts(v); showItem(v); showReady(v);
  };
  load();
</script></main></body></html>`;
