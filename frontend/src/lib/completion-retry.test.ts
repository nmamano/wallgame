import { describe, expect, it } from "bun:test";
import { createCompletionRetry } from "./completion-retry";

/**
 * A client-asserted completion — a scripted puzzle solve (S-G3) or a solo
 * campaign level (S-CAMP) — is reported once, by an effect that fires a
 * single time per mounted puzzle or level. So if that report fails, the only
 * thing standing between the player and a lost completion is a retry that
 * actually SENDS AGAIN; clearing an error flag would look like a fix and lose
 * the completion.
 */
describe("retrying a failed completion report", () => {
  it("sends the failed id again", () => {
    const sent: string[] = [];
    const retry = createCompletionRetry({
      failedId: "7",
      pending: false,
      resend: (id) => sent.push(id),
    });

    expect(retry).not.toBeNull();
    retry?.();
    expect(sent).toEqual(["7"]);

    // And it stays usable if the network is still unhappy.
    retry?.();
    expect(sent).toEqual(["7", "7"]);
  });

  it("offers nothing to retry when no report failed", () => {
    expect(
      createCompletionRetry({
        failedId: null,
        pending: false,
        resend: () => {
          throw new Error("must not send");
        },
      }),
    ).toBeNull();
  });

  it("offers nothing while a report is in flight", () => {
    // Otherwise repeated clicks stack concurrent requests for the same id.
    expect(
      createCompletionRetry({
        failedId: "7",
        pending: true,
        resend: () => {
          throw new Error("must not send while pending");
        },
      }),
    ).toBeNull();
  });
});
