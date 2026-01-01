import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  TimeControlPreset,
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

export interface BotsQuerySettings {
  variant: Variant;
  timeControl: TimeControlPreset;
  boardWidth?: number;
  boardHeight?: number;
}

export const useBotsQuery = (settings: BotsQuerySettings) => {
  return useQuery<{ bots: ListedBot[] }>({
    queryKey: [
      "bots",
      settings.variant,
      settings.timeControl,
      settings.boardWidth ?? null,
      settings.boardHeight ?? null,
    ],
    queryFn: () => fetchBots(settings),
  });
};

export const useRecommendedBotsQuery = (
  variant: Variant,
  timeControl: TimeControlPreset,
) => {
  return useQuery<{ bots: RecommendedBotEntry[] }>({
    queryKey: ["bots", "recommended", variant, timeControl],
    queryFn: () => fetchRecommendedBots({ variant, timeControl }),
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
