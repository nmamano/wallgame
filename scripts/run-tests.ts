import { Glob } from "bun";

async function runTests() {
  const glob = new Glob("tests/integration/*.test.ts");
  const testFiles = [...glob.scanSync(".")].sort();

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
