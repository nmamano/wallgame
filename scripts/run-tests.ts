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

    const proc = Bun.spawn(["bun", "test", file], {
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
