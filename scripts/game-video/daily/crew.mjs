/**
 * The crew lead's commands for one daily video. Each one is a step of the
 * cycle in routes.mjs; the app keeps the record and refuses a step out of
 * order, so a session that starts cold can run `status` and go on.
 *
 *   node scripts/game-video/daily/crew.mjs <command> [--day YYYY-MM-DD]
 *
 *   status                         where today's cycle is
 *   pick --report F [--rank N] [--style S] [--x T] [--title T] [--description T]
 *                                  today's candidate from a step-1 report
 *   render [--wait] [--force]      a 4090 render job; --wait polls until it ends.
 *                                  A second render of a game needs --force: each
 *                                  render adds one view to the real game.
 *   ask --agent <your agent id>    open the Isomux ask with the MP4 and caption
 *   answer --agent <id> --ask <askId> --decision approve|reject
 *          --approver <member> --reply <the member's reply, verbatim>
 *                                  pass the member's answer to the app; the
 *                                  cycle is found by the ask, so no --day
 *   post --day D [--confirm-not-posted x|youtube]
 *                                  post X then YouTube (dry-run without keys)
 *   log [--dry-run]                the post log
 *
 * The ask goes to the agent's manager. Only an agent can open one (an app
 * token is refused there), which is why this runs as the crew lead and uses
 * ISOMUX_AGENT_TOKEN. `ask` sends the app the video hash and posting modes
 * that the ask shows, and withdraws the ask if the app no longer agrees.
 *
 * READING THE ANSWER (the crew lead's rule). The office closes an ask in three
 * ways, and only one is an approval:
 *   "[Reply to your ask <id>: ...]" whose text is the Approve option
 *        -> answer --decision approve --reply "<that text>"
 *   any other reply text                    -> --decision reject, reply as given
 *   "Dismissed your ask" or "is now task"   -> --decision reject
 * `answer` checks that the ask is closed, but a closed ask is not proof of a
 * yes: the decision is the crew lead's reading of the member's message.
 *
 * AFTER AN UNCERTAIN POST. If a platform's final request got no clear answer,
 * `post` refuses that platform. Look at the account (X profile, YouTube Studio).
 * Only when the post is not there, run post again with --confirm-not-posted.
 *
 * The app is found through the office's app registry (name game-video), or
 * given with --app http://127.0.0.1:<port>.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const OFFICE = "http://localhost:4000";
const APP_NAME = "game-video";

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const has = (name) => argv.includes(`--${name}`);

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const office = async (method, path, { body, type } = {}) => {
  const token = process.env.ISOMUX_AGENT_TOKEN;
  if (!token) die("ISOMUX_AGENT_TOKEN is not set; run this as an Isomux agent");
  const res = await fetch(`${OFFICE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(type && { "content-type": type }),
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const appBase = async () => {
  if (flag("app")) return flag("app");
  const { status, body } = await office("GET", `/api/apps/${APP_NAME}`);
  if (status !== 200) die(`cannot find the ${APP_NAME} app (HTTP ${status})`);
  return `http://127.0.0.1:${body.port}`;
};

const appTry = async (method, path, body) => {
  const res = await fetch(`${await appBase()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, json: await res.json() };
};

const app = async (method, path, body) => {
  const { ok, status, json } = await appTry(method, path, body);
  if (!ok) die(`${method} ${path}: ${json.error ?? status}`);
  return json;
};

const day = flag("day");
const pct = (x) => `${Math.round(x * 100)}%`;

const summary = (s) => {
  const c = s.cycle;
  const lines = [
    `day ${s.day}: ${c ? c.state : "no cycle"}   modes x=${s.modes.x} youtube=${s.modes.youtube}`,
  ];
  if (!c) return lines.join("\n");
  const k = c.candidate;
  const t = k.swings[0];
  lines.push(
    `game ${k.gameId}: ${k.seats.map((x) => x.name).join(" vs ")}, ${k.movesCount} plies`,
    `swing: move ${t.moveNumber} ${t.notation}, mover ${pct(t.moverBefore)} -> ${pct(t.moverAfter)} (size ${t.size.toFixed(2)})`,
    `X text: ${c.caption.x}`,
  );
  if (c.render) {
    lines.push(
      c.render.error
        ? `render ${c.render.jobId}: FAILED ${c.render.error}`
        : c.render.video
          ? `render ${c.render.jobId}: ${c.render.video.path} (${c.render.video.bytes} bytes, sha256 ${c.render.video.sha256.slice(0, 12)})`
          : `render ${c.render.jobId}: running - ${s.renderProgress ?? "queued"}`,
    );
  }
  if (c.approval) {
    lines.push(
      `ask ${c.approval.askId}: ${c.approval.decision ? `${c.approval.decision}d by ${c.approval.approver}` : "waiting"}`,
    );
  }
  for (const [p, r] of Object.entries(c.posts)) {
    lines.push(
      `${p}: ${r.ok ? `${r.mode} ${r.postId} ${r.url}` : `FAILED ${r.error}`}`,
    );
  }
  return lines.join("\n");
};

const state = () => app("GET", `/api/daily/state${day ? `?day=${day}` : ""}`);

/** The ask's text: everything Nil needs to decide without opening anything. */
export const askText = (c, modes, videoSha256) => {
  const dry = Object.values(modes).every((m) => m === "dry-run");
  const t = c.candidate.swings[0];
  return [
    `Daily Wall Game video for ${c.day}.${dry ? " DRY RUN: nothing will be posted." : ""}`,
    `Posting mode: X ${modes.x}, YouTube ${modes.youtube}.`,
    `Game ${c.candidate.gameId}: ${c.candidate.seats.map((x) => x.name).join(" vs ")}, ${c.candidate.movesCount} plies.`,
    `Biggest swing: move ${t.moveNumber}, the mover went from ${pct(t.moverBefore)} to ${pct(t.moverAfter)} to win.`,
    `Video: attached (${(c.render.video.bytes / 1e6).toFixed(1)} MB, sha256 ${videoSha256.slice(0, 12)}, effect ${c.render.effect ?? "-"}, sound ${c.render.sound ?? "-"}).`,
    "",
    `X text: ${c.caption.x}`,
    `YouTube title: ${c.caption.youtubeTitle}`,
    `YouTube description: ${c.caption.youtubeDescription}`,
    "",
    "Approve to post it as shown. Reject, and say what to change, to stop it.",
  ].join("\n");
};

