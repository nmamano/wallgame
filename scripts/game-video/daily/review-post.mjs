/**
 * The slot post and the retry: an approved review item goes out (Nil's review workflow,
 * 2026-10-28). The states this module owns: approved -> posting -> posted |
 * post-failed, and the item's `posting` and `posts` fields. The review routes
 * never write them (store.mjs, Video Editor (daily app)).
 *
 * - The approval binds content only: the video file must still hash to
 *   approval.videoSha256 and the copy block to approval.copySha256.
 * - The item posts to the platforms that are live when its slot takes it,
 *   and that set is fixed on the item (posting.platforms). A platform that
 *   goes live later never gets an old item (Wall Game PM, 2026-10-28).
 * - A platform that does not apply to the video (an Instagram Story of a
 *   video over 60 s), does not post at this slot (slots.mjs
 *   PLATFORM_SLOTS), or is TikTok while a draft waits in Nil's inbox
 *   (tiktok-drafts.mjs) leaves the set at slot time, with its reason in
 *   posting.notApplicable: no failure and no retry (Wall Game Director and
 *   Wall Game Growth, 2026-10-29, 2026-10-31 and 2026-11-03).
 * - A retry is by hand (Growth): it posts only the platforms of the set that
 *   did not post. A platform whose last attempt may have made the post
 *   (pending: the app stopped during its final request; uncertain: no clear
 *   answer to it) needs confirmNotPosted, as before. For YouTube the app
 *   then reads the channel's last uploads itself and refuses when one has
 *   the item's title, in any state (a "processing" upload is not on the
 *   public list: v-2026-11-01-6 went up twice, 2026-11-05).
 *
 * `postPlatform` is the per-platform poster of routes.mjs: it runs the
 * platform's requests, calls beforeCommit just before the final public one,
 * and returns the result ({ ok, mode, at, ... } or { ok: false, uncertain,
 * error }); it never throws for a platform's failure.
 */
import { StepRefused, blockedMusic } from "./store.mjs";
import { copySha256, postTexts } from "./copy.mjs";
import { errorText, sha256 } from "./transport.mjs";
import { storyProblem } from "./post-instagram.mjs";
import { notInSlot } from "./slots.mjs";

/**
 * Why a platform does not apply to an item's video, or null. Nil wants every
 * Instagram post on Stories (2026-10-29), and the render check keeps daily
 * videos inside the Story limits; this is the poster's safety net for a
 * video outside them, which would otherwise fail at every retry.
 */
const NOT_APPLICABLE = {
  "instagram-story": (item, video) =>
    storyProblem({
      video,
      durationSeconds: item.render?.video?.durationSeconds,
    }),
};

/**
 * {platform: reason} of the platforms that do not apply to the video, do
 * not post at this slot (slots.mjs PLATFORM_SLOTS), or wait (`waits`, the
 * slot's {platform: reason}: TikTok while a draft waits).
 */
const notApplicableTo = (item, video, platforms, slot, waits) =>
  Object.fromEntries(
    platforms
      .map((p) => [
        p,
        NOT_APPLICABLE[p]?.(item, video) ?? waits[p] ?? notInSlot(p, slot),
      ])
      .filter(([, why]) => why),
  );

/**
 * The platforms with no reason (modeReasons), so live.
 * @param {Record<string, string[]>} reasons
 */
const liveOf = (reasons) =>
  Object.keys(reasons).filter((p) => !reasons[p].length);

/**
 * @param {object} deps
 * @param {{ item: (id: string) => any, items: (q?: { states?: string[] }) => any[],
 *   approvedQueue: () => any[],
 *   updateItem: (id: string, expect: string[], mutate: (item: any) => void,
 *   what: string) => any }} deps.store
 * @param {() => Record<string, string[]>} deps.modeReasons why each platform
 *   cannot post live now (routes.mjs modeReasons); an empty list means live
 * @param {(path: string) => Buffer} deps.readVideo
 * @param {(platform: string, ctx: { item: any, video: Buffer,
 *   beforeCommit: () => void, confirmedNotPosted: boolean }) => Promise<any>}
 *   deps.postPlatform
 * @param {(item: any, platform: string, result: any) => void} deps.logPost
 *   appends the post-log row of a platform that posted
 * @param {() => Promise<string | null>} deps.tiktokWaiting why a slot sends
 *   no TikTok draft now (tiktok-drafts.mjs waiting), or null; read once per
 *   slot, inside the post lock
 * @param {() => Promise<{ id: string, title: string | null,
 *   uploadStatus: string | null, processingStatus: string | null }[]>}
 *   deps.youtubeRecent the channel's last uploads in every state
 *   (post-youtube.mjs youtubeRecentUploads), read inside the post lock
 * @param {() => number} [deps.now]
 */
