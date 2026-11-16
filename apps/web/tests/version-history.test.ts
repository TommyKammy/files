import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClientError } from '@/lib/files-api/core';
import {
  buildContextMenuCapabilities,
  type ContextRowTarget,
} from '@/lib/workspace-actions';
import {
  buildVersionHistoryView,
  canDownloadVersion,
  canRestoreVersion,
  describeVersionRequestError,
  describeVersionRestoreError,
  formatVersionComment,
  formatVersionNumber,
  mapApiFileRecordToFileItem,
  mergeVersionPages,
  nextVersionNumber,
  parseFileLock,
  resolveCurrentVersionNum,
  sortVersionsNewestFirst,
  VERSION_ACTIONS_RESPONSIVE_CLASS,
  VERSION_ROW_RESPONSIVE_CLASS,
  versionAuthorLabel,
  versionUploadStatusMeta,
} from '@/lib/version-history';
import type { FileItem, FileVersionItem, FolderSummary } from '@/types/files';

function version(
  versionNum: number,
  overrides: Partial<FileVersionItem> = {}
): FileVersionItem {
  return {
    id: `ver-${versionNum}`,
    versionNum,
    sizeBytes: 120 * versionNum,
    mimeType: 'text/plain',
    uploadedBy: 'dev-admin-001',
    uploadedByName: 'Dev Admin',
    createdAt: `2026-11-16T0${versionNum}:00:00.000Z`,
    uploadStatus: 'completed',
    isCurrent: false,
    ...overrides,
  };
}

function file(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 'file-1',
    folder_id: 'folder-1',
    name: 'spec.txt',
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: 120,
    current_version_num: 2,
    meta_version: 2,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

function folder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id: 'folder-1',
    parent_id: null,
    name: 'Folder 1',
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-11-16T00:00:00.000Z',
    effectiveRole: 'editor',
    ...overrides,
  };
}

test('sort/merge keep newest-first API order and dedupe paginated rows', () => {
  const v1 = version(1);
  const v2 = version(2);
  const v3 = version(3);

  assert.deepEqual(
    sortVersionsNewestFirst([v1, v3, v2]).map((v) => v.versionNum),
    [3, 2, 1]
  );

  const merged = mergeVersionPages(
    [v3, v2],
    [v2, v1, version(1, { sizeBytes: 999 })]
  );
  assert.deepEqual(
    merged.map((v) => v.versionNum),
    [3, 2, 1]
  );
  assert.equal(merged[2]?.sizeBytes, 999, 'incoming page wins on duplicate id');
});

test('current version, next version, and view rows derive one authoritative badge', () => {
  const versions = [
    version(1),
    version(2, { isCurrent: true }),
    version(3, { uploadStatus: 'pending' }),
  ];
  assert.equal(resolveCurrentVersionNum(versions, 2), 2);
  assert.equal(
    resolveCurrentVersionNum(versions, 1),
    2,
    'the API isCurrent flag wins over a newer pending upload'
  );
  assert.equal(nextVersionNumber(versions, 2), 4);
  assert.equal(nextVersionNumber([], 7), 8);

  const rows = buildVersionHistoryView(versions, {
    currentVersionNum: 2,
    effectiveRole: 'editor',
    canDownload: true,
  });
  assert.equal(rows.filter((row) => row.isCurrent).length, 1);
  assert.equal(rows[0]?.versionLabel, 'v3');
  assert.equal(rows[0]?.isCurrent, false, 'pending v3 is not current');
  assert.equal(rows[0]?.canPreview, false);
  assert.equal(rows[1]?.versionLabel, 'v2');
  assert.equal(rows[1]?.isCurrent, true);
  assert.equal(rows[1]?.canRestore, false, 'current version is not restorable');
  assert.equal(rows[2]?.canRestore, true);
  assert.equal(formatVersionNumber(4), 'v4');
});