const commands = {
  async status() {
    console.log(summary(await state()));
  },

  async pick() {
    const path = flag("report") ?? die("pick needs --report <file>");
    const report = JSON.parse(readFileSync(path, "utf8"));
    const rank = Number(flag("rank") ?? 1);
    // Send only the chosen entry: the full report holds every position's score.
    const slim = {
      kind: report.kind,
      createdAt: report.createdAt,
      ranked: report.ranked?.slice(0, rank),
    };
    const caption = Object.fromEntries(
      [
        ["x", flag("x")],
        ["youtubeTitle", flag("title")],
        ["youtubeDescription", flag("description")],
      ].filter(([, v]) => v !== undefined),
    );
    await app("POST", "/api/daily/pick", {
      day,
      report: slim,
      rank,
      style: flag("style"),
      caption,
    });
    console.log(summary(await state()));
  },

  async render() {
    const { jobId } = await app("POST", "/api/daily/render", {
      day,
      force: has("force"),
    });
    console.log(`render ${jobId} queued`);
    if (!has("wait")) return;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await state();
      if (s.cycle.state !== "rendering") return console.log(summary(s));
    }
  },

  async ask() {
    const agent = flag("agent") ?? die("ask needs --agent <your agent id>");
    const s = await state();
    const c = s.cycle;
    if (c?.state !== "rendered")
      die(`ask needs a rendered video; the cycle is ${c?.state ?? "missing"}`);
    // The hash of the bytes that the ask attaches, not of the record.
    const videoSha256 = createHash("sha256")
      .update(readFileSync(c.render.video.path))
      .digest("hex");
    if (videoSha256 !== c.render.video.sha256) {
      die("the video file does not match its record; render again");
    }
    const opened = await office("POST", `/api/agents/${agent}/asks`, {
      type: "application/json",
      body: JSON.stringify({
        text: askText(c, s.modes, videoSha256),
        options: ["Approve", "Reject"],
        readFiles: [c.render.video.path],
      }),
    });
    if (opened.status !== 201)
      die(
        `the ask was refused: HTTP ${opened.status} ${JSON.stringify(opened.body)}`,
      );
    const recorded = await appTry("POST", "/api/daily/ask", {
      day: c.day,
      askId: opened.body.id,
      modes: s.modes,
      videoSha256,
    });
    if (!recorded.ok) {
      // The ask shows something the app no longer agrees with: withdraw it.
      await office("DELETE", `/api/agents/${agent}/asks/${opened.body.id}`);
      die(`ask withdrawn: ${recorded.json.error}`);
    }
    console.log(
      `ask ${opened.body.id} opened for ${opened.body.member ?? "the manager"}`,
    );
  },

  async answer() {
    const agent = flag("agent") ?? die("answer needs --agent <your agent id>");
    const askId = flag("ask") ?? die("answer needs --ask <askId>");
    const decision = flag("decision");
    if (decision !== "approve" && decision !== "reject")
      die("--decision is approve or reject");
    const approver =
      flag("approver") ?? die("answer needs --approver <member name>");
    const reply = flag("reply");
    if (decision === "approve" && !reply) {
      die("an approval needs --reply with the member's reply, verbatim");
    }
    // An open ask has no answer yet; 404 is how the office says it closed.
    const open = await office("GET", `/api/agents/${agent}/asks/${askId}`);
    if (open.status === 200)
      die(`ask ${askId} is still open; wait for the member's reply`);
    if (open.status !== 404)
      die(`cannot check ask ${askId}: HTTP ${open.status}`);
    const cycle = await app("POST", "/api/daily/answer", {
      askId,
      decision,
      approver,
      reply,
    });
    console.log(summary(await app("GET", `/api/daily/state?day=${cycle.day}`)));
  },

  async post() {
    if (!day) die("post needs --day: the cycle's day, which `answer` printed");
    const confirm = flag("confirm-not-posted");
    await app("POST", "/api/daily/post", {
      day,
      confirmNotPosted: confirm ? [confirm] : [],
    });
    console.log(summary(await state()));
  },

  async log() {
    const rows = await app(
      "GET",
      `/api/daily/post-log${has("dry-run") ? "?dryRun=1" : ""}`,
    );
    for (const r of rows) console.log(JSON.stringify(r));
    if (!rows.length) console.log("(empty)");
  },
};

if (import.meta.main) {
  if (!commands[command]) die(`commands: ${Object.keys(commands).join(", ")}`);
  await commands[command]();
}
