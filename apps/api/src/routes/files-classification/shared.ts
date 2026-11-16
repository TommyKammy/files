import type { ClassificationLabel } from '../../types/api';

export const ASSIGNABLE_CLASSIFICATIONS = new Set<ClassificationLabel>([
  'confidential',
  'internal',
  'public',
]);

// Compatibility re-export: the implementation lives in `services` so restore,
// move and upload paths share one name-collision rule.
export { findActiveFileNameConflict } from '../../services/filename-conflict';

