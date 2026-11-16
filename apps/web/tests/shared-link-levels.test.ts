import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHARE_PERMISSION_LEVEL_OPTIONS,
  availablePermissionLevels,
  buildComposedAccessNotice,
  defaultSharePermissionLevel,
  permissionLevelCanDownload,
  permissionLevelLabel,
  permissionLevelLandingLabel,
  validateShareLinkForm,
} from '@/lib/share-link-levels';
import {
  clearSingleUsePreviewBufferCache,
  fetchSingleUsePreviewBuffer,
  singleUsePreviewBufferCacheSize,
} from '@/lib/single-use-preview-cache';
import { formatAuditActionLabel } from '@/lib/admin-audit';
import type { PublicShareMeta } from '@/types/files';

function form(
  overrides: Partial<Parameters<typeof validateShareLinkForm>[0]> = {}
): Parameters<typeof validateShareLinkForm>[0] {
  return {
    permissionLevel: 'download',
    accessScope: 'company_only',
    canManageLinks: true,
    allowSharedLinkEdit: true,
    allowPublicEditLinks: true,
    password: '',
    expiresInDays: 30,
    ...overrides,
  };
}

test('permission level vocabulary exposes view/download/edit with Japanese labels', () => {
  assert.deepEqual(
    SHARE_PERMISSION_LEVEL_OPTIONS.map((option) => option.value),
    ['view', 'download', 'edit']
  );
  assert.equal(permissionLevelLabel('view'), '表示のみ');
  assert.equal(permissionLevelLabel('download'), 'DL可');
  assert.equal(permissionLevelLabel('edit'), '編集可');
  assert.equal(permissionLevelLandingLabel('view'), '表示のみ');
  assert.equal(permissionLevelLandingLabel('download'), '表示 + DL');
  assert.equal(permissionLevelLandingLabel('edit'), '表示 + DL + 編集');
  assert.equal(permissionLevelCanDownload('view'), false);
  assert.equal(permissionLevelCanDownload('download'), true);
  assert.equal(permissionLevelCanDownload('edit'), true);
});

test('default and available permission levels honour role + policy gates', () => {
  assert.equal(
    defaultSharePermissionLevel({ canManageLinks: false, classification: 'internal' }),
    'view'
  );
  assert.equal(
    defaultSharePermissionLevel({ canManageLinks: true, classification: 'confidential' }),
    'view'
  );
  assert.equal(
    defaultSharePermissionLevel({ canManageLinks: true, classification: 'internal' }),
    'download'
  );
  assert.deepEqual(
    availablePermissionLevels({ canManageLinks: false, allowSharedLinkEdit: true }),
    ['view']
  );
  assert.deepEqual(
    availablePermissionLevels({ canManageLinks: true, allowSharedLinkEdit: false }),
    ['view', 'download']
  );
  assert.deepEqual(
    availablePermissionLevels({ canManageLinks: true, allowSharedLinkEdit: true }),
    ['view', 'download', 'edit']
  );
});

test('client validation mirrors edit + public-edit server guardrails', () => {
  assert.equal(validateShareLinkForm(form()), null);
  assert.match(
    validateShareLinkForm(
      form({ permissionLevel: 'download', canManageLinks: false })
    ) ?? '',
    /表示専用/
  );
  assert.match(
    validateShareLinkForm(form({ permissionLevel: 'edit', allowSharedLinkEdit: false })) ??
      '',
    /編集共有リンク/
  );
  assert.match(
    validateShareLinkForm(
      form({
        permissionLevel: 'edit',
        accessScope: 'public',
        allowPublicEditLinks: false,
        password: 'secret',
      })
    ) ?? '',
    /Public \(匿名\) 編集リンク/
  );
  assert.match(
    validateShareLinkForm(
      form({ permissionLevel: 'edit', accessScope: 'public', password: '   ' })
    ) ?? '',
    /パスワード/
  );
  assert.match(
    validateShareLinkForm(
      form({
        permissionLevel: 'edit',
        accessScope: 'public',
        password: 'secret',
        expiresInDays: 0,
      })
    ) ?? '',
    /有効期限/
  );
  assert.equal(
    validateShareLinkForm(
      form({
        permissionLevel: 'edit',
        accessScope: 'public',
        password: 'secret',
        expiresInDays: 7,
      })
    ),
    null
  );
});

test('SharedLinkLanding notices explain composed edit access and anon auth warnings', () => {
  const base: Pick<
    PublicShareMeta,
    | 'permissionLevel'
    | 'canEdit'
    | 'requiresAuthForEdit'
    | 'composedRole'
    | 'composedCapabilities'
  > = {
    permissionLevel: 'edit',
    canEdit: true,
    requiresAuthForEdit: false,
    composedRole: 'viewer_uploader',
    composedCapabilities: [
      'item.upload_new',
      'item.upload_version',
      'item.edit_content',
    ],
  };
  const notice = buildComposedAccessNotice(base);
  assert.match(notice ?? '', /viewer_uploader/);
  assert.match(notice ?? '', /新規アップロード/);
  assert.match(notice ?? '', /上書き保存/);
  assert.match(notice ?? '', /WOPI編集/);
  assert.match(notice ?? '', /削除・権限・共有管理は不可/);

  assert.equal(
    buildComposedAccessNotice({
      ...base,
      canEdit: false,
      requiresAuthForEdit: true,
    }),
    '匿名アクセスでは編集できません — サインインしてください'
  );
  assert.equal(buildComposedAccessNotice({ ...base, permissionLevel: 'view' }), null);
});

test('single-use preview fetch cache dedupes StrictMode double effects', async () => {
  clearSingleUsePreviewBufferCache();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await Promise.resolve();
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    });
  }) as typeof fetch;

  try {
    const [a, b] = await Promise.all([
      fetchSingleUsePreviewBuffer('/api/storage/preview-stream?token=one'),
      fetchSingleUsePreviewBuffer('/api/storage/preview-stream?token=one'),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.byteLength, 3);
    assert.equal(b.byteLength, 3);

    const c = await fetchSingleUsePreviewBuffer(
      '/api/storage/preview-stream?token=one'
    );
    assert.equal(calls, 1);
    assert.equal(c.byteLength, 3);

    await fetchSingleUsePreviewBuffer('/api/storage/preview-stream?token=two');
    assert.equal(calls, 2);
    assert.equal(singleUsePreviewBufferCacheSize(), 2);

    // Failed fetches are not cached permanently.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 'PREVIEW_TOKEN_CONSUMED' }), {
        status: 410,
      })) as typeof fetch;
    await assert.rejects(
      fetchSingleUsePreviewBuffer('/api/storage/preview-stream?token=used'),
      /HTTP 410/
    );
    assert.equal(singleUsePreviewBufferCacheSize(), 2);
  } finally {
    globalThis.fetch = originalFetch;
    clearSingleUsePreviewBufferCache();
  }
});

test('new audit actions have Japanese labels', () => {
  assert.equal(formatAuditActionLabel('shared_link.update'), '共有リンク権限変更');
  assert.equal(
    formatAuditActionLabel('shared_link.file_upload'),
    '共有リンク経由のファイルアップロード'
  );
  assert.equal(
    formatAuditActionLabel('shared_link.version_upload'),
    '共有リンク経由の新バージョンアップロード'
  );
});