test('RBAC: previewer can preview, viewer can download, editor can restore', () => {
  const completed = version(1);
  const pending = version(2, { uploadStatus: 'pending' });
  const current = { ...version(3), isCurrent: true };

  assert.equal(canDownloadVersion(completed, 'viewer'), true);
  assert.equal(canDownloadVersion(completed, 'previewer'), false);
  assert.equal(canDownloadVersion(pending, 'owner'), false);
  assert.equal(canDownloadVersion(completed, 'owner'), true);

  assert.equal(canRestoreVersion(completed, 'viewer'), false);
  assert.equal(canRestoreVersion(completed, 'previewer'), false);
  assert.equal(canRestoreVersion(completed, 'editor'), true);
  assert.equal(canRestoreVersion(pending, 'owner'), false);
  assert.equal(canRestoreVersion(current, 'owner'), false);

  const previewerRows = buildVersionHistoryView([completed, pending], {
    currentVersionNum: 2,
    effectiveRole: 'previewer',
    canDownload: false,
  });
  assert.equal(previewerRows.find((r) => r.version.versionNum === 1)?.canPreview, true);
  assert.equal(previewerRows.find((r) => r.version.versionNum === 1)?.canDownload, false);
  assert.equal(previewerRows.find((r) => r.version.versionNum === 1)?.canRestore, false);
  assert.equal(previewerRows.find((r) => r.version.versionNum === 2)?.canPreview, false);
});

test('context menu exposes versionHistory for a single file at previewer+', () => {
  const fileRow: ContextRowTarget = { kind: 'file', file: file() };
  const folderRow: ContextRowTarget = { kind: 'folder', folder: folder() };
  const base = {
    primaryRow: fileRow,
    currentFolderId: 'folder-1',
    folderRole: 'editor' as const,
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: false,
    clipboardHasFiles: false,
  };

  for (const role of ['previewer', 'viewer', 'editor', 'owner'] as const) {
    const caps = buildContextMenuCapabilities({
      ...base,
      targets: [fileRow],
      resolveRowRole: () => role,
    });
    assert.equal(caps.canVersionHistory, true, `${role} should see 版履歴`);
  }

  const previewerCaps = buildContextMenuCapabilities({
    ...base,
    targets: [fileRow],
    resolveRowRole: () => 'previewer',
  });
  assert.equal(previewerCaps.canDownload, false);
  assert.equal(previewerCaps.canVersionHistory, true);

  const folderCaps = buildContextMenuCapabilities({
    ...base,
    targets: [folderRow],
    primaryRow: folderRow,
    resolveRowRole: () => 'editor',
  });
  assert.equal(folderCaps.canVersionHistory, false);

  const multiCaps = buildContextMenuCapabilities({
    ...base,
    targets: [fileRow, { kind: 'file', file: file({ id: 'file-2' }) }],
    resolveRowRole: () => 'editor',
  });
  assert.equal(multiCaps.canVersionHistory, false);
});

test('mobile layout tokens stack row metadata and actions below sm', () => {
  for (const token of [
    VERSION_ROW_RESPONSIVE_CLASS,
    VERSION_ACTIONS_RESPONSIVE_CLASS,
  ]) {
    assert.match(token, /\bflex-col\b/);
    assert.match(token, /\bsm:flex-row\b/);
  }
  assert.match(VERSION_ACTIONS_RESPONSIVE_CLASS, /\bw-full\b/);
  assert.match(VERSION_ACTIONS_RESPONSIVE_CLASS, /\bsm:w-auto\b/);
});

test('author/status/comment formatting never leaks blank labels', () => {  assert.equal(versionAuthorLabel(version(1)), 'Dev Admin');
  assert.equal(
    versionAuthorLabel(version(1, { uploadedByName: '   ' })),
    'ユーザー dev-admi'
  );
  assert.equal(
    versionAuthorLabel(version(1, { uploadedByName: null, uploadedBy: '' })),
    '不明なユーザー'
  );
  assert.equal(versionUploadStatusMeta('completed').label, '完了');
  assert.equal(versionUploadStatusMeta('pending').label, 'アップロード中');
  assert.equal(versionUploadStatusMeta('failed').label, '失敗');
  assert.equal(formatVersionComment('Restored from v2'), 'v2 から復元');
  assert.equal(formatVersionComment(null, 4), 'v4 から復元');
  assert.equal(formatVersionComment('  '), null);
});

