import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  Variant,
  GameConfiguration,
  PlayerAppearance,
} from "../../../shared/domain/game-types";
import type {
  ListBotsResponse,
  ListRecommendedBotsResponse,
} from "../../../shared/contracts/custom-bot-protocol";
import type { CreateBotGameResponse } from "../../../shared/contracts/games";
import { fetchBots, fetchRecommendedBots, playVsBot } from "@/lib/api";
import { refetchWhileBotsAway } from "@/lib/bots-availability";

/** V3: Bot query settings - no timeControl (bot games are untimed) */
export interface BotsQuerySettings {
  variant: Variant;
  randomStart: boolean;
  boardWidth?: number;
  boardHeight?: number;
}

export const useBotsQuery = (settings: BotsQuerySettings) => {
  return useQuery<ListBotsResponse>({
    queryKey: [
      "bots",
      settings.variant,
      settings.randomStart,
      settings.boardWidth ?? null,
      settings.boardHeight ?? null,
    ],
    queryFn: () => fetchBots(settings),
    refetchInterval: refetchWhileBotsAway,
  });
};

/** V3: Recommended bots query - no timeControl (bot games are untimed) */
export const useRecommendedBotsQuery = (
  variant: Variant,
  randomStart: boolean,
) => {
  return useQuery<ListRecommendedBotsResponse>({
    queryKey: ["bots", "recommended", variant, randomStart],
    queryFn: () => fetchRecommendedBots({ variant, randomStart }),
    refetchInterval: refetchWhileBotsAway,
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
