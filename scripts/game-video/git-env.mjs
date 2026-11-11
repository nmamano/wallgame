/**
 * The environment for a git command that names its repository itself (-C
 * or cwd): this process's, without the variables that point git at a
 * repository.
 *
 * A git hook exports GIT_DIR (and from a linked worktree GIT_INDEX_FILE and
 * others) to what it runs, and those variables beat -C and cwd. On
 * 2026-11-11 a pre-push hook ran from a linked worktree ran the tests, and
 * ship.test.ts's fixture commands wrote into the real repository: its main
 * ref, its config (core.bare, user.name), a branch video/x and worktree
 * entries (task 8d8bf577).
 *
 * The list is git's own (`git rev-parse --local-env-vars`), so it never
 * falls behind git; FALLBACK_LOCAL_VARS (git 2.43's list) stands in only
 * when that command cannot run.
 */
import { spawnSync } from "node:child_process";

export const FALLBACK_LOCAL_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

const asked = spawnSync("git", ["rev-parse", "--local-env-vars"], {
  encoding: "utf8",
  cwd: "/",
  env: { PATH: process.env.PATH ?? "" },
});

/** The variables that point git at a repository. */
export const GIT_LOCAL_VARS =
  asked.status === 0 && asked.stdout.trim()
    ? asked.stdout.trim().split("\n")
    : FALLBACK_LOCAL_VARS;

/**
 * `env` without GIT_LOCAL_VARS, nor the numbered GIT_CONFIG_KEY_<n> and
 * GIT_CONFIG_VALUE_<n> that GIT_CONFIG_COUNT counts.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>}
 */
export const gitEnv = (env = process.env) =>
  /** @type {Record<string, string>} */ (
    Object.fromEntries(
      Object.entries(env).filter(
        ([name, value]) =>
          value !== undefined &&
          !GIT_LOCAL_VARS.includes(name) &&
          !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name),
      ),
    )
  );
