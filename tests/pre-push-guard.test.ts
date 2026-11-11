import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The pre-push hook (.husky/pre-push) and its commit checks
 * (scripts/check-pushed-commits.sh), run on throwaway repositories.
 *
 * Every git command here gets a whole environment of its own, with HOME in
 * the fixture: no inherited GIT_DIR from a hook (task 8d8bf577), and no
 * ~/.gitconfig (hooks, signing, identity) from the machine.
 */

const repoRoot = resolve(import.meta.dir, "..");
const guard = join(repoRoot, "scripts/check-pushed-commits.sh");
const zero = "0".repeat(40);
const noreply = "3745260+nmamano@users.noreply.github.com";
const personal = "someone@example.com";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const fixtureRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-guard-"));
  roots.push(root);
  return root;
};

const cleanEnv = (home: string, extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  ...extra,
});

interface Identity {
  author: string;
  committer: string;
}

const makeRepo = () => {
  const root = fixtureRoot();
  const dir = join(root, "repo");
  mkdirSync(dir);
  const git = (args: string[], identity?: Identity) => {
    const who = identity ?? { author: noreply, committer: noreply };
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: cleanEnv(root, {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: who.author,
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: who.committer,
      }),
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string, identity?: Identity) => {
    git(["add", "-A", "."]);
    git(["commit", "-q", "-m", message], identity);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", "main"]);
  write("README.md", "one\n");
  write(".claude/settings.local.json", '{"allow":[]}\n');
  const base = commit("base: the settings file is still tracked");
  git(["update-ref", "refs/remotes/origin/main", base]);

  /** Runs the guard on one pushed ref, as the hook does. */
  const push = (localSha: string, remoteSha = base) => {
    const result = spawnSync("sh", [guard], {
      cwd: dir,
      encoding: "utf8",
      env: cleanEnv(root),
      input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const untrack = () => {
    git(["rm", "-q", "--cached", ".claude/settings.local.json"]);
    write(".gitignore", ".claude/settings.local.json\nops-private/\n");
    git(["add", ".gitignore"]);
    git(["commit", "-q", "-m", "untrack the settings file"]);
    return git(["rev-parse", "HEAD"]);
  };
  return { git, write, commit, push, untrack, base };
};

describe("pre-push guard: ignored paths", () => {
  it("passes an untrack commit after commits that still hold the already-public file", () => {
    const repo = makeRepo();
    repo.write("README.md", "two\n");
    repo.commit("a commit that still holds the settings file");
    const tip = repo.untrack();

    const result = repo.push(tip);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // The paths the push changes, for the hook's game-video gate.
    expect(result.stdout.trim().split("\n")).toEqual([
      ".claude/settings.local.json",
      ".gitignore",
      "README.md",
    ]);
    // A new branch is checked against origin/main, with the same result.
    expect(repo.push(tip, zero).status).toBe(0);
  });

  it("refuses a commit that adds an ignored file for the first time", () => {
    const repo = makeRepo();
    repo.untrack();
    repo.write("ops-private/runbook.md", "private\n");
    repo.git(["add", "-f", "ops-private/runbook.md"]);
    const tip = repo.commit("adds a private runbook");

    const result = repo.push(tip);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds files that .gitignore keeps local");
    expect(result.stderr).toContain("  ops-private/runbook.md");
  });

  it("refuses a changed version of an already-public ignored file", () => {
    const repo = makeRepo();
    repo.write(".claude/settings.local.json", '{"token":"new"}\n');
    repo.commit("changes the settings file before it is untracked");
    const tip = repo.untrack();

    const result = repo.push(tip);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("  .claude/settings.local.json");
  });
});

describe("pre-push guard: emails", () => {
  it("refuses a commit whose author email is not a GitHub noreply address", () => {
    const repo = makeRepo();
    repo.write("README.md", "two\n");
    const tip = repo.commit("personal author", {
      author: personal,
      committer: noreply,
    });

    const result = repo.push(tip);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "author email is not a GitHub noreply address",
    );
  });

  it("refuses a commit whose committer email is not a GitHub noreply address", () => {
    const repo = makeRepo();
    repo.write("README.md", "two\n");
    repo.commit("personal committer", { author: noreply, committer: personal });
    repo.write("README.md", "three\n");
    const tip = repo.commit("a good commit on top");

    const result = repo.push(tip);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "committer email is not a GitHub noreply address",
    );
  });
});

describe("pre-push hook", () => {
  it("runs the checks without the git variables that point at a repository", () => {
    // The hook with stubs for its two scripts: the commit checks pass and
    // print nothing, and the parallel runner records its git variables.
    const root = fixtureRoot();
    const dir = join(root, "hook");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, ".husky"));
    copyFileSync(
      join(repoRoot, ".husky/pre-push"),
      join(dir, ".husky/pre-push"),
    );
    chmodSync(join(dir, ".husky/pre-push"), 0o755);
    writeFileSync(
      join(dir, "scripts/check-pushed-commits.sh"),
      "cat >/dev/null\n",
    );
    const seen = join(root, "seen.txt");
    writeFileSync(
      join(dir, "scripts/run-parallel.sh"),
      `env | grep '^GIT_' > '${seen}' || true\n`,
    );

    const decoy = join(root, "decoy.git");
    const result = spawnSync("sh", ["-e", ".husky/pre-push"], {
      cwd: dir,
      encoding: "utf8",
      env: cleanEnv(root, {
        GIT_DIR: decoy,
        GIT_INDEX_FILE: join(decoy, "index"),
        GIT_WORK_TREE: dir,
        GIT_COMMON_DIR: decoy,
        GIT_OBJECT_DIRECTORY: join(decoy, "objects"),
      }),
      input: "",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // Only the test's own GIT_CONFIG_NOSYSTEM is left.
    const names = readFileSync(seen, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")[0]);
    expect(names).toEqual(["GIT_CONFIG_NOSYSTEM"]);
  });
});
