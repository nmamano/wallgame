/**
 * render-4090.mjs deletes its own folders on the 4090 at every end of a job
 * (board task f240d1e4). The real script runs under node, against stand-ins
 * for ssh, scp, systemctl and desktop-run that act on a fake 4090 home folder
 * in a temp folder, so no test touches the 4090.
 *
 * Paths covered: a full render that passes; a lint that passes; a render
 * that fails (its log comes back); a render that fails with no log to copy;
 * desktop-run refusing the job after the send; the video copy failing (the
 * job folder with the video stays, the unit folder goes); SIGTERM during the
 * render. A preview and a quick look end through the same two calls as a
 * full render (failCleaned, cleanRemote), so they need no case of their own.
 *
 * Slow on purpose: the two cases where scp fails wait out the runner's three
 * copy tries, 5 s apart (COPY_ATTEMPTS, RETRY_MS), about 15 s each.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CAPTURE_CACHE, REMOTE_JOBS } from "./render-4090.mjs";
import { PAWN_ART_PROBE } from "../capture-cache.mjs";
import { testTmp } from "../test-tmp";

/** This file's temp dirs, removed after its tests (cb84d862). */
const TEST_TMP = testTmp();

const RUNNER = join(import.meta.dir, "render-4090.mjs");
const UNIT = "20261106T000000Z-wg-video-0123456789ab";
const JOB_ID = "job-cleanup-0001";
const GAME_ID = "cleanupG";

type Mode =
  | "ok-render"
  | "ok-lint"
  | "fail"
  | "fail-nolog"
  | "start-fail"
  | "running";

const script = (path: string, text: string) => {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

/** A fake 4090 and office box for one job; `scpFails` is a regex on paths. */
const setup = (mode: Mode, scpFails = "") => {
  const t = TEST_TMP.dir("render-cleanup-");
  const remote = join(t, "remote");
  const local = join(t, "local");
  const bin = join(t, "bin");
  for (const d of [remote, bin, join(local, "nil/infra/bin"), join(t, "out")]) {
    mkdirSync(d, { recursive: true });
  }
  // A capture, for the lint (it reads the cache).
  const capture = join(remote, CAPTURE_CACHE, GAME_ID);
  mkdirSync(capture, { recursive: true });
  writeFileSync(join(capture, "capture.json"), `{"probe":"${PAWN_ART_PROBE}"}`);

  script(
    join(bin, "ssh"),
    `#!/usr/bin/env bash
cmd="\${@: -1}"
cd ${remote} && HOME=${remote} PATH=${bin}:$PATH exec bash -c "$cmd"
`,
  );
  script(
    join(bin, "scp"),
    `#!/usr/bin/env bash
dest="\${@: -1}"; code=0; re='${scpFails}'
for a in "$@"; do
  case "$a" in fakehost:*)
    p="\${a#fakehost:}"
    if [[ -n $re && $p =~ $re ]] || ! cp "$p" "$dest" 2>/dev/null; then code=1; fi;;
  esac
done
exit $code
`,
  );
  script(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash\necho "$*" >> ${t}/systemctl.log\n`,
  );
  script(
    join(local, "nil/infra/bin/desktop-run"),
    `#!/usr/bin/env bash
set -e
mode=${mode}
if [[ $mode == start-fail ]]; then echo "desktop-run: no budget" >&2; exit 1; fi
j=${remote}/jobs/${UNIT}
mkdir -p $j/tmp
head -c 100000 /dev/zero > $j/tmp/chromium-profile
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case \${args[i]} in --out) out=\${args[i+1]};; --log) log=\${args[i+1]};; --edl) edl=\${args[i+1]};; esac
done
dir=$(dirname "$edl")
echo "started=now threads=1 x" > $j/meta
case $mode in
  ok-render)
    printf video > "$out"; printf sheet > "$dir/sheet.png"; echo "render ok" > "$log"
    v=$(sha256sum "$out" | cut -d' ' -f1); s=$(sha256sum "$dir/sheet.png" | cut -d' ' -f1)
    echo "RESULT {\\"draft\\":false,\\"fromCache\\":false,\\"sha256\\":\\"$v\\",\\"bytes\\":5,\\"sheet\\":{\\"png\\":\\"$dir/sheet.png\\",\\"sha256\\":\\"$s\\"}}" >> $j/log
    echo exit=0 >> $j/meta;;
  ok-lint) echo "lint ok" > "$log"; echo 'RESULT {"lint":{"faults":[]}}' >> $j/log; echo exit=0 >> $j/meta;;
  fail) echo "renderer: boom" > "$log"; echo exit=1 >> $j/meta;;
  fail-nolog) echo exit=1 >> $j/meta;;
  running) ;;
