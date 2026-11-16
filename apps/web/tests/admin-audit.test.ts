import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatAuditActionLabel,
  isRootFolderAuditAction,
  ROOT_FOLDER_AUDIT_ACTIONS,
} from '@/lib/admin-audit';

test('root folder admin audit actions have Japanese labels and preset membership', () => {
  const expected: Record<string, string> = {
    'admin.root_folder.create': 'ルートフォルダ作成',
    'admin.root_folder.owner_transfer': '所有者移管',
    'admin.root_folder.co_owner_grant': '共同所有者付与',
    'admin.root_folder.archive': 'ルートフォルダのアーカイブ',
    'admin.root_folder.restore': 'ルートフォルダの復元',
  };

  for (const [action, label] of Object.entries(expected)) {
    assert.equal(formatAuditActionLabel(action), label);
    assert.equal(isRootFolderAuditAction(action), true);
    assert.equal(
      (ROOT_FOLDER_AUDIT_ACTIONS as readonly string[]).includes(action),
      true
    );
  }

  assert.equal(isRootFolderAuditAction('folder.create'), false);
  assert.equal(formatAuditActionLabel('unknown.action'), 'unknown.action');
});
