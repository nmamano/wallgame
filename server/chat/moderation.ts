import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";

export const MAX_MESSAGE_LENGTH = 280;

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export interface ModerationResult {
  allowed: boolean;
  code?: "MODERATION" | "TOO_LONG";
}

export function moderateMessage(text: string): ModerationResult {
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { allowed: false, code: "TOO_LONG" };
  }

  if (matcher.hasMatch(text)) {
    return { allowed: false, code: "MODERATION" };
  }

  return { allowed: true };
}
