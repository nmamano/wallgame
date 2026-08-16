import { describe, it, expect } from "bun:test";
import { messageFromApiErrorBody } from "./api-error";

/**
 * The exact body a local server returned on 2026-08-16 for the create-game
 * request that board c8e27470 reports, captured verbatim rather than
 * hand-written: a hand-written shape can drift from what the server sends,
 * which is the whole reason this bug existed.
 */
const ANIMAL_CYCLE_400 = {
  success: false,
  error: {
    name: "ZodError",
    message: JSON.stringify([
      {
        code: "custom",
        path: ["config", "randomStart"],
        message:
          "Animal Cycle Random Start requires both board dimensions to be at least 4.",
      },
    ]),
  },
};

describe("messageFromApiErrorBody", () => {
  it("reads the reason out of a validation failure instead of printing [object Object]", () => {
    const message = messageFromApiErrorBody(
      ANIMAL_CYCLE_400,
      400,
      "Bad Request",
    );
    expect(message).toBe(
      "Animal Cycle Random Start requires both board dimensions to be at least 4.",
    );
  });

  /**
   * The guard that matters. The old code did `new Error(data.error)` with
   * `error` typed as a string; String()-ing that object is what a player saw.
   * Asserting the good sentence is not enough on its own - a future rewrite
   * could still fall back to the object somewhere - so name the bad output.
   */
  it("never yields the coerced-object text", () => {
    expect(
      messageFromApiErrorBody(ANIMAL_CYCLE_400, 400, "Bad Request"),
    ).not.toContain("[object Object]");
  });

  it("keeps a plain string error untouched", () => {
    expect(
      messageFromApiErrorBody({ error: "Game not found." }, 404, "Not Found"),
    ).toBe("Game not found.");
  });

  it("joins several issues and says each complaint once", () => {
    const body = {
      error: {
        name: "ZodError",
        message: JSON.stringify([
          { message: "Board is too small." },
          { message: "Board is too small." },
          { message: "Time control is missing." },
        ]),
      },
    };
    expect(messageFromApiErrorBody(body, 400, "Bad Request")).toBe(
      "Board is too small. Time control is missing.",
    );
  });

  it("falls back to the status when the body carries no usable reason", () => {
    const fallback = "Request failed: 500 Internal Server Error";
    expect(messageFromApiErrorBody(null, 500, "Internal Server Error")).toBe(
      fallback,
    );
    expect(messageFromApiErrorBody({}, 500, "Internal Server Error")).toBe(
      fallback,
    );
    expect(
      messageFromApiErrorBody({ error: "   " }, 500, "Internal Server Error"),
    ).toBe(fallback);
    expect(
      messageFromApiErrorBody({ error: {} }, 500, "Internal Server Error"),
    ).toBe(fallback);
  });

  it("uses the message of a non-Zod error object", () => {
    expect(
      messageFromApiErrorBody(
        { error: { message: "Upstream timed out." } },
        502,
        "Bad Gateway",
      ),
    ).toBe("Upstream timed out.");
  });
});
