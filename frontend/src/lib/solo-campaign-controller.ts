import type { PlayerId, Move, Cell } from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import type { SoloCampaignAIType } from "../../../shared/domain/solo-campaign-levels";
import {
  computeFleeAiMove,
  computeChaseAiMove,
} from "../../../shared/domain/solo-campaign-ai";

export interface SoloCampaignAIConfig {
  playerId: PlayerId;
  aiType: SoloCampaignAIType;
  moveDelayMs?: number;
}

/**
 * Controller for solo campaign AI opponent.
 * Computes moves automatically using flee or chase AI logic.
 */
export class SoloCampaignAIController {
  public readonly playerId: PlayerId;
  private readonly aiType: SoloCampaignAIType;
  private readonly moveDelayMs: number;
  private cancelled = false;

  constructor(config: SoloCampaignAIConfig) {
    this.playerId = config.playerId;
    this.aiType = config.aiType;
    this.moveDelayMs = config.moveDelayMs ?? 1000;
  }

  /**
   * Compute and return the AI's move after a delay.
   */
  async makeMove(gameState: GameState): Promise<Move | null> {
    this.cancelled = false;

    // Wait for the configured delay
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.moveDelayMs);
    });

    if (this.cancelled) {
      return null;
    }

    // Get current positions
    const grid = gameState.grid;
    const pawns = gameState.getPawns();

    // Find the AI's pawn and opponent's pawn
    // In survival: P1 has cat, P2 has mouse
    const aiPawn = pawns.find((p) => p.playerId === this.playerId);
    const opponentPawn = pawns.find((p) => p.playerId !== this.playerId);

    if (!aiPawn || !opponentPawn) {
      console.error("Could not find pawns for AI move computation");
      return { actions: [] };
    }

    const aiPos: Cell = aiPawn.cell;
    const opponentPos: Cell = opponentPawn.cell;

    // Compute move based on AI type
    if (this.aiType === "flee") {
      // Flee AI: move away from opponent (used for mouse evading cat)
      return computeFleeAiMove(grid, aiPos, opponentPos);
    } else {
      // Chase AI: move toward opponent (used for cat chasing mouse)
      return computeChaseAiMove(grid, aiPos, opponentPos);
    }
  }

  /**
   * Cancel any pending move computation.
   */
  cancel(): void {
    this.cancelled = true;
  }
}
