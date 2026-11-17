import { randomUUID } from 'node:crypto';
import { DEV_USERS, expect, test, type RoleSession } from './fixtures';
import {
  createFolder,
  createScimUser,
  grantPermission,
  suspendScimUser,
  uploadFile,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

interface AdminRootLike {
  id: string;
  name: string;
  deletedAt: string | null;
  owners: Array<{ granteeId: string; role?: string }>;
  coOwners: Array<{ granteeId: string; role?: string }>;
}

interface PermissionAuditLike {
  entries: Array<{
    targetId: string;
    targetName: string;
    granteeId: string;
    granteeName: string;
    role: string;
    source: 'direct' | 'inherited';
    inheritedFromName: string | null;
  }>;
  totalCount: number;
  rootSummaries: Array<{
    id: string;
    name: string;
    ownerMissing: boolean;
    hasSuspendedOwner: boolean;
  }>;
}

function token(): string {
  return randomUUID().replaceAll('-', '').slice(0, 8);
}

async function createAdminRoot(
  session: RoleSession,
  name: string,
  ownerUserId: string,
  coOwnerGroupIds: string[] = []
): Promise<AdminRootLike> {
  const response = await session.api.post('/api/admin/root-folders', {
    data: {
      name,
      classification: 'internal',
      ownerUserId,
      coOwnerGroupIds,
    },
  });
  expect(response.status(), `POST /api/admin/root-folders ${name}`).toBe(201);
  const body = (await response.json()) as { root: AdminRootLike };
  return body.root;
}

async function archiveRoot(
  session: RoleSession,
  folderId: string
): Promise<void> {
  const response = await session.api.post(
    `/api/admin/root-folders/${encodeURIComponent(folderId)}/archive`
  );
  expect(response.status(), 'archive root').toBe(200);
}

async function handoffRootToSysAdmin(
  session: RoleSession,
  folderId: string | null
): Promise<void> {
  if (!folderId) return;
  await session.api
    .post(`/api/admin/root-folders/${encodeURIComponent(folderId)}/restore`)
    .catch(() => undefined);
  await session.api
    .post(
      `/api/admin/root-folders/${encodeURIComponent(folderId)}/transfer-owner`,
      { data: { newOwnerUserId: DEV_USERS.sys_admin.id } }
    )
    .catch(() => undefined);
}

async function fetchPermissionAudit(
  session: RoleSession,
  search: Record<string, string>
): Promise<PermissionAuditLike> {
  const qs = new URLSearchParams(search);
  const response = await session.api.get(
    `/api/admin/permissions?${qs.toString()}`
  );
  expect(response.status(), 'GET /api/admin/permissions').toBe(200);
  return (await response.json()) as PermissionAuditLike;
}

async function selectPrincipal(
  page: RoleSession['page'],
  dialogName: string,
  inputLabel: string,
  listboxName: string,
  query: string,
  optionText: string
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  const input = dialog.getByLabel(inputLabel, { exact: true });
  await input.fill(query);
  const listbox = dialog.getByRole('listbox', { name: listboxName });
  await listbox
    .getByRole('option')
    .filter({ hasText: optionText })
    .first()
    .click();
}

async function selectRoot(page: RoleSession['page'], name: string): Promise<void> {
  await page.getByLabel(`${name} を選択`, { exact: true }).check();
}

test.describe('アクセス権監査・一括付与・オーナー移管 (TOM-57)', () => {
  test('sys_admin が所有者警告・直接/継承フィルタ・ソート・ページング・CSV/JSON ダウンロードを検証する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const suffix = token();
    const rootName = uniqueName(`T57 Audit Root ${suffix}`);
    const suspendedRootName = uniqueName(`T57 Suspended Root ${suffix}`);
    const childName = uniqueName(`T57 Child ${suffix}`);
    const fileName = `T57 confidential ${suffix}.txt`;
    let rootId: string | null = null;
    let suspendedRootId: string | null = null;

    try {
      rootId = (
        await createAdminRoot(admin, rootName, DEV_USERS.member.id, [
          'group-e2e-collaborators',
        ])
      ).id;
      cleanup.registerFolder(rootId);
      const suspendedOwner = await createScimUser(admin, {
        email: `t57-owner-${suffix}@example.com`,
        displayName: `T57 Suspended Owner ${suffix}`,
      });
      suspendedRootId = (
        await createAdminRoot(admin, suspendedRootName, suspendedOwner.id)
      ).id;
      cleanup.registerFolder(suspendedRootId);
      await suspendScimUser(admin, suspendedOwner.id);

      const child = await createFolder(member, {
        parentId: rootId,
        name: childName,
        classification: 'internal',
      });
      await grantPermission(member, {
        targetType: 'folder',
        targetId: child.id,
        granteeType: 'user',
        granteeId: DEV_USERS.sec_admin.id,
        role: 'editor',
      });
      const file = await uploadFile(member, {
        folderId: child.id,
        name: fileName,
        content: `TOM-57 DLP metadata only ${suffix}\n`,
      });
      const classification = await member.api.patch(
        `/api/files/${encodeURIComponent(file.id)}/classification`,
        { data: { classification: 'confidential' } }
      );
      expect(classification.status(), 'PATCH file classification').toBe(200);

      await admin.page.goto('/admin');
      await admin.page.getByTestId('admin-tab-reports').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-reports')
      ).toBeVisible();
      const section = admin.page.locator('#admin-permission-audit');
      await expect(section).toBeVisible();
      await expect(
        section.getByRole('heading', { name: 'アクセス権監査' })
      ).toBeVisible();

      const suspendedRow = section
        .getByTestId('admin-permission-root-row')
        .filter({ hasText: suspendedRootName });
      await expect(suspendedRow).toBeVisible();
      await expect(suspendedRow.getByText('所有者不在')).toBeVisible();
      await expect(suspendedRow.getByText('停止済みオーナー')).toBeVisible();

      const rootsTab = section.getByRole('tab', {
        name: 'ルートフォルダ健全性・一括操作',
      });
      const permissionsTab = section.getByRole('tab', {
        name: 'テナント権限一覧',
      });
      await expect(rootsTab).toHaveAttribute('aria-selected', 'true');
      await rootsTab.focus();
      await rootsTab.press('ArrowRight');
      await expect(permissionsTab).toHaveAttribute('aria-selected', 'true');
      await expect(permissionsTab).toBeFocused();

      const panel = section.getByRole('tabpanel', {
        name: 'テナント権限一覧',
      });
      await expect(panel).toBeVisible();

      await panel.getByLabel('権限監査の対象種別').selectOption('file');
      await panel.getByLabel('権限監査のルートフォルダ').selectOption(rootId);
      await panel.getByLabel('権限監査の直接継承').selectOption('inherited');
      await panel.getByRole('button', { name: 'フィルタを適用' }).click();

      const entryRow = panel
        .getByTestId('admin-permission-entry-row')
        .filter({ hasText: fileName });
      await expect(entryRow.first()).toBeVisible();
      await expect(entryRow.first()).toContainText('メタデータのみ (DLP)');
      await expect(entryRow.first()).toContainText('継承元:');
      await expect(
        panel.locator('[role="status"].sr-only').filter({ hasText: '件中' })
      ).toBeVisible();

      const tableRegion = panel.getByRole('region', {
        name: /テナント権限一覧/,
      });
      const targetSort = tableRegion.getByRole('button', {
        name: '対象',
        exact: true,
      });
      await targetSort.click();
      const sortedHeader = tableRegion.locator('th[aria-sort]');
      await expect(sortedHeader).toHaveAttribute('aria-sort', 'ascending');
      await expect(sortedHeader).toContainText('対象');
      await targetSort.click();
      await expect(sortedHeader).toHaveAttribute('aria-sort', 'descending');

      await expect(panel.getByRole('button', { name: '前へ' })).toBeDisabled();
      await expect(panel.getByRole('button', { name: '次へ' })).toBeDisabled();
      await expect(
        panel.getByText(/件中 \d+ 件を表示/)
      ).toBeVisible();

      const csvDownload = admin.page.waitForEvent('download');
      await panel.getByRole('link', { name: 'CSV', exact: true }).click();
      expect((await csvDownload).suggestedFilename()).toBe(
        'admin-permissions.csv'
      );

      const jsonDownload = admin.page.waitForEvent('download');
      await panel.getByRole('link', { name: 'JSON', exact: true }).click();
      expect((await jsonDownload).suggestedFilename()).toBe(
        'admin-permissions.json'
      );

      const apiAudit = await fetchPermissionAudit(admin, {
        targetType: 'file',
        rootFolderId: rootId,
        source: 'inherited',
        limit: '200',
      });
      expect(apiAudit.entries.length).toBeGreaterThan(0);
      expect(
        apiAudit.entries.every(
          (entry) =>
            entry.source === 'inherited' &&
            entry.targetId === file.id &&
            entry.targetName === fileName
        )
      ).toBe(true);
      expect(JSON.stringify(apiAudit)).not.toContain('TOM-57 DLP metadata only');
    } finally {
      await handoffRootToSysAdmin(admin, suspendedRootId);
      await handoffRootToSysAdmin(admin, rootId);
    }
  });

  test('sys_admin が複数ルートを選択して共同所有者付与・所有者移管をプレビュー実行し監査ログへ反映する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const suffix = token();
    const rootAName = uniqueName(`T57 Bulk A ${suffix}`);
    const rootBName = uniqueName(`T57 Bulk B ${suffix}`);
    const archivedName = uniqueName(`T57 Bulk Archived ${suffix}`);
    let rootAId: string | null = null;
    let rootBId: string | null = null;
    let archivedId: string | null = null;

    try {
      rootAId = (
        await createAdminRoot(admin, rootAName, DEV_USERS.member.id)
      ).id;
      cleanup.registerFolder(rootAId);
      rootBId = (
        await createAdminRoot(admin, rootBName, DEV_USERS.member.id)
      ).id;
      cleanup.registerFolder(rootBId);
      archivedId = (
        await createAdminRoot(admin, archivedName, DEV_USERS.member.id)
      ).id;
      cleanup.registerFolder(archivedId);
      await archiveRoot(admin, archivedId);

      await admin.page.goto('/admin');
      await admin.page.getByTestId('admin-tab-reports').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-reports')
      ).toBeVisible();
      const section = admin.page.locator('#admin-permission-audit');
      const rootsPanel = section.getByRole('tabpanel', {
        name: 'ルートフォルダ健全性・一括操作',
      });
      await expect(rootsPanel).toBeVisible();
      await expect(
        rootsPanel
          .getByTestId('admin-permission-root-row')
          .filter({ hasText: rootAName })
      ).toBeVisible();

      await selectRoot(admin.page, rootAName);
      await selectRoot(admin.page, archivedName);
      await section
        .getByRole('button', { name: 'グループ共同所有者一括付与' })
        .click();

      const coOwnerDialog = admin.page.getByRole('dialog', {
        name: 'グループ共同所有者一括付与',
      });
      await expect(coOwnerDialog).toBeVisible();
      await expect(coOwnerDialog.locator('[role="dialog"]')).toHaveCount(0);
      await selectPrincipal(
        admin.page,
        'グループ共同所有者一括付与',
        'SCIM グループ',
        'SCIM グループの検索候補',
        'E2E Collaborators',
        'E2E Collaborators'
      );
      await coOwnerDialog
        .getByRole('button', { name: '影響をプレビュー' })
        .click();
      await expect(
        coOwnerDialog.getByTestId('admin-bulk-result-row')
      ).toHaveCount(2);
      await expect(coOwnerDialog.getByText(/成功 1 件/)).toBeVisible();
      await expect(coOwnerDialog.getByText(/スキップ 1 件/)).toBeVisible();
      await coOwnerDialog
        .getByRole('button', { name: '実行する', exact: true })
        .click();
      await expect(
        coOwnerDialog.getByTestId('admin-bulk-result-row')
      ).toHaveCount(2);
      await coOwnerDialog
        .getByRole('button', { name: '閉じる' })
        .last()
        .click();
      await expect(coOwnerDialog).toHaveCount(0);

      const rootAAfterGrant = await fetchPermissionAudit(admin, {
        targetId: rootAId,
        grantee: 'E2E Collaborators',
        limit: '200',
      });
      expect(
        rootAAfterGrant.entries.some(
          (entry) =>
            entry.granteeName === 'E2E Collaborators' &&
            entry.role === 'co_owner' &&
            entry.source === 'direct'
        )
      ).toBe(true);

      await expect(
        rootsPanel
          .getByTestId('admin-permission-root-row')
          .filter({ hasText: rootAName })
      ).toBeVisible();
      await selectRoot(admin.page, rootAName);
      await selectRoot(admin.page, rootBName);
      await selectRoot(admin.page, archivedName);
      await section
        .getByRole('button', { name: '所有者一括移管' })
        .click();

      const transferDialog = admin.page.getByRole('dialog', {
        name: '所有者一括移管',
      });
      await expect(transferDialog).toBeVisible();
      await selectPrincipal(
        admin.page,
        '所有者一括移管',
        '新しい所有者',
        '新しい所有者の検索候補',
        DEV_USERS.sec_admin.email,
        DEV_USERS.sec_admin.email
      );
      await transferDialog
        .getByRole('combobox', { name: '以前の所有者の扱い' })
        .selectOption('co_owner');
      await transferDialog
        .getByRole('button', { name: '影響をプレビュー' })
        .click();
      await expect(
        transferDialog.getByTestId('admin-bulk-result-row')
      ).toHaveCount(3);
      await expect(transferDialog.getByText(/成功 2 件/)).toBeVisible();
      await expect(transferDialog.getByText(/失敗 1 件/)).toBeVisible();
      await transferDialog
        .getByRole('button', { name: '実行する', exact: true })
        .click();
      await expect(
        transferDialog.getByTestId('admin-bulk-result-row')
      ).toHaveCount(3);
      await transferDialog
        .getByRole('button', { name: '閉じる' })
        .last()
        .click();
      await expect(transferDialog).toHaveCount(0);

      const rootAAfterTransfer = await fetchPermissionAudit(admin, {
        targetId: rootAId,
        role: 'owner,co_owner',
        limit: '200',
      });
      expect(
        rootAAfterTransfer.entries.some(
          (entry) =>
            entry.granteeId === DEV_USERS.sec_admin.id &&
            entry.role === 'owner' &&
            entry.source === 'direct'
        )
      ).toBe(true);
      expect(
        rootAAfterTransfer.entries.some(
          (entry) =>
            entry.granteeId === DEV_USERS.member.id &&
            entry.role === 'co_owner' &&
            entry.source === 'direct'
        )
      ).toBe(true);

      await section
        .getByRole('button', { name: '権限監査ログを表示' })
        .click();
      const auditSection = admin.page.locator('#admin-audit-logs');
      await expect(
        auditSection.getByText('権限監査のみ', { exact: true })
      ).toBeVisible();
      await expect(
        auditSection.getByText('admin.permission.bulk_grant').first()
      ).toBeVisible();
      await expect(
        auditSection.getByText('admin.root_folder.bulk_transfer').first()
      ).toBeVisible();
      await expect(auditSection.getByText('権限の一括付与').first()).toBeVisible();
      await expect(auditSection.getByText('所有者の一括移管').first()).toBeVisible();
    } finally {
      await handoffRootToSysAdmin(admin, archivedId);
      await handoffRootToSysAdmin(admin, rootAId);
      await handoffRootToSysAdmin(admin, rootBId);
    }
  });

  test('sec_admin は権限監査を閲覧できるが一括操作は無効化され API も 403 になる', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const secAdmin = await as('sec_admin');
    const suffix = token();
    const rootName = uniqueName(`T57 Read Only ${suffix}`);
    let rootId: string | null = null;

    try {
      rootId = (
        await createAdminRoot(admin, rootName, DEV_USERS.member.id, [
          'group-e2e-collaborators',
        ])
      ).id;
      cleanup.registerFolder(rootId);

      await secAdmin.page.goto('/admin');
      await secAdmin.page.getByTestId('admin-tab-reports').click();
      await expect(
        secAdmin.page.getByTestId('admin-tabpanel-reports')
      ).toBeVisible();
      const section = secAdmin.page.locator('#admin-permission-audit');
      await expect(section).toBeVisible();
      await expect(
        section.getByText(/sec_admin は閲覧・監査専用です/)
      ).toBeVisible();
      const row = section
        .getByTestId('admin-permission-root-row')
        .filter({ hasText: rootName });
      await expect(row).toBeVisible();

      for (const buttonName of [
        'グループ共同所有者一括付与',
        '所有者一括移管',
        '一括アーカイブ',
        '一括復元',
      ]) {
        await expect(
          section.getByRole('button', { name: buttonName })
        ).toBeDisabled();
      }

      await section
        .getByRole('tab', { name: 'テナント権限一覧' })
        .click();
      const panel = section.getByRole('tabpanel', {
        name: 'テナント権限一覧',
      });
      await expect(
        panel.getByTestId('admin-permission-entry-row').first()
      ).toBeVisible();

      const apiDenied = await secAdmin.api.post(
        '/api/admin/permissions/bulk-co-owner',
        {
          data: {
            folderIds: [rootId],
            groupIds: ['group-e2e-collaborators'],
            dryRun: true,
          },
        }
      );
      expect(apiDenied.status()).toBe(403);
      expect((await apiDenied.json()).code).toBe('SYS_ADMIN_REQUIRED');
    } finally {
      await handoffRootToSysAdmin(admin, rootId);
    }
  });
});
