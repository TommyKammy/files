import type { ClassificationLabel } from '../../types/api';
import type { AiClassificationMode } from '../../types/classification';

export {
  D1_BATCH_STATEMENTS_SAFE_LIMIT,
  executeGroupedBatches,
} from '../../services/d1-batch';

export const MAX_BULK_APPROVE_ITEMS = 50;
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

