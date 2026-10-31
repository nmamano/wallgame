/**
 * The game-video app's "/": the social media stats tracker (Nil,
 * 2026-10-31: "i see videos for review here - no need, I'll use inbox
 * only. this app can be restructured into social media stats tracker").
 * It shows, from GET /api/review/social: a headline (views and likes in
 * 7 days, followers, videos posted in 7 days; Wall Game PM, 2026-10-31),
 * the follower counts with their change over 1 and 7 days, each
 * platform's post totals with their change, each posted video (most
 * recent first) as one row of totals with its platforms folded under it,
 * and the accounts' setup (Wall Game Growth's platforms.json) folded
 * under "Accounts and setup". On a phone the tables keep only the main
 * columns, so nothing scrolls sideways. Views are each platform's own
 * count, and the page says so where it adds them (Wall Game Growth). The numbers are read on the app's timer (post-stats.mjs,
 * followers.mjs), never when the page opens. The review page is at
 * /review; the crew's view at /daily.
 *
 * NOTHING HERE MAY USE innerHTML: Growth's file and the post log are text.
 */
export const STATS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wall Game social stats</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f1c; color: #e2e8f0;
         margin: 0; padding: 16px 12px 40px; display: flex; justify-content: center; }
  main { width: 100%; max-width: 1400px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .quiet { color: #94a3b8; text-align: center; margin-top: 40px; }
  .social { font-size: 15px; line-height: 1.45; }
  .social .muted, .social span.muted { color: #94a3b8; font-size: 13px; }
  .social .stats { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 14px; }
  .social .stat { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 8px 14px; color: #cbd5e1; }
  .social .stat b { display: block; font-size: 22px; color: #f8fafc; }
  .social .sbox { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 10px 14px; margin: 0 0 14px; }
  .social .sgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 14px; }
  .social .sgrid .sbox { margin: 0; }
  .social h2 { margin: 0 0 8px; font-size: 18px; } .social h3 { margin: 10px 0 4px; font-size: 15px; }
  .social .pill { color: #fff; border-radius: 12px; padding: 2px 10px; font-size: 12px; vertical-align: middle; }
  .social table { border-collapse: collapse; width: 100%; }
  .social th { text-align: left; vertical-align: top; color: #94a3b8; font-weight: 500; width: 38%; padding: 3px 8px 3px 0; }
  .social td { padding: 3px 0; overflow-wrap: anywhere; white-space: pre-line; }
  .social code { background: #1e293b; border-radius: 4px; padding: 0 4px; font-size: 12px; }
  .social a { color: #93c5fd; }
  .social li.nil { background: rgba(250, 204, 21, 0.15); border-radius: 4px; }
  .social .ok { color: #4ade80; } .social .todo { color: #fbbf24; }
  /* The same column widths in every table, so the videos line up. */
  .social table.num { width: auto; }
  .social table.num th, .social table.num td { width: auto; padding: 4px 14px 4px 0; white-space: nowrap; }
  .social table.num th:first-child, .social table.num td:first-child { min-width: 130px; }
  .social table.num td.n, .social table.num th.n { min-width: 64px; }
  .social table.num td.n, .social table.num th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .social table.num tr.sum td { border-top: 1px solid #334155; font-weight: 700; }
  .social table.num td.note { white-space: normal; min-width: 180px; max-width: 420px; }
  .social details.setup > summary { cursor: pointer; font-size: 17px; font-weight: 700; margin: 6px 0 12px; }
  /* A video: one row (its name and time, then its four totals); its
     platforms fold under it. */
  .social details.video { border-top: 1px solid #1f2937; padding: 8px 0; }
  .social details.video > summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; }
  .social .vname { display: flex; flex-direction: column; flex: 1 1 260px; min-width: 0; }
  .social .vname b { overflow-wrap: anywhere; }
  .social .vnums { display: flex; gap: 14px; flex-wrap: wrap; color: #94a3b8; font-size: 13px; }
  .social .vnums b { color: #f8fafc; font-size: 15px; font-variant-numeric: tabular-nums; }
  /* Each figure in its own fixed slot, so the videos' figures line up. */
  .social .vnums > span { min-width: 104px; text-align: right; }
  .social details.video table { margin-top: 8px; }
  .social .narrow { display: none; }
  /* A phone: the main numbers only, no sideways scroll. */
  @media (max-width: 640px) {
    .social .wide { display: none; }
    .social .narrow { display: inline; white-space: nowrap; }
    .social table.num td:first-child { white-space: normal; }
    .social .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .social .stat { padding: 8px 10px; font-size: 13px; }
    .social .stat b { font-size: 19px; }
    .social .vnums { gap: 10px; font-size: 12px; }
    .social .vnums > span { min-width: 0; text-align: left; }
    .social .vnums b { font-size: 14px; }
    .social table.num th, .social table.num td { padding-right: 8px; }
    .social table.num th:first-child, .social table.num td:first-child { min-width: 0; }
    .social table.num td.n, .social table.num th.n { min-width: 0; }
    .social table.num td.note { min-width: 0; }
  }
</style></head>
<body><main><h1>Wall Game social stats</h1><div id="list"></div></main>
<script>
  // NOTHING HERE MAY USE innerHTML: Growth's file and the post log are text.
  const el = (tag, cls, text) => { const n = document.createElement(tag);
    if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
  const LOST = "No answer from the app: reload the page.";

  // The platforms, their setup and the follower counts (social.mjs), drawn
  // as text; a link only to an https address.
  const link = (text, href) => { const a = el("a", "", text); a.href = href; a.target = "_blank"; a.rel = "noopener"; return a; };
  const table = (rows) => { const t = el("table");
    for (const [k, ...cells] of rows) { const tr = el("tr"); tr.append(el("th", "", k));
      for (const c of cells) { const td = el("td"); td.append(c); tr.append(td); } t.append(tr); }
    return t; };
  const box = (title, ...kids) => { const b = el("section", "sbox"); if (title) b.append(el("h3", "", title)); b.append(...kids); return b; };
  const items = (tag, xs, line) => { const l = el(tag); for (const x of xs) l.append(line(x)); return l; };
  const platformCard = (c) => {
    const b = el("section", "sbox scard"); b.id = c.id;
    const h = el("h2", "", c.name + " "); const pill = el("span", "pill", c.status.label); pill.style.background = c.status.color;
    h.append(pill); b.append(h);
    b.append(table(c.rows.map((r) => {
      const v = el("span", "", r.v);
      if (r.href) { v.replaceChildren(link(r.v || r.href, r.href)); }
      for (const name of r.codes ?? []) { v.append(el("code", "", name), " "); }
      return [r.k, v];
    })));
    if (c.profile.length) {
      b.append(el("h3", "", "Profile tune-up"));
      b.append(table(c.profile.map((r) => [r.k, el("span", r.tone, r.v)])));
    }
    if (c.next.length) {
      b.append(el("h3", "", "Next steps"));
      b.append(items("ol", c.next, (n) => { const li = el("li", n.nil ? "nil" : ""); li.append(el("b", "", n.who + ": "), n.what); return li; }));
    }
    if (c.asks.length) b.append(el("p", "muted", "Asks: " + c.asks.join(", ")));
    return b;
  };
  const drawSocial = (list, v) => {
    // The headline (Wall Game PM, 2026-10-31): what Nil looks for first.
    const p = v.postStats, f = v.followers?.total;
    const head = el("p", "muted", p?.readAt ? "Read " + p.readAt + "." : "Not read yet.");
    const chips = (xs) => { const d = el("div", "stats");
      for (const [value, label] of xs) { const c = el("div", "stat"); c.append(el("b", "", value), label); d.append(c); }
      return d; };
    const signed = (n) => typeof n === "number" ? (n >= 0 ? "+" : "") + fmt(n) : "-";
    const stats = chips([
      [signed(p?.headline.views), "views in 7 days (platform counts added)"],
      [signed(p?.headline.likes), "likes in 7 days"],
      [fmt(f?.now), "followers now" + (typeof f?.week === "number" ? " (" + signed(f.week) + " in 7 days)" : "")],
      [fmt(p?.headline.videos), "videos posted in 7 days"],
    ]);
    // The setup's own figures, under "Accounts and setup".
    const setupStats = chips(v.stats.map((st) => [st.value, st.label]));
    const setupHead = el("p", "muted", "Status file updated " + v.updated + " by " + v.updatedBy + ". Poster modes read live from this app.");
    const followers = v.followers
      ? box("Followers", table([["Platform", "Now", "1 day", "7 days", "Note"]].concat(v.followers.rows.map((r) => [r.platform, el("b", "", r.now), r.day, r.week, el("span", "muted", r.note)]))), el("p", "muted", v.followers.note))
      : box("Followers", el("p", "muted", "No follower counts now (a post is running): look again in a few minutes."));
    const nil = box("What Nil does next",
      v.nilSteps.length
        ? items("ol", v.nilSteps, (n) => { const li = el("li"); li.append(el("b", "", n.platform + ": "), n.what); if (n.asks.length) li.append(el("span", "muted", " (ask " + n.asks.join(", ") + ")")); return li; })
        : el("p", "", "Nothing now."),
      el("p", "muted", "Each step is also an ask in your Isomux inbox. Keys go only in Integrations > Secrets, never in chat."));
    const rootLine = el("p"); rootLine.append(el("b", "", "Root account: "), v.root.name + ". " + v.root.why + " Credentials: " + v.root.credentials + ". 2FA: " + v.root.twoFactor + ".");
    const how = box("How it works", el("p", "", v.flow), rootLine, table(v.roles.map((r) => [r.role, r.who])));
    const grid = el("div", "sgrid"); grid.append(...v.cards.map(platformCard));
    const tail = box(null);
    if (v.brand) { tail.append(el("h3", "", "Brand assets")); const bp = el("p", "", v.brand.banners + " Folder: "); bp.append(el("code", "", v.brand.folder)); tail.append(bp); }
    tail.append(el("h3", "", "Later / no"), items("ul", v.later, (x) => el("li", "", x)));
    tail.append(el("h3", "", "Recent changes"), items("ul", v.log, (x) => el("li", "", x.at + ": " + x.what)));
    const setup = el("details", "setup"); setup.append(el("summary", "", "Accounts and setup"), setupHead, setupStats, nil, how, grid, tail);
    const wrap = el("div", "social"); wrap.append(head, stats, followers, ...postStats(v.postStats), setup);
    list.append(wrap);
  };

  // A table of numbers: a header row, right-aligned numbers, "-" for a
  // number the platform does not give, and an optional total row. A
  // column {h, n: numeric, cls}: cls "wide" hides it on a phone, "note"
  // lets it wrap.
  const fmt = (n) => typeof n === "number" ? n.toLocaleString("en-US") : "-";
  const numTable = (cols, rows, sumRow) => {
    const t = el("table", "num");
    const cls = (c) => [c.n ? "n" : "", c.cls ?? ""].join(" ").trim();
    const hr = el("tr"); for (const c of cols) hr.append(el("th", cls(c), c.h)); t.append(hr);
    for (const r of rows.concat(sumRow ? [sumRow] : [])) {
      const tr = el("tr", r === sumRow ? "sum" : "");
      r.forEach((x, i) => { const td = el("td", cls(cols[i])); td.append(x); tr.append(td); });
      t.append(tr);
    }
    return t;
  };
  // Saves (X and Bluesky bookmarks too), reach and quotes: asked for by
  // Wall Game Growth; on a phone, views and likes only.
  const M = [{ h: "Views", n: 1 }, { h: "Likes", n: 1 }, { h: "Comments", n: 1, cls: "wide" }, { h: "Shares", n: 1, cls: "wide" },
    { h: "Saves", n: 1, cls: "wide" }, { h: "Reach", n: 1, cls: "wide" }, { h: "Quotes", n: 1, cls: "wide" }];
  const nums = (x) => [fmt(x.views), fmt(x.likes), fmt(x.comments), fmt(x.shares), fmt(x.saves), fmt(x.reach), fmt(x.quotes)];
  const postStats = (p) => {
    if (!p) return [];
    const byPlatform = box("Posts by platform",
      numTable([{ h: "Platform" }, { h: "Posts", n: 1, cls: "wide" }, ...M, { h: "1 day", cls: "wide" }, { h: "7 days" }, { h: "Read", cls: "note wide" }],
        p.platforms.map((r) => { const wk = el("span"); wk.append(el("span", "wide", r.week), el("span", "narrow", r.weekShort));
          return [r.platform, fmt(r.posts), ...nums(r), r.day, wk, el("span", "muted", r.note)]; }),
        ["All", "", ...nums(p.total), "", "", ""]),
      el("p", "muted", p.note + " Views are each platform's own count (a play, a start, a timeline show), so their sum only adds them as they are."));
    // One row per video, most recent first; its platforms fold under it.
    const videos = box("Videos, most recent first",
      ...(p.videos.length ? [] : [el("p", "muted", "No video is posted yet.")]),
      ...p.videos.map((v) => {
        const d = el("details", "video");
        const sum = el("summary");
        const name = el("span", "vname"); name.append(el("b", "", v.name), el("span", "muted", v.posted));
        const figures = el("span", "vnums");
        for (const [n, label] of [[v.total.views, "views"], [v.total.likes, "likes"], [v.total.comments, "comments"], [v.total.shares, "shares"]]) {
          const c = el("span"); c.append(el("b", "", fmt(n)), " " + label); figures.append(c);
        }
        sum.append(name, figures);
        d.append(sum, numTable([{ h: "Platform" }, ...M, { h: "At 1 h / 24 h / 7 d", n: 1 }, { h: "Note", cls: "note wide" }],
          v.rows.map((r) => [r.href ? link(r.platform, r.href) : r.platform, ...nums(r), r.ages, el("span", "muted", r.note)])));
        return d;
      }));
    return [byPlatform, videos];
  };

  const load = async () => {
    const list = document.getElementById("list");
    let s;
    try { s = await (await fetch("/api/review/social")).json(); }
    catch { list.replaceChildren(el("p", "quiet", LOST)); return; }
    list.replaceChildren();
    if (s.error) { list.append(el("p", "quiet", "The stats cannot load. " + s.error)); return; }
    drawSocial(list, s);
  };
  load();
</script></body></html>`;
