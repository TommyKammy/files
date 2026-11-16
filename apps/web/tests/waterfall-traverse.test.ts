import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClientError } from '@/lib/files-api';
import {
  formatSharedItemPath,
  isPathOnlyAccessMode,
  readPermissionInheritanceMode,
} from '@/lib/permission-inheritance';
import { getDirectoryView, type CacheContext } from '@/lib/sync-store/cache';
import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import { formatPermissionError } from '@/lib/use-permissions-modal';
import type { FileItem, FolderSummary, TenantPolicyRow } from '@/types/files';

function makeFolder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id: 'folder-1',
    parent_id: null,
    name: 'Folder 1',
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFile(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 'file-1',
    folder_id: 'folder-1',
    name: 'secret.txt',
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: 10,
    current_version_num: 1,
    meta_version: 1,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDirectory(
  overrides: Partial<PersistedDirectoryRecord> = {}
): PersistedDirectoryRecord {
  return {
    dirKey: 'folder-1',
    folderId: 'folder-1',
    effectiveRole: 'previewer',
    capabilities: ['folder.traverse'],
    accessMode: 'path',
    folderIds: [],
    fileIds: ['file-1'],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 1,
    revalidatedAt: 1,
    stale: false,
    ...overrides,
  };
}

function makeCacheContext(
  overrides: Partial<CacheContext> = {}
): CacheContext {
  return {
    authStatus: 'authenticated',
    foldersById: new Map([['folder-1', makeFolder()]]),
    filesById: new Map([['file-1', makeFile()]]),
    directoriesByKey: new Map([['folder-1', makeDirectory()]]),
    rootFolderIds: [],
    pinnedFolderIds: [],
    now: () => 1,
    pruneAndSchedulePersist: () => undefined,
    emit: () => undefined,
    ...overrides,
  };
}

test('waterfall 409 errors become actionable Japanese guidance', () => {
  const err = new ApiClientError(
    409,
    'Permission is inherited from ancestor folder "Root" under waterfall inheritance; update it on the parent folder instead',
    'WATERFALL_INHERITED_LOCKED',
    {
      ancestorFolderName: 'Root',
      inheritedRole: 'viewer',
    }
  );
  const message = formatPermissionError(err, 'fallback');
  assert.match(message, /親フォルダ「Root」/);
  assert.match(message, /viewer/);
  assert.match(message, /親フォルダで変更してください/);
});

test('unknown permission errors fall back to a stable message', () => {
  assert.equal(
    formatPermissionError(new Error('boom'), '権限の付与に失敗しました'),
    '権限の付与に失敗しました'
  );
});

test('inheritance mode reads camelCase and snake_case policy projections', () => {
  const base: TenantPolicyRow = {
    tenant_id: 'tenant-1',
    enforce_company_only_links: 0,
    require_watermark_confidential: 0,
    max_link_expiration_days: 30,
    session_max_hours: 12,
    trash_retention_days: 30,
    ai_classification_mode: 'disabled',
    ai_auto_apply_threshold: null,
    updated_by: null,
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(readPermissionInheritanceMode(null), 'additive');
  assert.equal(readPermissionInheritanceMode(base), 'additive');
  assert.equal(
    readPermissionInheritanceMode({
      ...base,
      permissionInheritanceMode: 'waterfall',
    }),
    'waterfall'
  );
  assert.equal(
    readPermissionInheritanceMode({
      ...base,
      permission_inheritance_mode: 'waterfall',
    }),
    'waterfall'
  );
});

test('path-only access is detected and shared item paths include the workspace root', () => {
  assert.equal(isPathOnlyAccessMode('path'), true);
  assert.equal(isPathOnlyAccessMode('full'), false);
  assert.equal(isPathOnlyAccessMode(null), false);
  assert.equal(formatSharedItemPath([]), 'マイファイル (ルート)');
  assert.equal(
    formatSharedItemPath([{ name: 'Root' }, { name: 'DeptA' }]),
    'マイファイル / Root / DeptA'
  );
});

test('path-only directory views never expose stale cached files', () => {
  const view = getDirectoryView(makeCacheContext(), 'folder-1');
  assert.equal(view.accessMode, 'path');
  assert.deepEqual(view.capabilities, ['folder.traverse']);
  assert.deepEqual(view.files, []);
  assert.deepEqual(view.folders, []);
});

test('full directory views keep their files and accessMode', () => {
  const ctx = makeCacheContext({
    directoriesByKey: new Map([
      [
        'folder-1',
        makeDirectory({
          accessMode: 'full',
          effectiveRole: 'viewer',
          capabilities: ['folder.list', 'folder.traverse', 'item.preview'],
        }),
      ],
    ]),
  });
  const view = getDirectoryView(ctx, 'folder-1');
  assert.equal(view.accessMode, 'full');
  assert.deepEqual(view.files.map((file) => file.id), ['file-1']);
});
