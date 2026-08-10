/**
 * Tests for the container-start retry in tests/setup-db.ts. Board 04a59d77.
 *
 * These drive startContainerWithRetry with fakes rather than Docker, because
 * the behaviour under test is what happens when a container does NOT start,
 * and a real container that reliably fails to start is harder to arrange than
 * the thing it stands for. The end-to-end evidence - the same suite failing
 * with and without this fix, against a container forced never to become ready
 * - is in ops-private/task-04a59d77-knownbad-before.log and -after.log.
 */

import { describe, it, expect } from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { startContainerWithRetry } from "./setup-db";

/**
 * The helper only ever calls .stop() on a container it is disposing, so a fake
 * carrying that one method is enough. The cast is confined to this factory.
 */
function fakeContainer(onStop: () => void = () => undefined) {
  return {
    stop: () => {
      onStop();
      return Promise.resolve();
    },
  } as unknown as StartedTestContainer;
}

const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Awaits a promise that is expected to reject, and returns the reason.
 *
 * Written out rather than using `expect(...).rejects.toThrow(...)`, which in
 * bun 1.3.11 returns undefined - so awaiting it sequences nothing, which is
 * what @typescript-eslint/await-thenable objects to. Its assertions do run
 * today (a deliberately wrong pattern fails), but an await that reads as
 * ordering while doing nothing is a race waiting to be written. Here the
 * rejection is a real value, awaited at a point the test controls - which the
 * late-arrival test below depends on, since it must resolve the slow attempt
 * only AFTER the deadline has already fired.
 *
 * The resolve branch throws, so a promise that unexpectedly succeeds fails the
 * test loudly instead of leaving the assertions below with nothing to check.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected this to reject, but it resolved");
}

describe("startContainerWithRetry", () => {
  it("retries a transient failure and returns the container that starts", async () => {
    let calls = 0;
    const wanted = fakeContainer();

    const container = await startContainerWithRetry(
      () => {
        calls += 1;
        if (calls < 3) {
          return Promise.reject(
            new Error(`transient failure ${String(calls)}`),
          );
        }
        return Promise.resolve(wanted);
      },
      3,
      1_000,
    );

    expect(container).toBe(wanted);
    expect(calls).toBe(3);
  });

  it("names the container and every attempt's cause when all attempts fail", async () => {
    let calls = 0;

    const promise = startContainerWithRetry(
      () => {
        calls += 1;
        return Promise.reject(new Error(`boom ${String(calls)}`));
      },
      3,
      1_000,
    );

    // The message is the whole point of this task: it has to say a container
    // did not start, not leave the reader with a TypeError from teardown.
    const error = await rejectionOf(promise);
    expect(error.message).toMatch(
      /Postgres testcontainer did not start after 3 attempts/,
    );
    expect(error.message).toMatch(/attempt 1\/3: boom 1/);
    expect(error.message).toMatch(/attempt 3\/3: boom 3/);
    expect(calls).toBe(3);
  });

  it("bounds an attempt that hangs, rather than leaving it to the test runner", async () => {
    const startedAt = Date.now();

    const promise = startContainerWithRetry(
      () => new Promise<StartedTestContainer>(() => undefined),
      2,
      50,
    );

    const error = await rejectionOf(promise);
    expect(error.message).toMatch(/no result within 50ms/);
    // Two attempts of 50ms. A generous ceiling: the assertion that matters is
    // that this returns at all, since a hanging pull is not covered by
    // testcontainers' own withStartupTimeout.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("stops a container that arrives after its deadline, leaving no orphan", async () => {
    let stopped = 0;
    let arrive: ((container: StartedTestContainer) => void) | undefined;
    const slow = new Promise<StartedTestContainer>((resolve) => {
      arrive = resolve;
    });

    const error = await rejectionOf(startContainerWithRetry(() => slow, 1, 20));
    expect(error.message).toMatch(/did not start after 1 attempts/);
    expect(stopped).toBe(0);

    // The attempt we gave up on succeeds anyway. On a CI runner this is a live
    // Postgres, one per retry, that nothing else would ever shut down.
    arrive?.(
      fakeContainer(() => {
        stopped += 1;
      }),
    );
    await flushTimers();

    expect(stopped).toBe(1);
  });

  it("reports a missing container runtime immediately, without retrying it", async () => {
    let calls = 0;

    const promise = startContainerWithRetry(
      () => {
        calls += 1;
        return Promise.reject(
          new Error("Could not find a working container runtime strategy"),
        );
      },
      3,
      1_000,
    );

    // Retrying this would only delay the one message that tells the reader
    // what to do, so it must escape the loop on the first attempt.
    const error = await rejectionOf(promise);
    expect(error.message).toMatch(/Docker is not running/);
    expect(calls).toBe(1);
  });
});