esac
echo "started job-${UNIT}"
`,
  );
  const edl = join(t, "out", "edl.json");
  writeFileSync(edl, JSON.stringify({ gameId: GAME_ID }));
  const args =
    mode === "ok-lint"
      ? ["--lint", "--edl", edl, "--job-id", JOB_ID]
      : ["--edl", edl, "--job-id", JOB_ID, "--out", join(t, "out", "out.mp4")];
  const env = {
    ...process.env,
    HOME: local,
    PATH: `${bin}:${process.env.PATH}`,
    WALLGAME_GPU_HOST: "fakehost",
    TMPDIR: TEST_TMP.root,
  };
  return {
    t,
    edl,
    jobDir: join(remote, REMOTE_JOBS, JOB_ID),
    unitDir: join(remote, "jobs", UNIT),
    spawn: () =>
      Bun.spawn(["node", RUNNER, ...args, "--workers", "1"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      }),
  };
};

const runToEnd = async (mode: Mode, scpFails = "") => {
  const job = setup(mode, scpFails);
  const p = job.spawn();
  const [code, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { ...job, code, stdout, stderr };
};

describe("render-4090.mjs deletes its folders on the 4090 at every end", () => {
  test("a full render that passes", async () => {
    const r = await runToEnd("ok-render");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("RESULT ");
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.unitDir)).toBe(false);
  });

  test("a lint that passes", async () => {
    const r = await runToEnd("ok-lint");
    expect(r.code).toBe(0);
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.unitDir)).toBe(false);
  });

  test("a render that fails: the log comes back first", async () => {
    const r = await runToEnd("fail");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the 4090 render failed (exit 1)");
    expect(readFileSync(join(r.t, "out", "out.mp4-render.log"), "utf8")).toBe(
      "renderer: boom\n",
    );
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.unitDir)).toBe(false);
  });

  test("a render that fails with no log: deleted anyway, and said", async () => {
    const r = await runToEnd("fail-nolog");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not copy the render log back");
    expect(existsSync(r.jobDir)).toBe(false);
    expect(existsSync(r.unitDir)).toBe(false);
  }, 30_000);

  test("desktop-run refuses the job after the send", async () => {
    const r = await runToEnd("start-fail");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("desktop-run did not start the render");
    expect(existsSync(r.jobDir)).toBe(false);
  });

  test("the video copy fails: the video stays, the unit folder goes", async () => {
    const r = await runToEnd("ok-render", "out\\.mp4$");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`it stays on the 4090 in `);
    expect(existsSync(join(r.jobDir, "out.mp4"))).toBe(true);
    expect(existsSync(r.unitDir)).toBe(false);
  }, 30_000);

  test("SIGTERM during the render stops the unit, then deletes", async () => {
    const job = setup("running");
    const p = job.spawn();
    const reader = p.stdout.getReader();
    let seen = "";
    while (!seen.includes("on the 4090 (job-")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(existsSync(job.unitDir)).toBe(true);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(1);
    expect(readFileSync(join(job.t, "systemctl.log"), "utf8")).toContain(
      `--user stop job-${UNIT}`,
    );
    expect(existsSync(job.jobDir)).toBe(false);
    expect(existsSync(job.unitDir)).toBe(false);
  });
});
