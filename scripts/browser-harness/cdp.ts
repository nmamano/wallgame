/**
 * A small client for driving a real Chrome over the DevTools protocol.
 *
 * This exists because every other layer of testing here checks a PART of the
 * app: unit tests check pure functions, the probe scripts check the server
 * and the bot over a websocket, and neither can tell you what a player
 * actually sees. This drives the SHIPPED bundle in a real browser, which is
 * the only way to answer questions like "does navigating back re-read
 * progress" or "does the nav bar fit at 1024px" with evidence instead of
 * reasoning.
 *
 * Not a test suite: nothing here asserts, and no gate runs it. It is a tool
 * you point at a question. See README.md.
 */

/** Chrome's DevTools endpoint. One browser at a time is plenty. */
const CDP_PORT = 9222;
const CDP = `http://127.0.0.1:${CDP_PORT}`;

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts headless Chrome and returns its EXACT pid alongside a stop().
 *
 * The pid matters: killing this browser by matching a command-line pattern
 * is forbidden on this box, because such a pattern once matched the office
 * server and took it down. Capture the pid you started and kill only that.
 */
export const launchChrome = async (
  opts: { width?: number; height?: number } = {},
) => {
  const binary =
    Bun.env.CHROME_PATH ??
    ["google-chrome", "chromium", "chromium-browser"].find((name) =>
      Bun.which(name),
    );
  if (!binary) {
    throw new Error(
      "no Chrome found; install one or set CHROME_PATH to its binary",
    );
  }
  // Without an explicit profile Chrome runs headless in a throwaway incognito
  // session, and some questions get a different answer there: PWA
  // installability, for one, reports a flat `in-incognito` failure no matter
  // how good the manifest is. A temp profile costs nothing and keeps the
  // browser's own verdicts usable.
  const profileDir = `/tmp/wallgame-harness-profile-${process.pid}`;
  const proc = Bun.spawn(
    [
      binary,
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      // Chrome refuses websocket upgrades from unexpected origins otherwise.
      "--remote-allow-origins=*",
      `--window-size=${opts.width ?? 1280},${opts.height ?? 800}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  const stop = () => {
    proc.kill();
    // Best effort: a stale profile would only waste disk, never corrupt a run,
    // since the directory is unique per process.
    try {
      require("node:fs").rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* leave it for /tmp cleanup */
    }
  };

  // The debugging port is not listening the instant the process starts.
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${CDP}/json/version`);
      return { pid: proc.pid, stop };
    } catch {
      await wait(100);
    }
  }
  stop();
  throw new Error("Chrome started but never opened its debugging port");
};

export interface Page {
  /** Run an expression in the page and get its value back. */
  evaluate: (expression: string) => Promise<unknown>;
  /**
   * Any DevTools protocol method, for the questions the helpers above cannot
   * reach. `Page.getAppManifest` is the reason this exists: whether a manifest
   * is installable is Chrome's own judgement, and reading the JSON ourselves
   * would only tell us what we already believe about it.
   */
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  navigate: (url: string) => Promise<void>;
  /** Resize the viewport without restarting the browser. */
  setViewport: (width: number, height: number) => Promise<void>;
  screenshot: (path: string) => Promise<void>;
  close: () => void;
}

/** Attaches to the running browser's first page target. */
export const connect = async (): Promise<Page> => {
  const targets = (await (await fetch(`${CDP}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("no page target in the running browser");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = () => resolve(null)));

  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (!msg.id) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    // A protocol-level error must surface, not hang the caller forever.
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  };

  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise<unknown>((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
  };

  await send("Page.enable");
  await send("Runtime.enable");

  return {
    evaluate: async (expression) => {
      const res = (await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as {
        result?: { value?: unknown };
        exceptionDetails?: { text: string };
      };
      if (res.exceptionDetails) {
        throw new Error(`page threw: ${res.exceptionDetails.text}`);
      }
      return res.result?.value;
    },
    send,
    navigate: async (url) => {
      await send("Page.navigate", { url });
    },
    setViewport: async (width, height) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 768,
      });
    },
    screenshot: async (path) => {
      const res = (await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      })) as { data: string };
      await Bun.write(path, Buffer.from(res.data, "base64"));
    },
    close: () => ws.close(),
  };
};
