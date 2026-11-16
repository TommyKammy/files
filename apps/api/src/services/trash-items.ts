export const MAX_TRASH_BULK_ITEMS = 100;

export type TrashItemType = 'file' | 'folder';

export interface TrashItemRefInput {
  type: TrashItemType;
  id: string;
}

export class TrashRequestError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 413,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'TrashRequestError';
  }
}

/**
 * Validate and normalize `{ items: [{ type, id }] }` once for every Trash bulk
 * endpoint. Duplicate `type:id` pairs are collapsed in first-seen order; a
 * malformed item rejects the whole request (per-item partial success only
 * applies to items that passed this structural validation).
 */
export function parseTrashItemsInput(
  rawItems: unknown,
  maxItems = MAX_TRASH_BULK_ITEMS
): TrashItemRefInput[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new TrashRequestError(
      400,
      'EMPTY_ITEMS',
      'items must be a non-empty array'
    );
  }

  const seen = new Set<string>();
  const normalized: TrashItemRefInput[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') {
      throw new TrashRequestError(
        400,
        'INVALID_ITEM',
        'Each item must be an object'
      );
    }
    const item = raw as { type?: unknown; id?: unknown };
    if (item.type !== 'file' && item.type !== 'folder') {
      throw new TrashRequestError(
        400,
        'INVALID_ITEM_TYPE',
        'item.type must be file or folder'
      );
    }
    if (typeof item.id !== 'string' || item.id.trim().length === 0) {
      throw new TrashRequestError(
        400,
        'INVALID_ITEM_ID',
        'item.id must be a non-empty string'
      );
    }
    const id = item.id.trim();
    const key = `${item.type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ type: item.type, id });
  }

  if (normalized.length > maxItems) {
    throw new TrashRequestError(
      400,
      'TOO_MANY_ITEMS',
      `Maximum ${maxItems} items per Trash request`
    );
  }

  return normalized;
}

export function parseTrashConflictPolicy(
  raw: unknown
): 'fail' | 'rename' {
  if (raw === undefined || raw === null) return 'fail';
  if (raw === 'fail' || raw === 'rename') return raw;
  throw new TrashRequestError(
    400,
    'INVALID_CONFLICT_POLICY',
    "conflictPolicy must be 'fail' or 'rename'"
  );
}