test('restore API snake_case rows map into the client FileItem cache shape', () => {
  const mapped = mapApiFileRecordToFileItem({
    id: 'file-1',
    folder_id: 'folder-1',
    name: 'spec.txt',
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: 120,
    current_version_num: 3,
    meta_version: 9,
    classification: 'confidential',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-11-16T03:00:00.000Z',
    deleted_at: null,
    upload_state: 'active',
  });
  assert.ok(mapped);
  assert.equal(mapped?.current_version_num, 3);
  assert.equal(mapped?.meta_version, 9);
  assert.equal(mapped?.classification, 'confidential');
  assert.equal(mapped?.upload_state, 'active');
  assert.equal(mapApiFileRecordToFileItem(null), null);
  assert.equal(mapApiFileRecordToFileItem({ name: 'missing-id' }), null);
});

test('FILE_LOCKED and 409 restore errors produce actionable Japanese messages', () => {
  const lock = {
    fileId: 'file-1',
    tenantId: 'tenant-default',
    mode: 'desktop_exclusive' as const,
    lockId: 'lock-1',
    ownerId: 'dev-admin-001',
    ownerName: 'Dev Admin',
    ownerEmail: 'dev-admin@example.com',
    sessionId: null,
    acquiredAt: 1,
    expiresAt: 2,
    updatedAt: 2,
  };
  const locked = describeVersionRestoreError(
    new ApiClientError(409, 'File is locked', 'FILE_LOCKED', { lock })
  );
  assert.equal(locked.code, 'FILE_LOCKED');
  assert.equal(locked.lock?.ownerName, 'Dev Admin');
  assert.match(locked.message, /ロック保有者: Dev Admin/);
  assert.match(locked.message, /dev-admin@example\.com/);
  assert.match(locked.message, /Files Drive 排他ロック/);
  assert.deepEqual(parseFileLock(lock), lock);
  assert.equal(parseFileLock({ ownerName: 'x', mode: 'bogus' }), null);

  assert.match(
    describeVersionRestoreError(
      new ApiClientError(409, 'Version conflict', 'VERSION_CONFLICT')
    ).message,
    /別の操作で更新/
  );
  assert.match(
    describeVersionRestoreError(
      new ApiClientError(409, 'already current', 'VERSION_ALREADY_CURRENT')
    ).message,
    /既に現在版/
  );
  assert.match(
    describeVersionRestoreError(
      new ApiClientError(409, 'missing', 'VERSION_CONTENT_NOT_FOUND')
    ).message,
    /ストレージに見つかりません/
  );
  assert.match(
    describeVersionRestoreError(
      new ApiClientError(409, 'pending', 'VERSION_NOT_COMPLETED')
    ).message,
    /アップロードが完了していない/
  );
  assert.match(
    describeVersionRestoreError(new ApiClientError(403, 'Forbidden')).message,
    /Editor 以上/
  );
});

test('preview/download 403 errors are handled with explicit DLP guidance', () => {
  const download = describeVersionRequestError(
    new ApiClientError(403, 'Forbidden'),
    'download'
  );
  assert.equal(download.code, null);
  assert.match(download.message, /Previewer/);
  assert.match(download.message, /DLP/);

  const preview = describeVersionRequestError(
    new ApiClientError(403, 'Forbidden'),
    'preview'
  );
  assert.match(preview.message, /プレビューする権限/);

  const list = describeVersionRequestError(
    new ApiClientError(403, 'Forbidden'),
    'list'
  );
  assert.match(list.message, /版履歴を表示する権限/);
});
