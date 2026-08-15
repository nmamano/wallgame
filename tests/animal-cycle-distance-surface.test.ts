import { describe, expect, it } from "bun:test";

describe("Animal Cycle player timers", () => {
  it("omit goal distance in both game layouts", async () => {
    const route = await Bun.file("frontend/src/routes/game.$id.tsx").text();
    const timer = await Bun.file(
      "frontend/src/components/player-timer-card.tsx",
    ).text();

    expect(route).toContain(
      'const showsGoalDistance = info.config?.variant !== "animal-cycle";',
    );
    expect(route.match(/showsGoalDistance\s*\?/g)).toHaveLength(4);
    expect(timer).toContain("goalDistance?: number | null;");
    expect(timer.match(/goalDistance !== undefined &&/g)).toHaveLength(2);
  });
});
