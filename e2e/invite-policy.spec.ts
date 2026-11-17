import type { Page } from '@playwright/test';
import { expect, test, DEV_USERS } from './fixtures';
import {
  createFolder,
  grantPermission,
  listPermissions,
  updateTenantInvitePolicy,
  type ApiActor,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

async function createIsolatedRoot(
  admin: ApiActor,
  cleanup: { registerFolder: (folderId: string) => void },
  prefix: string
): Promise<{ id: string; name: string }> {
  const root = await createFolder(admin, {
    parentId: null,
    name: uniqueName(prefix),
    classification: 'internal',
  });
  cleanup.registerFolder(root.id);
  return { id: root.id, name: root.name };
}

async function openFolderPermissionsModal(
  page: Page,
  folderName: string
): Promise<ReturnType<Page['getByRole']>> {
  await page.getByTestId('workspace-permissions-button').first().click();
  const dialog = page.getByRole('dialog', {
    name: `アクセス権限: ${folderName}`,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('招待ポリシー / フォルダ単位の招待制限 (TOM-58)', () => {
  test('Flow A: sys_admin が /admin でテナント招待ポリシーを editors に変更し永続化する', async ({
    as,
  }) => {
    const admin = await as('sys_admin');
    try {
      await updateTenantInvitePolicy(admin, 'owners');
      await admin.page.goto('/admin');
      await expect(
        admin.page.getByRole('heading', {
          name: 'ガバナンス & セキュリティ統合ダッシュボード',
        })
      ).toBeVisible();
      await admin.page.getByTestId('admin-tab-settings').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-settings')
      ).toBeVisible();

      const section = admin.page.getByTestId('tenant-invite-policy-section');
      await expect(section).toBeVisible();
      await expect(
        section.getByRole('heading', { name: 'テナント招待ポリシー' })
      ).toBeVisible();
      await expect(
        section.getByRole('radio', { name: /所有者\/共同所有者のみ/ })
      ).toBeChecked();

      await section.getByRole('radio', { name: /編集者以上/ }).check();
      await section
        .getByRole('button', { name: '招待ポリシーを保存', exact: true })
        .click();
      await expect(
        admin.page.getByTestId('tenant-invite-policy-notice')
      ).toContainText('編集者以上');

      await admin.page.reload();
      const reloaded = admin.page.getByTestId('tenant-invite-policy-section');
      await expect(
        reloaded.getByRole('radio', { name: /編集者以上/ })
      ).toBeChecked();
      await expect(
        reloaded.getByRole('radio', { name: /所有者\/共同所有者のみ/ })
      ).not.toBeChecked();
    } finally {
      await updateTenantInvitePolicy(admin, 'owners');
    }
  });

  test('Flow B: editors ポリシーで editor が招待バナーを確認し viewer を招待できる', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    try {
      await updateTenantInvitePolicy(admin, 'editors');
      const root = await createIsolatedRoot(admin, cleanup, 'e2e-invite-editor');
      await grantPermission(admin, {
        targetType: 'folder',
        targetId: root.id,
        granteeType: 'user',
        granteeId: DEV_USERS.member.id,
        role: 'editor',
      });

      await member.page.goto(`/workspace?folderId=${encodeURIComponent(root.id)}`);
      const inviteButton = member.page
        .getByTestId('workspace-permissions-button')
        .first();
      await expect(inviteButton).toBeVisible();
      await expect(inviteButton).toContainText('メンバー招待');
      await expect(
        member.page.getByRole('button', { name: '権限管理', exact: true })
      ).toHaveCount(0);

      const dialog = await openFolderPermissionsModal(member.page, root.name);
      await expect(dialog.getByTestId('invite-policy-banner')).toBeVisible();
      await expect(dialog.getByTestId('invite-policy-effective')).toContainText(
        '編集者以上'
      );
      await expect(dialog.getByTestId('invite-policy-source')).toContainText(
        'テナント既定'
      );
      await expect(dialog.getByTestId('invite-policy-audience')).toContainText(
        '所有者・共同所有者・編集者'
      );

      await expect(dialog.locator('#permission-role option[value="owner"]')).toHaveCount(
        0
      );
      await expect(
        dialog.locator('#permission-role option[value="co_owner"]')
      ).toHaveCount(0);

      await dialog
        .locator('#permission-principal-search')
        .fill(DEV_USERS.sec_admin.email);
      const listbox = dialog.getByRole('listbox', { name: '検索候補' });
      await expect(listbox).toBeVisible();
      await listbox
        .getByRole('option')
        .filter({ hasText: DEV_USERS.sec_admin.displayName })
        .first()
        .click();
      await dialog.locator('#permission-role').selectOption('viewer');
      await dialog.getByRole('button', { name: '付与', exact: true }).click();

      const invitedRow = dialog
        .getByTestId('permission-row-direct')
        .filter({ hasText: DEV_USERS.sec_admin.displayName })
        .first();
      await expect(invitedRow).toBeVisible();
      await expect(invitedRow).toContainText('Viewer');

      const ownerRow = dialog
        .getByTestId('permission-row-direct')
        .filter({ hasText: DEV_USERS.sys_admin.displayName })
        .first();
      await expect(ownerRow).toBeVisible();
      await expect(
        ownerRow.getByRole('button', {
          name: `${DEV_USERS.sys_admin.displayName} の権限を削除`,
        })
      ).toHaveCount(0);

      const list = await listPermissions(member, {
        targetType: 'folder',
        targetId: root.id,
      });
      expect(list.canInvite).toBe(true);
      expect(list.capabilities).toContain('permission.invite');
      expect(list.grantableRoles).not.toContain('owner');
      expect(list.grantableRoles).not.toContain('co_owner');
    } finally {
      await updateTenantInvitePolicy(admin, 'owners');
    }
  });

  test('Flow C: フォルダ上書き admins が子への緩和と非 sys_admin の招待をブロックする', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    const secAdmin = await as('sec_admin');
    try {
      await updateTenantInvitePolicy(admin, 'editors');
      const root = await createIsolatedRoot(admin, cleanup, 'e2e-invite-override');
      await grantPermission(admin, {
        targetType: 'folder',
        targetId: root.id,
        granteeType: 'user',
        granteeId: DEV_USERS.member.id,
        role: 'co_owner',
      });
      await grantPermission(admin, {
        targetType: 'folder',
        targetId: root.id,
        granteeType: 'user',
        granteeId: DEV_USERS.sec_admin.id,
        role: 'editor',
      });

      await member.page.goto(`/workspace?folderId=${encodeURIComponent(root.id)}`);
      const rootDialog = await openFolderPermissionsModal(member.page, root.name);
      const overrideSection = rootDialog.getByTestId(
        'folder-invite-policy-section'
      );
      await expect(overrideSection).toBeVisible();
      await expect(
        overrideSection.getByText('フォルダ招待ポリシー（上書き設定）')
      ).toBeVisible();

      await rootDialog
        .getByTestId('folder-invite-policy-option-admins')
        .locator('input')
        .check();
      await rootDialog
        .getByRole('button', { name: '上書き設定を保存', exact: true })
        .click();

      await expect(rootDialog.getByTestId('invite-policy-effective')).toContainText(
        '管理者のみ'
      );
      await expect(
        rootDialog.getByTestId('folder-invite-policy-notice')
      ).toBeVisible();
      await expect(
        rootDialog.locator('#permission-principal-search')
      ).toHaveCount(0);
      await expect(
        rootDialog.getByTestId('invite-policy-notice')
      ).toContainText('管理者のみ');

      const rootPermissions = await listPermissions(member, {
        targetType: 'folder',
        targetId: root.id,
      });
      expect(rootPermissions.invitePolicy?.effectivePolicy).toBe('admins');
      expect(rootPermissions.canInvite).toBe(false);

      const blockedInvite = await member.api.post('/api/permissions', {
        data: {
          targetType: 'folder',
          targetId: root.id,
          granteeType: 'group',
          granteeId: 'group-e2e-collaborators',
          role: 'viewer',
        },
      });
      expect(blockedInvite.status()).toBe(403);
      const blockedBody = (await blockedInvite.json()) as {
        code?: string;
        effectiveInvitePolicy?: string;
      };
      expect(blockedBody.code).toBe('INVITE_POLICY_RESTRICTED');
      expect(blockedBody.effectiveInvitePolicy).toBe('admins');

      const child = await createFolder(admin, {
        parentId: root.id,
        name: uniqueName('e2e-invite-child'),
        classification: 'internal',
      });

      await member.page.goto(
        `/workspace?folderId=${encodeURIComponent(child.id)}`
      );
      const childDialog = await openFolderPermissionsModal(
        member.page,
        child.name
      );
      const childOverride = childDialog.getByTestId(
        'folder-invite-policy-section'
      );
      await expect(childOverride).toBeVisible();
      await expect(
        childOverride.getByTestId('folder-invite-policy-option-editors')
          .locator('input')
      ).toBeDisabled();
      await expect(
        childOverride.getByTestId('folder-invite-policy-option-owners')
          .locator('input')
      ).toBeDisabled();
      await expect(childOverride).toContainText(
        '上位の「管理者のみ」より緩めることはできません'
      );

      // The folder-level editor immediately loses the dynamic invite capability.
      await secAdmin.page.goto(
        `/workspace?folderId=${encodeURIComponent(child.id)}`
      );
      await expect(
        secAdmin.page.getByTestId('workspace-permissions-button')
      ).toHaveCount(0);
      const editorPermissions = await listPermissions(secAdmin, {
        targetType: 'folder',
        targetId: child.id,
      });
      expect(editorPermissions.effectiveRole).toBe('editor');
      expect(editorPermissions.canInvite).toBe(false);
      expect(editorPermissions.capabilities).not.toContain('permission.invite');
      expect(editorPermissions.invitePolicy?.effectivePolicy).toBe('admins');

      // A sys_admin who holds folder access can still invite under admins.
      const adminPermissions = await listPermissions(admin, {
        targetType: 'folder',
        targetId: child.id,
      });
      expect(adminPermissions.canInvite).toBe(true);
      expect(adminPermissions.capabilities).toContain('permission.invite');
    } finally {
      await updateTenantInvitePolicy(admin, 'owners');
    }
  });
});
