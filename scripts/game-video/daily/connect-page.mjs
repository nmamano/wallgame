/**
 * The /daily/connect page: each platform's connection and a Connect button.
 * Server-rendered, no script. It shows only what token-store.mjs `status`
 * gives (no token), the names of missing secrets, and the Meta discovery
 * result.
 */

const NAMES = { youtube: "YouTube", tiktok: "TikTok", threads: "Threads" };

export const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** 2026-10-26T22:00:00.000Z -> 2026-10-26 22:00 UTC */
const utc = (iso) =>
  typeof iso === "string" && !Number.isNaN(Date.parse(iso))
    ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : null;

const STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
  section { border: 1px solid #ddd; border-radius: 8px; padding: 0.8rem 1rem; margin: 1rem 0; }
  h2 { margin: 0 0 0.4rem; font-size: 1.15rem; }
  .ok { color: #1a7f37; } .no { color: #b35900; } .err { color: #c62828; }
  .note { background: #eef6ee; padding: 0.6rem 1rem; border-radius: 6px; }
  .bad { background: #fdecea; padding: 0.6rem 1rem; border-radius: 6px; }
  ul { margin: 0.3rem 0; padding-left: 1.2rem; }
  button { font-size: 1rem; padding: 0.35rem 1rem; }
`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>${body}</body></html>`;

const connectionLines = (status) => {
  const lines = [];
  const when = utc(status.connectedAt);
  lines.push(
    `Connected at ${escapeHtml(when ?? "?")}${status.connectedBy ? ` by ${escapeHtml(status.connectedBy)}` : ""}`,
  );
  const account = status.account?.name ?? status.account?.id;
  if (account) lines.push(`Account: ${escapeHtml(account)}`);
  if (status.scopes?.length) {
    lines.push(`Scopes: ${status.scopes.map(escapeHtml).join(", ")}`);
  }
  if (utc(status.accessExpiresAt)) {
    lines.push(`Token expires: ${escapeHtml(utc(status.accessExpiresAt))}`);
  }
  if (utc(status.refreshExpiresAt)) {
    lines.push(
      `Refresh token expires: ${escapeHtml(utc(status.refreshExpiresAt))}`,
    );
  }
  if (utc(status.refreshedAt) && status.refreshedAt !== status.connectedAt) {
    lines.push(`Last refreshed: ${escapeHtml(utc(status.refreshedAt))}`);
  }
  return lines;
};

/**
 * @param {{ platform: string, status: any, missing: string[] }[]} platforms
 * @param {{ connected?: string | null, meta?: { lines: string[], ok: boolean } | null }} o
 */
export const connectPage = (
  platforms,
  { connected = null, meta = null } = {},
) => {
  const sections = platforms.map(({ platform, status, missing }) => {
    const name = NAMES[platform] ?? platform;
    let state;
    if (status?.error) {
      state = `<p class="err">${escapeHtml(status.error)}</p>`;
    } else if (status) {
      state = `<p class="ok">Connected</p><ul>${connectionLines(status)
        .map((l) => `<li>${l}</li>`)
        .join("")}</ul>`;
    } else {
      state = `<p class="no">Not connected</p>`;
    }
    const button = missing.length
      ? `<p class="no">Connect needs the app secrets ${missing.map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}.</p>`
      : `<form method="post" action="/daily/connect/${escapeHtml(platform)}/start"><button>${status && !status.error ? "Connect again" : "Connect"}</button></form>`;
    return `<section><h2>${escapeHtml(name)}</h2>${state}${button}</section>`;
  });
  const metaSection = meta
    ? `<section><h2>Facebook and Instagram (Meta)</h2><ul>${meta.lines
        .map(
          (l) => `<li class="${meta.ok ? "ok" : "err"}">${escapeHtml(l)}</li>`,
        )
        .join("")}</ul></section>`
    : "";
  const done = connected
    ? `<p class="note">${escapeHtml(NAMES[connected] ?? connected)} is connected.</p>`
    : "";
  return page(
    "Connect platforms",
    `<h1>Connect platforms</h1>
<p>Each Connect button opens the platform's own sign-in. Sign in as the Wall Game account and allow access; the platform then sends you back here.</p>
${done}${sections.join("\n")}${metaSection}
<p><a href="/daily">Back to the daily video</a></p>`,
  );
};

/** The page a refused Connect shows. */
export const connectRefusedPage = (platform, message) =>
  page(
    "Connect refused",
    `<h1>${escapeHtml(NAMES[platform] ?? platform)} was not connected</h1>
<p class="bad">${escapeHtml(message)}</p>
<p><a href="/daily/connect">Back to Connect platforms</a></p>`,
  );
