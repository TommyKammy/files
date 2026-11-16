import { canAccess } from '@/lib/capabilities';
import type {
  AuthUser,
  Capability,
  TrashBulkItemRef,
  TrashBulkItemResult,
  TrashBulkItemStatus,
  TrashItem,
} from '@/types/files';

export const TRASH_BULK_MAX_ITEMS = 100;
export const TRASH_EMPTY_CONFIRMATION = 'EMPTY_TRASH' as const;

export const TRASH_PURGE_WARNINGS = [
  '完全に削除した項目は復元できません。',
  '関連する共有リンクとアクセス権限も同時に削除されます。',
] as const;

export function trashBulkItemKey(
  item: Pick<TrashBulkItemRef, 'type' | 'id'>
): string {
  return `${item.type}:${item.id}`;
}

export function toTrashBulkItemRefs(
  items: readonly Pick<TrashItem, 'type' | 'id'>[]
): TrashBulkItemRef[] {
  const seen = new Set<string>();
  const refs: TrashBulkItemRef[] = [];
  for (const item of items) {
    const key = trashBulkItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ type: item.type, id: item.id });
  }
  return refs;
}

export function chunkTrashBulkItems<T>(
  items: readonly T[],
  size = TRASH_BULK_MAX_ITEMS
): T[][] {
  if (items.length === 0) return [];
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

type TrashCapabilityItem = Pick<TrashItem, 'type'> & {
  effectiveRole?: TrashItem['effectiveRole'];
  capabilities?: Capability[];
};

/**
 * Restore mirrors the API:
 * - files: editor+, plus the existing sys/sec admin override
 * - folders: editor+ only (single-folder restore has no admin bypass)
 */
export function canRestoreTrashItem(
  item: TrashCapabilityItem,
  user: Pick<AuthUser, 'role'> | null | undefined
): boolean {
  if (!user) return false;
  if (
    item.type === 'file' &&
    (user.role === 'sys_admin' || user.role === 'sec_admin')
  ) {
    return true;
  }
  return canAccess(
    {
      capabilities: item.capabilities,
      effectiveRole: item.effectiveRole ?? null,
    },
    'trash.restore'
  );
}

/** Permanent deletion requires sys_admin or an effective owner/co_owner. */
export function canPurgeTrashItem(
  item: TrashCapabilityItem,
  user: Pick<AuthUser, 'role'> | null | undefined
): boolean {
  if (!user) return false;
  if (user.role === 'sys_admin') return true;
  return canAccess(
    {
      capabilities: item.capabilities,
      effectiveRole: item.effectiveRole ?? null,
    },
    'trash.purge'
  );
}

export interface TrashBulkCapabilities {
  restorableCount: number;
  purgableCount: number;
  restorableItems: TrashItem[];
  purgableItems: TrashItem[];
}

export function getTrashBulkCapabilities(
  items: readonly TrashItem[],
  user: Pick<AuthUser, 'role'> | null | undefined
): TrashBulkCapabilities {
  const restorableItems: TrashItem[] = [];
  const purgableItems: TrashItem[] = [];
  for (const item of items) {
    if (canRestoreTrashItem(item, user)) restorableItems.push(item);
    if (canPurgeTrashItem(item, user)) purgableItems.push(item);
  }
  return {
    restorableCount: restorableItems.length,
    purgableCount: purgableItems.length,
    restorableItems,
    purgableItems,
  };
}

export interface TrashBulkConfirmState {
  kind: 'purge' | 'empty';
  count: number;
  title: string;
  summary: string;
  warnings: string[];
  confirmLabel: string;
}

export function buildTrashPurgeConfirmState(
  count: number
): TrashBulkConfirmState {
  const safeCount = Math.max(0, Math.floor(count));
  return {
    kind: 'purge',
    count: safeCount,
    title: '完全削除の確認',
    summary: `${safeCount} 件を完全に削除します。`,
    warnings: [...TRASH_PURGE_WARNINGS],
    confirmLabel: '完全削除',
  };
}

export function buildTrashEmptyConfirmState(
  visibleCount: number
): TrashBulkConfirmState {
  const safeCount = Math.max(0, Math.floor(visibleCount));
  return {
    kind: 'empty',
    count: safeCount,
    title: 'ゴミ箱を空にする確認',
    summary:
      safeCount > 0
        ? `読み込み済みのゴミ箱から完全削除できる ${safeCount} 件を含め、権限のある全アイテムを削除します。`
        : 'ゴミ箱内で完全削除権限のある全アイテムを削除します。',
    warnings: [...TRASH_PURGE_WARNINGS],
    confirmLabel: 'ゴミ箱を空にする',
  };
}

export interface TrashBulkSummaryItem {
  type: 'file' | 'folder';
  id: string;
  key: string;
  name: string;
  status: TrashBulkItemStatus;
  code?: string;
  message: string;
}

export interface TrashBulkSummary {
  succeeded: TrashBulkSummaryItem[];
  failed: TrashBulkSummaryItem[];
  skipped: TrashBulkSummaryItem[];
  succeededKeys: Set<string>;
}

const ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN: '完全削除の権限がありません',
  FILE_LOCKED: '他のユーザーが編集中のためスキップしました',
  NOT_IN_TRASH: 'ゴミ箱にないため処理できませんでした',
  PARENT_FOLDER_DELETED: '親フォルダが削除済みです',
  PARENT_IN_TRASH: '親フォルダが削除済みです',
  NAME_CONFLICT: '同名のアイテムが存在します',
  UPLOAD_NOT_ACTIVE: 'アップロードが完了していないため削除できません',
  NOT_FOUND: '対象が見つかりません',
  INVALID_ITEM: 'アイテム情報が不正です',
};

