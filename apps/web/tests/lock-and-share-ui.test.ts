import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClientError } from '../src/lib/files-api/core';
import { formatFileLockError } from '../src/lib/files-api/locks';
import { canUserUnlockFileLock } from '../src/lib/use-file-lock-actions';
import { buildContextMenuCapabilities } from '../src/lib/workspace-actions';
import type { FileItem, FileLockInfo } from '../src/types/files';

function makeFile(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 'file-1',
    folder_id: 'folder-1',
    name: 'proposal.docx',
    extension: 'docx',
    mime_type:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size_bytes: 1024,
    current_version_num: 1,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-11-21T00:00:00.000Z',
    ...overrides,
  };
}

function makeLock(overrides: Partial<FileLockInfo> = {}): FileLockInfo {
  return {
    fileId: 'file-1',
    tenantId: 'tenant-1',
    mode: 'desktop_exclusive',
    lockId: 'drive:lock-1',
    ownerId: 'user-owner',
    ownerName: '山田太郎',
    ownerEmail: 'yamada@example.com',
    sessionId: null,
    acquiredAt: 1_700_000_000_000,
    expiresAt: 1_700_001_800_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test('formatFileLockError formats 423 and 409 FILE_LOCKED / WOPI_LOCK_ACTIVE with lock holder in Japanese', () => {
  const err423 = new ApiClientError(423, 'Locked', 'FILE_LOCKED', {
    code: 'FILE_LOCKED',
    lock: {
      ownerName: '山田太郎',
      ownerEmail: 'yamada@example.com',
      mode: 'desktop_exclusive',
    },
  });
  const msg423 = formatFileLockError(err423);
  assert.ok(msg423.includes('山田太郎'));
  assert.ok(msg423.includes('ロック中'));

  const errWopi = new ApiClientError(409, 'WOPI active', 'WOPI_LOCK_ACTIVE', {
    code: 'WOPI_LOCK_ACTIVE',
    lock: {
      ownerName: '佐藤花子',
      mode: 'wopi_collab',
    },
  });
  const msgWopi = formatFileLockError(errWopi);
  assert.ok(msgWopi.includes('佐藤花子'));
  assert.ok(msgWopi.includes('同時編集'));

  const errForbidden = new ApiClientError(
    403,
    'Forbidden',
    'LOCK_UNLOCK_FORBIDDEN',
    {
      code: 'LOCK_UNLOCK_FORBIDDEN',
      lock: { ownerName: '山田太郎' },
    }
  );
  const msgForbidden = formatFileLockError(errForbidden);
  assert.ok(msgForbidden.includes('山田太郎'));
  assert.ok(msgForbidden.includes('管理者のみ'));
});

test('canUserUnlockFileLock allows owner with edit, co-owner, and privileged admin', () => {
  const lock = makeLock({ ownerId: 'user-owner' });

  assert.equal(
    canUserUnlockFileLock({
      lock,
      currentUserId: 'user-owner',
      canEditContent: true,
    }),
    true
  );
  assert.equal(
    canUserUnlockFileLock({
      lock,
      currentUserId: 'user-other',
      canEditContent: true,
    }),
    false
  );
  assert.equal(
    canUserUnlockFileLock({
      lock,
      currentUserId: 'user-other',
      canEditContent: true,
      canManagePermissions: true,
    }),
    true
  );
  assert.equal(
    canUserUnlockFileLock({
      lock,
      currentUserId: 'user-admin',
      isPrivilegedAdmin: true,
    }),
    true
  );
  assert.equal(
    canUserUnlockFileLock({
      lock: null,
      currentUserId: 'user-owner',
      isPrivilegedAdmin: true,
    }),
    false
  );
});

test('buildContextMenuCapabilities sets canLock for single file with item.edit_content only', () => {
  const fileRow = { kind: 'file' as const, file: makeFile() };

  const editorCaps = buildContextMenuCapabilities({
    targets: [fileRow],
    primaryRow: fileRow,
    currentFolderId: 'folder-1',
    folderRole: 'editor',
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: false,
    clipboardHasFiles: false,
    resolveRowRole: () => 'editor',
  });
  assert.equal(editorCaps.canLock, true);

  const viewerCaps = buildContextMenuCapabilities({
    targets: [fileRow],
    primaryRow: fileRow,
    currentFolderId: 'folder-1',
    folderRole: 'viewer',
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: false,
    clipboardHasFiles: false,
    resolveRowRole: () => 'viewer',
  });
  assert.equal(viewerCaps.canLock, false);
});
