import { describe, expect, it } from "bun:test";

const read = (path: string) => Bun.file(path).text();

describe("game HELP discoverability", () => {
  it("keeps a named HELP trigger in both desktop and phone game surfaces", async () => {
    const [route, panel, help] = await Promise.all([
      read("frontend/src/routes/game.$id.tsx"),
      read("frontend/src/components/game-info-panel.tsx"),
      read("frontend/src/components/game-help.tsx"),
    ]);

    expect(route).toContain('placement="phone"');
    expect(panel).toContain('placement="desktop"');
    expect(help.match(/aria-label="Game help"/g)).toHaveLength(2);
  });
});
