/**
 * Makes the user's board theme available to every board on the page.
 *
 * Boards are rendered from seven different routes; rather than threading the
 * setting through each of them, this mirrors what ThemeProvider does for
 * light/dark. Outside a provider the hook falls back to "default", so a Board
 * still renders on its own.
 */
import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import { isBoardTheme, type BoardTheme } from "@/lib/board-themes";

const BoardThemeContext = createContext<BoardTheme>("default");

export function BoardThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Navigation already fetches this query, so it costs nothing extra here.
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const { boardTheme } = useSettings(!!userData?.user, userPending);

  return (
    <BoardThemeContext.Provider
      value={isBoardTheme(boardTheme) ? boardTheme : "default"}
    >
      {children}
    </BoardThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBoardTheme(): BoardTheme {
  return useContext(BoardThemeContext);
}
