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

  it("shares one rule guide between HELP and Learn", async () => {
    const [help, learn, guide] = await Promise.all([
      read("frontend/src/components/game-help.tsx"),
      read("frontend/src/routes/learn.tsx"),
      read("frontend/src/components/rule-guide.tsx"),
    ]);

    expect(help).toContain(
      'import { RuleGuide } from "@/components/rule-guide"',
    );
    expect(learn).toContain(
      'import { RuleGuide } from "@/components/rule-guide"',
    );
    expect(learn).toContain("helpRuleVariants().map");
    expect(learn).toContain("resolvePlayerColorPair()");
    expect(learn).not.toMatch(/\[\s*["']standard["']/);
    expect(guide).toContain("data-help-board");
    expect(guide).toContain('role="img"');
    expect(guide).toContain('aria-hidden="true"');
  });
});
