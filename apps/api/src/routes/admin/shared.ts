import type { ClassificationLabel } from '../../types/api';
import type { AiClassificationMode } from '../../types/classification';

export const MAX_BULK_APPROVE_ITEMS = 50;
export const D1_BATCH_STATEMENTS_SAFE_LIMIT = 30;
export const ASSIGNABLE_LABELS = new Set<ClassificationLabel>([
  'confidential',
  'internal',
  'public',
]);
export const VALID_AI_MODES = new Set<AiClassificationMode>([
  'disabled',
  'metadata_only',
  'content_excerpt',
]);

export interface StorageStatRow {
  classification: ClassificationLabel;
  file_count: number;
  total_bytes: number;
  updated_at: string;
}

export interface AuditLogRow {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  classification_snapshot: string | null;
  status: 'allowed' | 'blocked';
  metadata_json: string | null;
  created_at: string;
}

/** Flush grouped per-file atomic statement batches without splitting a file across chunks. */
export async function executeGroupedBatches(
  db: D1Database,
  groups: D1PreparedStatement[][]
): Promise<D1Result[]> {
  const results: D1Result[] = [];
  let current: D1PreparedStatement[] = [];
  for (const stmts of groups) {
    if (current.length > 0 && current.length + stmts.length > D1_BATCH_STATEMENTS_SAFE_LIMIT) {
      results.push(...(await db.batch(current)));
      current = [];
    }
    current.push(...stmts);
  }
  if (current.length > 0) {
    results.push(...(await db.batch(current)));
  }
  return results;
}

