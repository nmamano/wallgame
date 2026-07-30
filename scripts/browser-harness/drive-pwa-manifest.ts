/**
 * Question: would a browser actually install this site as an app, and would the
 * installed icon be the right one?
 *
 * Reading `site.webmanifest` by eye cannot answer that. A manifest can be valid
 * JSON, be served with a 200, and still be uninstallable - and on this site the
 * icon paths resolved to the SPA's index.html rather than to PNGs, which looks
 * identical to "fine" from curl because the fallback also answers 200.
 *
 * So this asks Chrome instead. `Page.getAppManifest` returns Chrome's own parse,
 * including the errors it would show in DevTools' Application panel, and each
 * icon is then fetched to check it is really an image and not HTML wearing a
 * .png suffix.
 *
 * Usage:
 *   bun scripts/browser-harness/drive-pwa-manifest.ts [url]
 *
 * Run it against production BEFORE changing anything: a check you have never
 * seen fail is not evidence that the after-state is good.
 */
import { launchChrome, connect, wait } from "./cdp";
import { startStubServer } from "./stub-server";

interface ManifestResult {
  url?: string;
  data?: string;
  errors?: {
    message: string;
    critical: boolean;
    line: number;
    column: number;
  }[];
}

/**
 * With no argument, checks the local `frontend/dist` through the stub server -
 * which falls back to index.html for unknown paths exactly as production does,
 * so a missing icon fails here the same way it fails there. Pass a URL to check
 * a deployed site instead.
 */
const explicitTarget = Bun.argv[2];
const stub = explicitTarget ? undefined : startStubServer({ routes: {} });
const target = explicitTarget ?? `${stub!.url}/`;

const browser = await launchChrome();
try {
  const page = await connect();
  await page.navigate(target);
  await wait(2500);

  const manifest = (await page.send("Page.getAppManifest")) as ManifestResult;

  console.log(`\n=== ${target}`);
  console.log(`manifest url: ${manifest.url ?? "(none linked)"}`);

  const errors = manifest.errors ?? [];
  if (errors.length === 0) {
    console.log("chrome parse errors: none");
  } else {
    console.log(`chrome parse errors: ${errors.length}`);
    for (const e of errors) {
      console.log(`  [${e.critical ? "CRITICAL" : "warn"}] ${e.message}`);
    }
  }

  if (!manifest.data) {
    console.log("no manifest body; nothing further to check");
  } else {
    const parsed = JSON.parse(manifest.data) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      scope?: string;
      display?: string;
      theme_color?: string;
      background_color?: string;
      icons?: {
        src: string;
        sizes?: string;
        type?: string;
        purpose?: string;
      }[];
    };

    // The fields Chrome's installability criteria actually read.
    for (const field of [
      "name",
      "short_name",
      "start_url",
      "scope",
      "display",
      "theme_color",
      "background_color",
    ] as const) {
      const value = parsed[field];
      const shown =
        value === undefined
          ? "MISSING"
          : value === ""
            ? 'EMPTY STRING ""'
            : String(value);
      console.log(`  ${field.padEnd(18)} ${shown}`);
    }

    // An icon entry proves nothing until the bytes come back as an image.
    const icons = parsed.icons ?? [];
    console.log(`  icons              ${icons.length} declared`);
    const base = manifest.url ?? target;
    for (const icon of icons) {
      const resolved = new URL(icon.src, base).href;
      const probe = (await page.evaluate(`
        fetch(${JSON.stringify(resolved)}, { cache: "no-store" })
          .then(r => r.headers.get("content-type") ?? "(no content-type)")
          .catch(e => "FETCH FAILED: " + e.message)
      `)) as string;
      const ok = probe.startsWith("image/");
      console.log(
        `    ${ok ? "ok  " : "BAD "} ${icon.sizes ?? "?"} ${icon.purpose ?? "any"} -> ${probe}  ${resolved}`,
      );
    }

    const has192 = icons.some((i) => i.sizes?.split(" ").includes("192x192"));
    const has512 = icons.some((i) => i.sizes?.split(" ").includes("512x512"));
    const displayOk = ["fullscreen", "standalone", "minimal-ui"].includes(
      parsed.display ?? "",
    );
    const named = Boolean(parsed.name || parsed.short_name);
    console.log(
      `  installable fields: name=${named} 192=${has192} 512=${has512} display=${displayOk} start_url=${Boolean(parsed.start_url)}`,
    );
  }

  // Chrome's own verdict, which beats the field checklist above because it is
  // the code that actually decides. The method is deprecated and may vanish;
  // when it does, the checklist is the fallback rather than a silent pass.
  try {
    const verdict = (await page.send("Page.getInstallabilityErrors")) as {
      installabilityErrors?: { errorId: string; errorArguments: unknown[] }[];
    };
    const problems = verdict.installabilityErrors ?? [];
    if (problems.length === 0) {
      console.log("  chrome verdict:    installable (no errors reported)");
    } else {
      console.log(`  chrome verdict:    ${problems.length} problem(s)`);
      for (const p of problems) console.log(`    - ${p.errorId}`);
    }
  } catch (e) {
    console.log(`  chrome verdict:    unavailable (${(e as Error).message})`);
  }

  // What the app actually paints, so background_color can be checked against it
  // rather than against a hex someone typed once.
  const painted = await page.evaluate(
    `getComputedStyle(document.body).backgroundColor`,
  );
  console.log(`  painted body bg:   ${String(painted)}`);

  page.close();
} finally {
  browser.stop();
  stub?.stop();
}
