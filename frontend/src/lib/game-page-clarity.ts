import {
  variantDisplayName,
  type Variant,
} from "../../../shared/domain/game-types";

export const controlPanelVariantName = (variant: Variant): string =>
  variantDisplayName(variant);
