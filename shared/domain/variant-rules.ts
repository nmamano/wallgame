import type {
  GamePawnType,
  PawnFamily,
  PawnType,
  PlayerId,
  RulesVariant,
  Variant,
} from "./game-types";

export type PawnOwner = PlayerId | "self" | "opponent";

export interface PawnRuleReference {
  player: PawnOwner;
  type: PawnType;
}

export interface CaptureRelation {
  hunter: PawnRuleReference;
  target: PawnRuleReference;
}

export interface ExecutableVariantRules {
  variant: Variant;
  pawnFamily: PawnFamily;
  pawnSet: readonly { playerId: PlayerId; type: PawnType }[];
  goalTargets: Readonly<Record<PlayerId, PawnRuleReference>>;
  captureKind: "cat-captures-mouse" | "reach-home" | "animal-cycle";
  captureRelations: readonly CaptureRelation[];
  mouseMovement: "allowed" | "forbidden" | "survival-config";
  teammatesMayShareCell: boolean;
  oneMoveDraw: boolean;
}

const standardRules = {
  variant: "standard",
  pawnFamily: "standard",
  pawnSet: [
    { playerId: 1, type: "cat" },
    { playerId: 1, type: "mouse" },
    { playerId: 2, type: "cat" },
    { playerId: 2, type: "mouse" },
  ],
  goalTargets: {
    1: { player: 2, type: "mouse" },
    2: { player: 1, type: "mouse" },
  },
  captureKind: "cat-captures-mouse",
  captureRelations: [
    {
      hunter: { player: "self", type: "cat" },
      target: { player: "opponent", type: "mouse" },
    },
  ],
  mouseMovement: "allowed",
  teammatesMayShareCell: true,
  oneMoveDraw: true,
} as const satisfies ExecutableVariantRules;

const classicRules = {
  variant: "classic",
  pawnFamily: "classic",
  pawnSet: [
    { playerId: 1, type: "cat" },
    { playerId: 1, type: "home" },
    { playerId: 2, type: "cat" },
    { playerId: 2, type: "home" },
  ],
  goalTargets: {
    1: { player: 1, type: "home" },
    2: { player: 2, type: "home" },
  },
  captureKind: "reach-home",
  captureRelations: [
    {
      hunter: { player: "self", type: "cat" },
      target: { player: "self", type: "home" },
    },
  ],
  mouseMovement: "forbidden",
  teammatesMayShareCell: true,
  oneMoveDraw: true,
} as const satisfies ExecutableVariantRules;

const animalCycleRules = {
  variant: "animal-cycle",
  pawnFamily: "animal-cycle",
  pawnSet: [
    { playerId: 1, type: "cat" },
    { playerId: 1, type: "elephant" },
    { playerId: 2, type: "mouse" },
    { playerId: 2, type: "dog" },
  ],
  goalTargets: {
    1: { player: 2, type: "cat" },
    2: { player: 1, type: "mouse" },
  },
  captureKind: "animal-cycle",
  captureRelations: [
    {
      hunter: { player: 1, type: "cat" },
      target: { player: 2, type: "mouse" },
    },
    {
      hunter: { player: 2, type: "mouse" },
      target: { player: 1, type: "elephant" },
    },
    {
      hunter: { player: 1, type: "elephant" },
      target: { player: 2, type: "dog" },
    },
    {
      hunter: { player: 2, type: "dog" },
      target: { player: 1, type: "cat" },
    },
  ],
  mouseMovement: "allowed",
  teammatesMayShareCell: false,
  oneMoveDraw: false,
} as const satisfies ExecutableVariantRules;

const survivalRules = {
  variant: "survival",
  pawnFamily: "survival",
  pawnSet: [
    { playerId: 1, type: "cat" },
    { playerId: 2, type: "mouse" },
  ],
  goalTargets: {
    1: { player: 2, type: "mouse" },
    2: { player: 2, type: "mouse" },
  },
  captureKind: "cat-captures-mouse",
  captureRelations: [
    {
      hunter: { player: 1, type: "cat" },
      target: { player: 2, type: "mouse" },
    },
  ],
  mouseMovement: "survival-config",
  teammatesMayShareCell: true,
  oneMoveDraw: false,
} as const satisfies ExecutableVariantRules;

export const EXECUTABLE_VARIANT_RULES = {
  standard: standardRules,
  classic: classicRules,
  "animal-cycle": animalCycleRules,
  survival: survivalRules,
} as const satisfies Record<Variant, ExecutableVariantRules>;

export const executableRulesFor = (variant: Variant): ExecutableVariantRules =>
  EXECUTABLE_VARIANT_RULES[variant];

export type HelpVariantRules = Extract<
  (typeof EXECUTABLE_VARIANT_RULES)[RulesVariant],
  { variant: RulesVariant }
>;

export const helpRulesFor = (variant: RulesVariant): HelpVariantRules =>
  EXECUTABLE_VARIANT_RULES[variant];

export const helpVariantFor = (variant: Variant): RulesVariant | null =>
  variant === "survival" ? null : variant;

export const resolveRulePlayer = (
  owner: PawnOwner,
  player: PlayerId,
): PlayerId => {
  if (owner === "self") return player;
  if (owner === "opponent") return player === 1 ? 2 : 1;
  return owner;
};

export const mouseCanMoveForRules = (
  rules: ExecutableVariantRules,
  survivalSetting: boolean,
): boolean =>
  rules.mouseMovement === "allowed" ||
  (rules.mouseMovement === "survival-config" && survivalSetting);

export const movablePawnTypesFor = (
  variant: Variant,
  playerId: PlayerId,
): readonly GamePawnType[] =>
  executableRulesFor(variant)
    .pawnSet.filter(
      (pawn): pawn is { playerId: PlayerId; type: GamePawnType } =>
        pawn.playerId === playerId && pawn.type !== "home",
    )
    .map((pawn) => pawn.type);
