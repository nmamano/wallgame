/**
 * Temp dirs for the game-video tests that leave nothing in /tmp (task
 * cb84d862, Warden, 2026-11-07: /tmp on auntie-2 had 189,061 entries, most
 * from these tests, and each bun start under /tmp was about 350 ms slower).
 *
 * Call testTmp() once at the top level of a test file: it makes one root
 * dir for that file and removes it in the file's afterAll. Its `dir`
 * makes each test's dir inside that root, and `root` is the TMPDIR to give
 * a child process, so the child's own temp files go there too.
 *
 * Call it per file, never once in a shared module: bun runs every test file
 * in one process with one module cache, so a root made at import would be
 * removed after the first file that imported it.
 */
import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * @param options.processTmp also point this process's TMPDIR at the root
 *   while the file's tests run, and put it back after: for a file whose
 *   tests start Chrome, which makes its own temp dir there and can remove
 *   it after the browser's close() has returned.
 */
export const testTmp = ({ processTmp = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "game-video-test-"));
  if (processTmp) {
    const before = process.env.TMPDIR;
    beforeAll(() => {
      process.env.TMPDIR = root;
    });
    afterAll(() => {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    });
  }
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    /** A new dir inside this file's root, named from `prefix`. */
    dir: (prefix: string) => mkdtempSync(join(root, prefix)),
  };
};
