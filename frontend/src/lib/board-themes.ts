/**
 * Board themes change how the board itself is drawn - currently the joints
 * where walls cross. The stored value is a plain string (see
 * shared/contracts/settings.ts), so unknown values fall back to "default".
 */
export const BOARD_THEMES = ["default", "crisp"] as const;

export type BoardTheme = (typeof BOARD_THEMES)[number];

export const BOARD_THEME_LABELS: Record<BoardTheme, string> = {
  default: "Default",
  crisp: "Crisp",
};

export const isBoardTheme = (value: string): value is BoardTheme =>
  (BOARD_THEMES as readonly string[]).includes(value);
