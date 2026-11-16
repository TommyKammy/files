/**
 * Compatibility surface for maintenance consumers. The implementation now
 * lives in `services/r2-gc.ts` so Cron purge and manual Trash purge share one
 * CoW-aware R2 deletion routine.
 */
export {
  buildInClauseDeleteStmts,
  deleteR2ObjectsAndAbortMultipart,
  fetchVersionObjectsForFiles,
  selectUnreferencedR2Keys,
} from '../../services/r2-gc';
export type { FileVersionObjectRow } from '../../services/r2-gc';