export function formatTrashBulkFailureReason(
  code: string | undefined,
  fallback?: string
): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback?.trim() || '処理に失敗しました';
}

/**
 * Formats per-item API results for the failure dialog while preserving the
 * original selection order and human-readable names.
 */
export function summarizeTrashBulkResults(
  results: readonly TrashBulkItemResult[],
  selectedItems: readonly Pick<TrashItem, 'type' | 'id' | 'name'>[] = []
): TrashBulkSummary {
  const nameByKey = new Map(
    selectedItems.map((item) => [trashBulkItemKey(item), item.name])
  );
  const summary: TrashBulkSummary = {
    succeeded: [],
    failed: [],
    skipped: [],
    succeededKeys: new Set<string>(),
  };

  for (const result of results) {
    const key = trashBulkItemKey(result);
    const item: TrashBulkSummaryItem = {
      type: result.type,
      id: result.id,
      key,
      name: result.name ?? nameByKey.get(key) ?? result.id,
      status: result.status,
      code: result.code,
      message:
        result.status === 'succeeded'
          ? '完了'
          : formatTrashBulkFailureReason(result.code, result.error),
    };
    if (result.status === 'succeeded') {
      summary.succeeded.push(item);
      summary.succeededKeys.add(key);
    } else if (result.status === 'skipped') {
      summary.skipped.push(item);
    } else {
      summary.failed.push(item);
    }
  }
  return summary;
}

export function getTrashBulkActionResultMessage(
  action: 'restore' | 'purge' | 'empty',
  summary: TrashBulkSummary
): string {
  const count = summary.succeeded.length;
  if (count === 0) {
    return summary.skipped.length > 0
      ? 'ロック中のため処理できなかった項目があります'
      : '処理できた項目はありませんでした';
  }
  if (action === 'restore') return `${count} 件を復元しました`;
  if (action === 'empty') return `${count} 件をゴミ箱から完全削除しました`;
  return `${count} 件を完全削除しました`;
}

/** Synchronous double-submit guard used by the Trash bulk action hook. */
export function createTrashBulkGuard() {
  let running = false;
  return {
    isRunning(): boolean {
      return running;
    },
    async run<T>(
      task: () => Promise<T>
    ): Promise<{ started: false } | { started: true; value: T }> {
      if (running) return { started: false };
      running = true;
      try {
        return { started: true, value: await task() };
      } finally {
        running = false;
      }
    },
  };
}
