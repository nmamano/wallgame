import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  Variant,
  GameConfiguration,
  PlayerAppearance,
} from "../../../shared/domain/game-types";
import type {
  ListedBot,
  RecommendedBotEntry,
} from "../../../shared/contracts/custom-bot-protocol";
import type { CreateBotGameResponse } from "../../../shared/contracts/games";
import { fetchBots, fetchRecommendedBots, playVsBot } from "@/lib/api";

/** V3: Bot query settings - no timeControl (bot games are untimed) */
export interface BotsQuerySettings {
  variant: Variant;
  randomStart: boolean;
  boardWidth?: number;
  boardHeight?: number;
}

export const useBotsQuery = (settings: BotsQuerySettings) => {
  return useQuery<{ bots: ListedBot[] }>({
    queryKey: [
      "bots",
      settings.variant,
      settings.randomStart,
      settings.boardWidth ?? null,
      settings.boardHeight ?? null,
    ],
    queryFn: () => fetchBots(settings),
  });
};

/** V3: Recommended bots query - no timeControl (bot games are untimed) */
export const useRecommendedBotsQuery = (
  variant: Variant,
  randomStart: boolean,
) => {
  return useQuery<{ bots: RecommendedBotEntry[] }>({
    queryKey: ["bots", "recommended", variant, randomStart],
    queryFn: () => fetchRecommendedBots({ variant, randomStart }),
  });
};

export const usePlayVsBotMutation = () => {
  return useMutation<
    CreateBotGameResponse,
    Error,
    {
      botId: string;
      config: GameConfiguration;
      hostDisplayName?: string;
      hostAppearance?: PlayerAppearance;
    }
  >({
    mutationFn: ({ botId, config, hostDisplayName, hostAppearance }) =>
      playVsBot({
        botId,
        config,
        hostDisplayName,
        hostAppearance,
      }),
  });
};
