import type { ClassificationLabel } from '../types/api';

export const VALID_CLASSIFICATIONS = new Set<ClassificationLabel>([
  'unset',
  'confidential',
  'internal',
  'public',
]);

/** Sensitivity strictness order (`confidential` is strictly highest). */
export const CLASSIFICATION_STRICTNESS: Record<ClassificationLabel, number> = {
  unset: 0,
  public: 1,
  internal: 2,
  confidential: 3,
};

export function isClassificationStricter(
  candidate: ClassificationLabel,
  baseline: ClassificationLabel
): boolean {
  return CLASSIFICATION_STRICTNESS[candidate] > CLASSIFICATION_STRICTNESS[baseline];
}

export function pickStricterClassification(
  a: ClassificationLabel,
  b: ClassificationLabel
): ClassificationLabel {
  return CLASSIFICATION_STRICTNESS[a] >= CLASSIFICATION_STRICTNESS[b] ? a : b;
}
