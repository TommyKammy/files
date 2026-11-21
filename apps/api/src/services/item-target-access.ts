import type { AuthUser, ClassificationLabel } from '../types/api';
import {
  canAccess,
  hasAtLeastRole,
  resolveTargetAccess,
  type TargetMetadata,
} from './authorization';
import type { Capability } from './capabilities';

export type ItemTargetType = 'file' | 'folder';
export type ItemTargetAccessMode = 'read' | 'write' | 'task_create';

export type ItemTargetAccessResult =
  | { ok: true; access: TargetMetadata; classification: ClassificationLabel }
  | { ok: false; status: 403 | 404; error: string };

const MODE_CAPABILITY: Record<
  ItemTargetAccessMode,
  Record<ItemTargetType, Capability>
> = {
  read: { file: 'item.preview', folder: 'folder.traverse' },
  write: { file: 'item.edit_content', folder: 'folder.rename' },
  task_create: { file: 'item.edit_content', folder: 'folder.create' },
};

const BATCH_ACCESS_CHUNK_SIZE = 10;

export function parseItemTargetType(value: string): ItemTargetType | null {
  return value === 'file' || value === 'folder' ? value : null;
}

export function normalizeTargetId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

/**
 * Verifies that an item exists, is active (not deleted/pending upload),
 * and that the caller has the required access for the requested mode.
 */
export async function verifyItemTargetAccess(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId'>,
  itemType: ItemTargetType,
  itemId: string,
  mode: ItemTargetAccessMode
): Promise<ItemTargetAccessResult> {
  const access = await resolveTargetAccess(db, user, itemType, itemId);
  if (
    !access ||
    !access.exists ||
    access.deletedAt !== null ||
    (itemType === 'file' && access.uploadState !== 'active')
  ) {
    return { ok: false, status: 404, error: 'Item not found' };
  }
  if (access.accessMode !== 'full') {
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  const requiredCap = MODE_CAPABILITY[mode][itemType];
  const allowed =
    mode === 'read'
      ? canAccess(access, requiredCap)
      : canAccess(access, requiredCap) ||
        hasAtLeastRole(access.effectiveRole, 'editor');

  if (!allowed) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  return { ok: true, access, classification: access.classification };
}

/**
 * Filters rows by readable target access, deduplicating (item_type, item_id)
 * pairs and resolving unique targets in concurrent batches.
 */
export async function filterReadableItems<
  T extends { item_type: ItemTargetType; item_id: string },
>(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId'>,
  rows: readonly T[]
): Promise<T[]> {
  if (rows.length === 0) return [];

  const uniqueTargets = new Map<
    string,
    { itemType: ItemTargetType; itemId: string }
  >();
  for (const row of rows) {
    const key = `${row.item_type}:${row.item_id}`;
    if (!uniqueTargets.has(key)) {
      uniqueTargets.set(key, { itemType: row.item_type, itemId: row.item_id });
    }
  }

  const entries = Array.from(uniqueTargets.entries());
  const readableByKey = new Map<string, boolean>();

  for (let i = 0; i < entries.length; i += BATCH_ACCESS_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + BATCH_ACCESS_CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map(async ([key, target]) => {
        const authz = await verifyItemTargetAccess(
          db,
          user,
          target.itemType,
          target.itemId,
          'read'
        );
        return [key, authz.ok] as const;
      })
    );
    for (const [key, ok] of results) {
      readableByKey.set(key, ok);
    }
  }

  return rows.filter(
    (row) => readableByKey.get(`${row.item_type}:${row.item_id}`) === true
  );
}
