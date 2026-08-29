import { CircleHelp } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type {
  GamePawnType,
  PawnType,
  PlayerId,
  RulesVariant,
  Variant,
} from "../../../shared/domain/game-types";
import {
  helpVariantFor,
  helpRulesFor,
  resolveRulePlayer,
} from "../../../shared/domain/variant-rules";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PawnImage } from "@/components/pawn-image";
import type { PlayerColor } from "@/lib/player-colors";
import { colorFilterMap, colorHexMap } from "@/lib/player-colors";
import { resolvePawnStyleSrc } from "@/lib/pawn-style";
import { cn } from "@/lib/utils";

interface GameHelpProps {
  variant: Variant;
  playerColors: Record<PlayerId, PlayerColor>;
  primaryLocalPlayerId: PlayerId | null;
  placement: "desktop" | "phone";
}

interface RulePawnProps {
  type: PawnType;
  color: PlayerColor;
  label?: string;
  compact?: boolean;
}

function RulePawn({ type, color, label, compact = false }: RulePawnProps) {
  return (
    <div className="w-[52px] text-center text-[11px] text-muted-foreground sm:w-[62px]">
      <PawnImage
        src={resolvePawnStyleSrc(undefined, type)}
        alt={label ?? type}
        className={cn(
          "mx-auto mb-1",
          compact ? "size-[34px] sm:size-10" : "size-11 sm:size-[50px]",
        )}
        imageStyle={{ filter: colorFilterMap[color] }}
      />
      {label}
    </div>
  );
}

interface DemoBoardProps {
  pawn?: GamePawnType;
  color: PlayerColor;
  wall?: "vertical" | "horizontal";
}

function DemoBoard({ pawn, color, wall }: DemoBoardProps) {
  const cells = Array.from({ length: 9 }, (_, index) => index);
  const movementMarks: Partial<Record<number, string>> = {
    1: "↑",
    3: "←",
    5: "→",
    7: "↓",
  };
  const wallStyle = {
    backgroundColor: colorHexMap[color],
  } satisfies CSSProperties;

  return (
    <div
      className="relative mb-1 grid size-[122px] grid-cols-3 grid-rows-3 gap-[7px] bg-slate-950 sm:size-[146px]"
      data-help-board
    >
      {cells.map((index) => (
        <div key={index} className="grid place-items-center bg-slate-700/70">
          {pawn && index === 4 && (
            <PawnImage
              src={resolvePawnStyleSrc(undefined, pawn)}
              alt={pawn}
              className="size-[31px] sm:size-[38px]"
              imageStyle={{ filter: colorFilterMap[color] }}
            />
          )}
          {pawn && movementMarks[index] && (
            <span className="text-[21px] font-bold text-amber-400 sm:text-[25px]">
              {movementMarks[index]}
            </span>
          )}
        </div>
      ))}
      {wall === "vertical" && (
        <span
          className="absolute left-[36px] top-[42px] z-10 h-[38px] w-[7px] shadow-sm sm:left-11 sm:top-[50px] sm:h-[46px]"
          data-help-wall="vertical"
          style={wallStyle}
        />
      )}
      {wall === "horizontal" && (
        <span
          className="absolute left-[42px] top-[36px] z-10 h-[7px] w-[38px] shadow-sm sm:left-[50px] sm:top-11 sm:w-[46px]"
          data-help-wall="horizontal"
          style={wallStyle}
        />
      )}
    </div>
  );
}

function GoalContent({
  variant,
  playerColors,
  diagramPlayerId,
}: {
  variant: RulesVariant;
  playerColors: Record<PlayerId, PlayerColor>;
  diagramPlayerId: PlayerId;
}) {
  const rules = helpRulesFor(variant);
  const diagramColor = playerColors[diagramPlayerId];

  if (rules.captureKind === "reach-home") {
    return (
      <div className="flex items-center justify-center gap-3 sm:gap-6">
        <RulePawn type="cat" color={diagramColor} label="Cat" />
        <p className="max-w-[260px] text-center text-base font-bold sm:text-lg">
          The first cat to reach home wins.
        </p>
        <RulePawn type="home" color={diagramColor} label="Home" />
      </div>
    );
  }

  if (rules.captureKind === "animal-cycle") {
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:gap-x-[22px]">
        {rules.captureRelations.map((relation) => {
          const hunterPlayer = resolveRulePlayer(
            relation.hunter.player,
            diagramPlayerId,
          );
          const targetPlayer = resolveRulePlayer(
            relation.target.player,
            diagramPlayerId,
          );
          return (
            <div
              key={`${relation.hunter.type}-${relation.target.type}`}
              className="flex items-center justify-center gap-[7px] sm:gap-3.5"
            >
              <RulePawn
                type={relation.hunter.type}
                color={playerColors[hunterPlayer]}
                compact
              />
              <span className="text-sm font-bold text-foreground sm:text-[15px]">
                captures
              </span>
              <RulePawn
                type={relation.target.type}
                color={playerColors[targetPlayer]}
                compact
              />
            </div>
          );
        })}
        <p className="col-span-2 m-0 text-center font-semibold">
          First capture wins.
        </p>
      </div>
    );
  }

  const opponent: PlayerId = diagramPlayerId === 1 ? 2 : 1;
  return (
    <div className="flex items-center justify-center gap-[18px] sm:gap-8">
      <RulePawn type="cat" color={diagramColor} label="Cat" />
      <span className="text-sm font-bold text-foreground sm:text-[15px]">
        captures
      </span>
      <RulePawn
        type="mouse"
        color={playerColors[opponent]}
        label="Opponent's mouse"
      />
    </div>
  );
}

