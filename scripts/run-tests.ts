/**
 * Which files are tests is decided by git, not by a pattern.
 *
 * A hand-maintained include pattern is what broke this: the runner globbed
 * `tests/**` only, so nine test files under frontend/src and one under
 * official-custom-bot-client/src never ran - not locally, and not in CI - and
 * nothing said so. A pattern that lists where tests live is a promise to update
 * it, and that promise is not kept.
 *
 * Nor can the pattern simply widen to the whole repo. `.cache/bun/` and
 * `frontend/.cache/bun/` hold 300+ VENDORED *.test.ts files (zod ships its
 * entire suite inside the package), so a repo-wide glob needs an exclusion
 * list, and that list is a second copy of .gitignore. eslint.config.js already
 * carries one such copy and says so in a comment; a third would be one more
 * thing to keep in step.
 *
 * `--cached --others --exclude-standard` is "tracked files, plus files that are
 * neither tracked nor ignored". The second half matters: a test written five
 * minutes ago and not yet `git add`ed still runs. Skipping a brand-new test is
 * the exact failure this collection rule exists to prevent.
 *
 * Paths are resolved against the current directory, as they were before.
 */
function collectTestFiles(): string[] {
  const listed = Bun.spawnSync([
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "*.test.ts",
    "*.test.tsx",
  ]);

  if (!listed.success) {
    const detail = new TextDecoder().decode(listed.stderr).trim();
    console.error("Cannot list test files: `git ls-files` failed.");
    if (detail) console.error(detail);
    console.error(
      "This runner asks git which files exist, so it needs a git checkout.",
    );
    process.exit(1);
  }

  const files = new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();

  // A run that collects nothing and reports success is the failure this
  // collection rule exists to prevent, so refuse it rather than pass.
  if (files.length === 0) {
    console.error("Found no test files. Run this from the repository root.");
    process.exit(1);
  }

  return files;
}

async function runTests() {
  const testFiles = collectTestFiles();

  console.log(`Found ${testFiles.length} test files\n`);

  let passed = 0;
  let failed = 0;

  for (const file of testFiles) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Running: ${file}`);
    console.log("=".repeat(60));

    // Run tests and capture output
    const proc = Bun.spawn([process.execPath, "test", file], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : "",
      proc.stderr ? new Response(proc.stderr).text() : "",
    ]);

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      passed++;
      console.log(`✓ ${file} passed`);
    } else {
      failed++;
      console.log(`✗ ${file} failed`);
      // Only show detailed output on failure
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
