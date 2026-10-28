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
 *   video over 60 s) leaves the set at slot time, with its reason in
 *   posting.notApplicable: no failure and no retry (Wall Game Director and
 *   Wall Game Growth, 2026-10-29).
 * - A retry is by hand (Growth): it posts only the platforms of the set that
 *   did not post. A platform whose last attempt may have made the post
 *   (pending: the app stopped during its final request; uncertain: no clear
 *   answer to it) needs confirmNotPosted, as before.
 *
 * `postPlatform` is the per-platform poster of routes.mjs: it runs the
 * platform's requests, calls beforeCommit just before the final public one,
 * and returns the result ({ ok, mode, at, ... } or { ok: false, uncertain,
 * error }); it never throws for a platform's failure.
 */
import { StepRefused, blockedMusic } from "./store.mjs";
import { copySha256 } from "./copy.mjs";
import { sha256 } from "./transport.mjs";
import { storyProblem } from "./post-instagram.mjs";

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

/** {platform: reason} of the platforms that do not apply to the video. */
const notApplicableTo = (item, video, platforms) =>
  Object.fromEntries(
    platforms
      .map((p) => [p, NOT_APPLICABLE[p]?.(item, video) ?? null])
      .filter(([, why]) => why),
  );

/**
 * @param {object} deps
 * @param {{ item: (id: string) => any, items: (q?: { states?: string[] }) => any[],
 *   approvedQueue: () => any[],
 *   updateItem: (id: string, expect: string[], mutate: (item: any) => void,
 *   what: string) => any }} deps.store
 * @param {() => string[]} deps.livePlatforms
 * @param {(path: string) => Buffer} deps.readVideo
 * @param {(platform: string, ctx: { item: any, video: Buffer,
 *   beforeCommit: () => void, confirmedNotPosted: boolean }) => Promise<any>}
 *   deps.postPlatform
 * @param {(item: any, platform: string, result: any) => void} deps.logPost
 *   appends the post-log row of a platform that posted
 * @param {() => number} [deps.now]
 */
export const createItemPoster = ({
  store,
  livePlatforms,
  readVideo,
  postPlatform,
  logPost,
  now = () => Date.now(),
}) => {
  const iso = () => new Date(now()).toISOString();

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
        error: String(err?.message ?? err),
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
   * lists those, {itemId, error}.
   */
  const postNext = async ({ slotAt }) => {
    const platforms = livePlatforms();
    if (!platforms.length) return { kind: "no-live" };
    const refused = [];
    for (const queued of store.approvedQueue()) {
      let video = null;
      try {
        video = readVideo(queued.render.video.path);
      } catch {
        /* contentProblem names it */
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
            const skipped = problem ? {} : notApplicableTo(i, video, platforms);
            i.posts ??= {};
            i.posting = {
              slotAt,
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
    const live = livePlatforms();
    const notLive = todo.filter((p) => !live.includes(p));
    if (notLive.length) {
      throw new StepRefused(
        `${notLive.join(", ")} ${notLive.length > 1 ? "are" : "is"} not live now: connect ${notLive.length > 1 ? "them" : "it"} (/daily/connect), then retry`,
      );
    }
    for (const p of todo) {
      const last = item.posts[p];
      if ((last?.pending || last?.uncertain) && !confirmNotPosted.includes(p)) {
        throw new StepRefused(
          `${p} may already have this post (${last.pending ? "the app stopped during" : "no clear answer to"} its final request at ${last.at}); check the account, then retry with --confirm-not-posted ${p}`,
        );
      }
    }
    store.updateItem(
      id,
      ["post-failed"],
      (i) => {
        i.state = "posting";
        i.posting = { ...i.posting, platforms };
        delete i.posting.error;
      },
      `retry of ${todo.join(", ")}`,
    );
    return run(id, video, todo, confirmNotPosted);
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
