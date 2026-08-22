import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RawJournal, writeCompletion } from "./policy_elo_window";

let roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "policy-elo-window-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("RawJournal recovery", () => {
  it("keeps complete rows and preserves an incomplete final row separately", () => {
    const root = temporaryRoot();
    const complete = JSON.stringify({ gameId: "complete", accepted: true });
    const tail = '{"gameId":"torn"';
    writeFileSync(join(root, "old.jsonl"), `${complete}\n${tail}`);

    const journal = new RawJournal(root, "resume");
    expect(journal.has("complete")).toBe(true);
    expect(journal.has("torn")).toBe(false);
    journal.close();

    const artifacts = readdirSync(join(root, "torn"));
    expect(artifacts).toHaveLength(1);
    expect(readFileSync(join(root, "torn", artifacts[0]), "utf8")).toBe(tail);
    expect(readFileSync(join(root, "old.jsonl"), "utf8")).toBe(`${complete}\n${tail}`);
  });

  it("accepts an identical completed row repeated across attempts", () => {
    const root = temporaryRoot();
    const row = `${JSON.stringify({ gameId: "same", accepted: true })}\n`;
    writeFileSync(join(root, "one.jsonl"), row);
    writeFileSync(join(root, "two.jsonl"), row);

    const journal = new RawJournal(root, "resume");
    expect(journal.has("same")).toBe(true);
    journal.close();
  });

  it("rejects rows that reuse a game ID with different contents", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "one.jsonl"), '{"gameId":"conflict","winner":"p1"}\n');
    writeFileSync(join(root, "two.jsonl"), '{"gameId":"conflict","winner":"p2"}\n');

    expect(() => new RawJournal(root, "resume")).toThrow(/conflicting raw gameId/);
  });

  it("appends a durable completed row and rejects a second append", () => {
    const root = temporaryRoot();
    const journal = new RawJournal(root, "attempt");
    journal.append({ gameId: "new", accepted: true });
    expect(() => journal.append({ gameId: "new", accepted: true })).toThrow(/duplicate gameId/);
    journal.close();
    expect(readFileSync(join(root, "attempt.jsonl"), "utf8")).toBe(
      '{"gameId":"new","accepted":true}\n',
    );
  });
});

describe("window completion", () => {
  it("exists only after the explicit durable success write and cannot be replaced", () => {
    const root = temporaryRoot();
    const path = join(root, "completions", "window.attempt.json");
    expect(() => readFileSync(path, "utf8")).toThrow();

    writeCompletion(path, { schema: "test", complete: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schema: "test",
      complete: true,
    });
    expect(() => writeCompletion(path, { schema: "test", complete: false })).toThrow();
  });
});