export const createItemPoster = ({
  store,
  modeReasons,
  readVideo,
  postPlatform,
  logPost,
  tiktokWaiting,
  youtubeRecent,
  now = () => Date.now(),
}) => {
  const iso = () => new Date(now()).toISOString();

  /**
   * Why no TikTok draft may go out now, or null. Any fault of the read (a
   * damaged tiktok-drafts.json) is "unknown" for TikTok alone: it never
   * fails the other platforms of a slot or a retry (Wall Game PM,
   * 2026-11-03).
   */
  const tiktokHeld = () =>
    tiktokWaiting().catch(
      (err) => `draft status unknown: ${String(err?.message ?? err)}`,
    );

  /** Why the item may not post as approved, or null. */
  const contentProblem = (item, video) => {
    const a = item.approval;
    if (!a) return "the item has no approval";
    // The short hashes let the Director find the render or block that
    // replaced the approved one; the fix is a new approval, not a retry.
    const short = (h) => String(h ?? "none").slice(0, 12);
    const videoNow = sha256(video);
    if (videoNow !== a.videoSha256) {
      return `content changed since approval: the video sha256 is ${short(videoNow)}, Nil approved ${short(a.videoSha256)}`;
    }
    const copyNow = item.copy ? copySha256(item.copy.block) : null;
    if (copyNow !== a.copySha256) {
      return `content changed since approval: the copy block sha256 is ${short(copyNow)}, Nil approved ${short(a.copySha256)}`;
    }
    // The license gate of approve and postPlatform (store.mjs): a license
    // that changed after the approval refuses every platform, so the slot
    // passes the item over as it does a changed video.
    const [bad] = blockedMusic(item);
    if (bad) {
      return `music license blocked since approval: ${bad.track} has the license ${bad.license}`;
    }
    return null;
  };

  /**
   * Why a YouTube retry of `item` may not upload, or null: an upload of
   * the channel has the title the post gives (postTexts), in any upload or
   * processing state, or the uploads cannot be read. No blind retry.
   * Titles are compared without "<" and ">", which YouTube drops from a
   * title it stores. Only the channel's last 5 uploads are read: an upload
   * with 5 or more uploads after it is not seen (at one video a day, the
   * first attempt is always among them) (Video Reviewer 1, 2026-11-05).
   */
  const youtubeTwin = async (item) => {
    const key = (t) => t.replace(/[<>]/g, "").trim();
    const title = postTexts(item.copy.block).youtubeTitle.trim();
    let videos;
    try {
      videos = await youtubeRecent();
    } catch (err) {
      return `the channel's last uploads cannot be read (${String(err?.message ?? err)}), so the app cannot check for this upload; retry when the read works (GET /api/daily/youtube-recent)`;
    }
    const twin = videos.find(
      (v) => v.title !== null && key(v.title) === key(title),
    );
    if (!twin) return null;
    const state = [twin.uploadStatus, twin.processingStatus]
      .filter(Boolean)
      .join(", ");
    return `the channel already has this upload: ${twin.id} has the title "${title}" (${state || "state unknown"}); no retry`;
  };

  const need = (id) => {
    const item = store.item(id);
    if (!item) throw new StepRefused(`no item ${id}`);
    return item;
  };

  /**
   * Post `todo` in turn, then settle the state. `confirmed` names the
   * platforms that Growth checked after an attempt that may have posted.
   */
  const run = async (id, video, todo, confirmed = []) => {
    for (const platform of todo) {
      const item = store.item(id);
      let committing = false;
      const result = await postPlatform(platform, {
        item,
        video,
        confirmedNotPosted: confirmed.includes(platform),
        beforeCommit: () => {
          committing = true;
          store.updateItem(
            id,
            ["posting"],
            (i) => {
              i.posts[platform] = {
                ok: null,
                pending: true,
                mode: "live",
                at: iso(),
              };
            },
            `${platform} final request sent`,
          );
        },
      }).catch((err) => ({
        // postPlatform turns a platform's failure into a result. A throw is
        // its last guard (StepRefused: nothing was sent) or a fault around
        // it; after the final request a fault may have posted.
        ok: false,
        uncertain: committing,
        mode: "live",
        at: iso(),
        error: errorText(err),
      }));
      // postPlatform posts in the platform's mode at the call. A platform
      // that left live since (a revoked token) ran as a dry run: nothing
      // public went out, so it did not post.
      if (result.ok && result.mode !== "live") {
        result.ok = false;
        result.uncertain = false;
        result.error = "posted as a dry run: the platform is not live";
      }
      const saved = store.updateItem(
        id,
        ["posting"],
        (i) => {
          i.posts[platform] = result;
        },
        `${platform} ${result.ok ? "posted" : `failed: ${result.error}`}`,
      );
      if (result.ok) logPost(saved, platform, result);
    }
    const done = store.updateItem(
      id,
      ["posting"],
      (i) => {
        i.state = i.posting.platforms.every((p) => i.posts[p]?.ok === true)
          ? "posted"
          : "post-failed";
      },
      "posting ended",
    );
    return {
      kind: done.state,
      platforms: done.posting.platforms,
      notApplicable: done.posting.notApplicable ?? {},
      posts: done.posts,
    };
  };

  /**
   * The slot's post: the oldest approved item. kind: "posted" |
   * "post-failed" | "refused" (every approved item failed its checks) |
   * "no-live" (no platform is live: nothing is touched) | "empty" (no item
   * is approved any more). The item is taken here, inside the post guard:
   * Nil may withdraw an approved item (approved -> finished) until it is
   * posting, so an item that is no longer approved when it is taken is
   * passed over. An item that fails its checks goes to post-failed and the
   * next one is taken (Nil wants a post at least once per 24 h); `refused`
   * lists those, {itemId, error}. An item that no live platform applies to
   * at this slot (TikTok alone while a draft waits) is never taken:
   * it stays approved for a later slot (VR1, review 107); `passed` lists
   * those, {itemId, notApplicable}, and when no item is taken the kind is
   * "none-applies".
   * @param {{ slotAt: string, firedBy?: string }} slot  firedBy: who fired
   *   a slot by hand
   */
  const postNext = async ({ slotAt, firedBy }) => {
    const platforms = liveOf(modeReasons());
    if (!platforms.length) return { kind: "no-live" };
    const refused = [];
    const passed = [];
    // TikTok's read of the latest draft, once, when an item may be taken.
    let waits = null;
    for (const queued of store.approvedQueue()) {
      waits ??= {
        tiktok: platforms.includes("tiktok") ? await tiktokHeld() : null,
      };
      let video = null;
      try {
        video = readVideo(queued.render.video.path);
      } catch {
        /* contentProblem names it */
      }
      // A slot that would post the item nowhere: it stays approved.
      const none = video
        ? notApplicableTo(queued, video, platforms, { slotAt, firedBy }, waits)
        : {};
      if (platforms.every((p) => p in none)) {
        passed.push({ itemId: queued.id, notApplicable: none });
        continue;
      }
      let problem = null;
      let item;
      try {
        item = store.updateItem(
          queued.id,
          ["approved"],
          (i) => {
            problem = video
              ? contentProblem(i, video)
              : "the approved video file cannot be read";
            const skipped = problem
              ? {}
              : notApplicableTo(
                  i,
                  video,
                  platforms,
                  { slotAt, firedBy },
                  waits,
                );
            i.posts ??= {};
            i.posting = {
              slotAt,
              // Who fired a slot by hand (crew.mjs slot --now); a timed slot
              // has none.
              ...(firedBy ? { firedBy } : {}),
              at: iso(),
              platforms: platforms.filter((p) => !(p in skipped)),
              ...(Object.keys(skipped).length
                ? { notApplicable: skipped }
                : {}),
            };
            if (problem) i.posting.error = problem;
            i.state = problem ? "post-failed" : "posting";
          },
          `taken by the slot ${slotAt}`,
        );
      } catch (err) {
        // Withdrawn (or taken) since the queue was read: the next one.
        if (err instanceof StepRefused) continue;
        throw err;
      }
      if (problem) {
        refused.push({ itemId: item.id, error: problem });
        continue;
      }
      return {
        itemId: item.id,
        refused,
        ...(await run(
          item.id,
          video,
          // The item's own set: the live platforms less those that do not
          // apply to its video.
          item.posting.platforms.filter((p) => item.posts[p]?.ok !== true),
        )),
      };
    }
    if (passed.length) return { kind: "none-applies", passed, refused };
    return refused.length ? { kind: "refused", refused } : { kind: "empty" };
  };

  /**
   * Growth's retry of a post-failed item: only the platforms of its slot that
   * did not post. Refused (StepRefused, no change) when the content changed,
   * or when a platform may already have the post and is not in
   * confirmNotPosted.
   */
  /**
   * @param {string} id
   * @param {{ confirmNotPosted?: string[] }} [opts]
   */
  const retry = async (id, { confirmNotPosted = [] } = {}) => {
    const item = need(id);
    if (item.state !== "post-failed") {
      throw new StepRefused(
        `${id} is ${item.state}; only a post-failed item is retried`,
      );
    }
    let video;
    try {
      video = readVideo(item.render.video.path);
    } catch {
      throw new StepRefused(`${id}: the approved video file cannot be read`);
    }
    const problem = contentProblem(item, video);
    if (problem) throw new StepRefused(`${id}: ${problem}`);
    // A migrated item has posts{} from its day but no posting: its set is
    // the platforms that day tried.
    const platforms = item.posting?.platforms ?? Object.keys(item.posts);
    const todo = platforms.filter((p) => item.posts[p]?.ok !== true);
    // Each refused platform with its reasons: a missing Connect and a
    // pause need different actions (VR1 on 27eac3cc).
    const reasons = modeReasons();
    const live = liveOf(reasons);
    const notLive = todo.filter((p) => !live.includes(p));
    if (notLive.length) {
      const why = notLive
        .map((p) => `${p} (${(reasons[p] ?? ["unknown platform"]).join("; ")})`)
        .join(", ");
      throw new StepRefused(
        `${why} ${notLive.length > 1 ? "are" : "is"} not live now: retry when ${notLive.length > 1 ? "they are" : "it is"} live (/daily/connect)`,
      );
    }
    for (const p of todo) {
      const last = item.posts[p];
      if ((last?.pending || last?.uncertain) && !confirmNotPosted.includes(p)) {
        throw new StepRefused(
          `${p} may already have this post (${last.pending ? "the app stopped during" : "no clear answer to"} its final request at ${last.at}); ${p === "youtube" ? "retry with --confirm-not-posted youtube: the app checks the channel's last uploads first" : `check the account, then retry with --confirm-not-posted ${p}`}`,
        );
      }
    }
    if (todo.includes("youtube") && confirmNotPosted.includes("youtube")) {
      const twin = await youtubeTwin(item);
      if (twin) throw new StepRefused(`youtube: ${twin}`);
    }
    // TikTok is gated as at a slot: a draft that waits now (another item's,
    // sent since this item's slot) or a status that is unknown sends none.
    // The other platforms go on; the item stays post-failed for TikTok
    // (VR1 and Wall Game PM, 2026-11-03).
    const held = todo.includes("tiktok") ? await tiktokHeld() : null;
    const send = held ? todo.filter((p) => p !== "tiktok") : todo;
    if (!send.length) {
      throw new StepRefused(
        `tiktok: ${held}; retry when Nil has posted it or it is marked lost (crew.mjs tiktok)`,
      );
    }
    store.updateItem(
      id,
      ["post-failed"],
      (i) => {
        i.state = "posting";
        i.posting = { ...i.posting, platforms };
        delete i.posting.error;
      },
      `retry of ${send.join(", ")}`,
    );
    const result = await run(id, video, send, confirmNotPosted);
    return held ? { ...result, held: { tiktok: held } } : result;
  };

  /**
   * At app start: an item still "posting" was cut off by a stop. It goes to
   * post-failed; its pending marks stay, so no retry posts blindly.
   */
  const recover = () =>
    store.items({ states: ["posting"] }).map((item) => {
      const saved = store.updateItem(
        item.id,
        ["posting"],
        (i) => {
          i.state = "post-failed";
        },
        "the app stopped during this post",
      );
      return {
        id: saved.id,
        slotAt: saved.posting.slotAt,
        platforms: saved.posting.platforms,
        notApplicable: saved.posting.notApplicable ?? null,
        posts: saved.posts,
      };
    });

  return { postNext, retry, recover };
};