function RuleSection({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-[11px] border border-border bg-muted/30 p-2.5 sm:p-[13px]">
      {children}
    </section>
  );
}

function HelpContent({
  variant,
  playerColors,
  primaryLocalPlayerId,
}: Omit<GameHelpProps, "placement"> & { variant: RulesVariant }) {
  const rules = helpRulesFor(variant);
  const diagramPlayerId = primaryLocalPlayerId ?? 1;
  const diagramColor = playerColors[diagramPlayerId];
  const movementExamples =
    rules.captureKind === "cat-captures-mouse"
      ? ([
          ["cat", "Cat move"],
          ["mouse", "Mouse move"],
        ] as const)
      : rules.captureKind === "reach-home"
        ? ([["cat", "Cat move"]] as const)
        : ([["cat", "Any animal"]] as const);
  const wallPath =
    rules.captureKind === "reach-home"
      ? "Walls can't block a cat from reaching home."
      : rules.captureKind === "animal-cycle"
        ? "Walls can't block an animal from reaching its target."
        : "Walls can't block a cat from reaching its target mouse.";

  return (
    <>
      <div className="min-h-[98px] rounded-[11px] border border-border bg-muted/40 px-11 py-3 sm:px-14 sm:py-3.5">
        <GoalContent
          variant={variant}
          playerColors={playerColors}
          diagramPlayerId={diagramPlayerId}
        />
      </div>
      <p className="my-2.5 text-center text-[13px] font-semibold text-foreground sm:my-[13px] sm:text-sm">
        Make 2 actions per turn:
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
        <RuleSection>
          <h2 className="mb-[7px] text-base font-semibold sm:mb-2.5">
            Movement action
          </h2>
          <div className="flex flex-wrap items-start justify-center gap-4 sm:gap-3">
            {movementExamples.map(([pawn, label]) => (
              <div
                key={label}
                className="text-center text-[11px] text-muted-foreground"
              >
                <DemoBoard pawn={pawn} color={diagramColor} />
                {label}
              </div>
            ))}
          </div>
          <p className="mb-0 mt-[7px] text-center text-xs text-foreground sm:mt-2.5 sm:text-sm">
            Move 1 square per action. Diagonal is 2 actions.
          </p>
        </RuleSection>
        <RuleSection>
          <h2 className="mb-[7px] text-base font-semibold sm:mb-2.5">
            Wall action
          </h2>
          <div className="flex flex-wrap items-start justify-center gap-4 sm:gap-3">
            <div className="text-center text-[11px] text-muted-foreground">
              <DemoBoard wall="vertical" color={diagramColor} />
              Vertical wall
            </div>
            <div className="text-center text-[11px] text-muted-foreground">
              <DemoBoard wall="horizontal" color={diagramColor} />
              Horizontal wall
            </div>
          </div>
          <div className="mt-[7px] text-center text-xs text-foreground sm:mt-2.5 sm:text-sm">
            <p className="my-1">Walls are permanent.</p>
            <p className="my-1 font-normal">{wallPath}</p>
          </div>
        </RuleSection>
      </div>
    </>
  );
}

export function GameHelp({
  variant,
  playerColors,
  primaryLocalPlayerId,
  placement,
}: GameHelpProps) {
  const helpVariant = helpVariantFor(variant);
  if (!helpVariant) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        {placement === "phone" ? (
          <button
            type="button"
            aria-label="Game help"
            className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-[7px] text-[10px] font-semibold tracking-[0.025em] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <CircleHelp className="size-3.5" />
            HELP
          </button>
        ) : (
          <Button
            type="button"
            aria-label="Game help"
            variant="outline"
            className="h-6 px-[7px] text-[11px] font-semibold tracking-[0.02em] text-muted-foreground shadow-none"
          >
            HELP
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="game-help-motion max-h-[calc(100dvh-1.25rem)] max-w-[calc(100%-1.25rem)] gap-0 overflow-y-auto p-3.5 sm:max-h-[calc(100dvh-2rem)] sm:max-w-[780px] sm:p-[22px]"
        overlayClassName="game-help-motion"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Game help</DialogTitle>
        <HelpContent
          variant={helpVariant}
          playerColors={playerColors}
          primaryLocalPlayerId={primaryLocalPlayerId}
        />
      </DialogContent>
    </Dialog>
  );
}
