import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_CONTENT_CLASSIFICATION_OPTIONS,
  ADMIN_CONTENT_INSPECT_POLICY_META,
  ADMIN_CONTENT_INSPECT_POLICY_OPTIONS,
  ADMIN_CONTENT_PAGE_SIZE,
  DEFAULT_ADMIN_CONTENT_FILTERS,
  adminContentReasonError,
  buildAdminContentSearchQueryString,
  canInspectAdminContent,
  formatAdminContentOwner,
  isAdminContentReasonValid,
  mergeAdminContentSearchItems,
  readAdminContentInspectPolicy,
} from '@/lib/admin-content';
import type {
  AdminContentSearchItem,
  TenantPolicyRow,
} from '@/types/files';

function item(
  id: string,
  targetType: 'file' | 'folder' = 'file'
): AdminContentSearchItem {
  return {
    targetType,
    id,
    name: `${id}.txt`,
    folderId: null,
    parentId: null,
    pathLabel: 'マイファイル (ルート)',
    breadcrumbs: [],
    owner: { id: 'u1', email: 'u1@example.com', displayName: 'U1' },
    classification: 'internal',
    extension: 'txt',
    sizeBytes: 10,
    currentVersionNum: 1,
    activeSharedLinkCount: 0,
    activeLock: null,
    updatedAt: '2026-11-17T10:00:00.000Z',
  };
}

function policy(
  overrides: Partial<TenantPolicyRow> = {}
): TenantPolicyRow {
  return {
    tenant_id: 't1',
    enforce_company_only_links: 0,
    require_watermark_confidential: 1,
    max_link_expiration_days: 30,
    session_max_hours: 24,
    trash_retention_days: 30,
    ai_classification_mode: 'disabled',
    ai_auto_apply_threshold: null,
    updated_by: null,
    updated_at: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

test('admin content inspection policy defaults and camel/snake projections', () => {
  assert.equal(readAdminContentInspectPolicy(null), 'watermark_confidential');
  assert.equal(
    readAdminContentInspectPolicy(policy()),
    'watermark_confidential'
  );
  assert.equal(
    readAdminContentInspectPolicy(
      policy({ adminContentInspectPolicy: 'deny_confidential' })
    ),
    'deny_confidential'
  );
  assert.equal(
    readAdminContentInspectPolicy(
      policy({ admin_content_inspect_policy: 'disabled' })
    ),
    'disabled'
  );
  assert.equal(
    readAdminContentInspectPolicy(
      policy({
        adminContentInspectPolicy:
          'invalid' as unknown as TenantPolicyRow['adminContentInspectPolicy'],
      })
    ),
    'watermark_confidential'
  );

  assert.deepEqual(ADMIN_CONTENT_INSPECT_POLICY_OPTIONS, [
    'watermark_confidential',
    'deny_confidential',
    'disabled',
  ]);
  for (const option of ADMIN_CONTENT_INSPECT_POLICY_OPTIONS) {
    assert.ok(ADMIN_CONTENT_INSPECT_POLICY_META[option].label.length > 0);
    assert.ok(ADMIN_CONTENT_INSPECT_POLICY_META[option].description.length > 0);
  }
});

test('admin content reasons are trimmed and constrained to 3-300 characters', () => {
  assert.equal(isAdminContentReasonValid('   '), false);
  assert.equal(isAdminContentReasonValid('ab'), false);
  assert.equal(isAdminContentReasonValid('abc'), true);
  assert.equal(isAdminContentReasonValid('a'.repeat(300)), true);
  assert.equal(isAdminContentReasonValid('a'.repeat(301)), false);
  assert.match(adminContentReasonError('') ?? '', /理由を入力/);
  assert.match(adminContentReasonError('ab') ?? '', /3文字以上/);
  assert.match(adminContentReasonError('a'.repeat(301)) ?? '', /300文字以内/);
  assert.equal(adminContentReasonError('監査対応'), null);
});

test('admin content search query string carries every supported filter', () => {
  assert.equal(
    buildAdminContentSearchQueryString(DEFAULT_ADMIN_CONTENT_FILTERS),
    `targetType=all&limit=${ADMIN_CONTENT_PAGE_SIZE}`
  );

  const qs = buildAdminContentSearchQueryString(
    {
      targetType: 'file',
      query: '  roadmap  ',
      classification: 'confidential',
      createdBy: ' owner@example.com ',
      extension: ' .pdf ',
      lockedOnly: true,
      hasSharedLink: true,
    },
    'cursor-token',
    50
  );
  const params = new URLSearchParams(qs);
  assert.equal(params.get('targetType'), 'file');
  assert.equal(params.get('query'), 'roadmap');
  assert.equal(params.get('classification'), 'confidential');
  assert.equal(params.get('createdBy'), 'owner@example.com');
  assert.equal(params.get('extension'), '.pdf');
  assert.equal(params.get('lockedOnly'), '1');
  assert.equal(params.get('hasSharedLink'), '1');
  assert.equal(params.get('cursor'), 'cursor-token');
  assert.equal(params.get('limit'), '50');

  assert.equal(
    buildAdminContentSearchQueryString({
      ...DEFAULT_ADMIN_CONTENT_FILTERS,
      targetType: 'folder',
    }).includes('classification='),
    false
  );
});

test('admin content pages merge without duplicate file/folder ids', () => {
  const merged = mergeAdminContentSearchItems(
    [item('file-1'), item('folder-1', 'folder')],
    [
      item('file-1'),
      item('file-2'),
      item('folder-1', 'folder'),
      item('file-1', 'folder'),
    ]
  );
  assert.deepEqual(
    merged.map((entry) => `${entry.targetType}:${entry.id}`),
    ['file:file-1', 'folder:folder-1', 'file:file-2', 'folder:file-1']
  );
});

test('owner labels and policy gating are UI-safe', () => {
  assert.equal(
    formatAdminContentOwner({
      id: 'u1',
      email: 'owner@example.com',
      displayName: 'Content Owner',
    }),
    'Content Owner'
  );
  assert.equal(
    formatAdminContentOwner({
      id: 'u2',
      email: 'owner2@example.com',
      displayName: null,
    }),
    'owner2@example.com'
  );
  assert.equal(
    formatAdminContentOwner({ id: 'u3', email: null, displayName: null }),
    'u3'
  );

  assert.equal(canInspectAdminContent('watermark_confidential', 'confidential'), true);
  assert.equal(canInspectAdminContent('deny_confidential', 'confidential'), false);
  assert.equal(canInspectAdminContent('deny_confidential', 'internal'), true);
  assert.equal(canInspectAdminContent('disabled', 'public'), false);
  assert.deepEqual(
    ADMIN_CONTENT_CLASSIFICATION_OPTIONS.map((option) => option.value),
    ['all', 'unset', 'internal', 'confidential', 'public']
  );
});
