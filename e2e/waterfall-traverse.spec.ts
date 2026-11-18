import { randomUUID } from 'node:crypto';
import { expect, test, DEV_USERS, type RoleSession } from './fixtures';
import {
  createFolder,
  grantPermission,
  softDeleteFile,
  uploadFile,
  type FolderLike,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

function token(): string {
  return `t54${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function setInheritanceMode(
  session: RoleSession,
  mode: 'additive' | 'waterfall'
): Promise<void> {
  const res = await session.api.patch('/api/admin/policies', {
    data: { permissionInheritanceMode: mode },
  });
  expect(res.status(), `PATCH permissionInheritanceMode=${mode}`).toBe(200);
}

async function buildTreeFromRoot(
  session: RoleSession,
  root: FolderLike,
  base: string
) {
  const dept = await createFolder(session, {
    parentId: root.id,
    name: `${base} Dept`,
  });
  const deep = await createFolder(session, {
    parentId: dept.id,
    name: `${base} Deep`,
  });
  return { dept, deep };
}

function folderRow(session: RoleSession, name: string) {
  return session.page
    .getByRole('main')
    .locator('[data-workspace-row-trigger="true"]')
    .filter({ hasText: name })
    .first();
}

async function openFolder(session: RoleSession, folder: FolderLike): Promise<void> {
  await folderRow(session, folder.name).dblclick();
  await expect
    .poll(() => new URL(session.page.url()).searchParams.get('folderId'))
    .toBe(folder.id);
}

async function breadcrumbTo(session: RoleSession, name: string): Promise<void> {
  const nav = session.page.getByRole('navigation', { name: 'パンくずリスト' });
  await nav.getByRole('button').filter({ hasText: name }).first().click();
}

test.describe('ウォーターフォール継承 & 途中階層パス表示 (TOM-54)', () => {
  test('Flow A: deep folder share walks Root -> Dept -> Deep through path-only ancestors without sibling/file leakage', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    const base = uniqueName(`T54A ${token()}`);
    const rootName = `${base} Root`;
    const siblingName = `${base} Sibling`;
    const deptSiblingName = `${base} DeptSibling`;
    const root = await createFolder(admin, { parentId: null, name: rootName });
    cleanup.registerFolder(root.id);
    const { dept, deep } = await buildTreeFromRoot(admin, root, base);
    const sibling = await createFolder(admin, {
      parentId: root.id,
      name: siblingName,
    });
    await createFolder(admin, {
      parentId: dept.id,
      name: deptSiblingName,
    });

    const rootFileName = `${base} Root File.txt`;
    const deptFileName = `${base} Dept File.txt`;
    const deepFileName = `${base} Deep File.txt`;
    const siblingFileName = `${base} Sibling File.txt`;
    await uploadFile(admin, {
      folderId: root.id,
      name: rootFileName,
      content: 'root-only',
    });
    await uploadFile(admin, {
      folderId: dept.id,
      name: deptFileName,
      content: 'dept-only',
    });
    const deepFile = await uploadFile(admin, {
      folderId: deep.id,
      name: deepFileName,
      content: 'deep target content',
    });
    await uploadFile(admin, {
      folderId: sibling.id,
      name: siblingFileName,
      content: 'sibling-only',
    });

    await grantPermission(admin, {
      targetType: 'folder',
      targetId: deep.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'viewer',
    });

    try {
      await member.page.goto('/workspace');
      const rootRow = folderRow(member, rootName);
      await expect(rootRow).toBeVisible();
      await expect(
        member.page.getByTestId('folder-path-only-badge').first()
      ).toBeVisible();
      await expect(
        member.page.getByRole('main').getByText(rootFileName, { exact: true })
      ).toHaveCount(0);
      await expect(
        member.page.getByRole('main').getByText(siblingName, { exact: true })
      ).toHaveCount(0);

      await openFolder(member, root);
      await expect(member.page.getByTestId('path-only-banner')).toBeVisible();
      await expect(
        member.page.getByText(
          '途中階層 (パス専用): アクセス可能な子孫フォルダへ移動するための経路表示です。',
          { exact: false }
        )
      ).toBeVisible();
      await expect(folderRow(member, dept.name)).toBeVisible();
      await expect(
        member.page.getByTestId('folder-path-only-badge').first()
      ).toBeVisible();
      await expect(
        member.page.getByRole('main').getByText(rootFileName, { exact: true })
      ).toHaveCount(0);
      await expect(
        member.page.getByRole('main').getByText(siblingName, { exact: true })
      ).toHaveCount(0);
      await expect(
        member.page.getByRole('main').getByRole('button', {
          name: '新規フォルダ',
          exact: true,
        })
      ).toHaveCount(0);

      await openFolder(member, dept);
      await expect(member.page.getByTestId('path-only-banner')).toBeVisible();
      await expect(folderRow(member, deep.name)).toBeVisible();
      await expect(
        member.page.getByRole('main').getByText(deptFileName, { exact: true })
      ).toHaveCount(0);
      await expect(
        member.page.getByRole('main').getByText(deptSiblingName, { exact: true })
      ).toHaveCount(0);

      await openFolder(member, deep);
      await expect(member.page.getByTestId('path-only-banner')).toHaveCount(0);
      await expect(
        member.page.getByRole('main').getByText('実効ロール: viewer', {
          exact: true,
        })
      ).toBeVisible();
      const deepFileRow = member.page
        .getByRole('main')
        .getByRole('button', { name: deepFileName, exact: true });
      await expect(deepFileRow).toBeVisible();

      const popupPromise = member.context.waitForEvent('page');
      await deepFileRow.dblclick();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      expect(popup.url()).toContain(
        `/workspace/file/${encodeURIComponent(deepFile.id)}`
      );
      await popup.close();

      await breadcrumbTo(member, dept.name);
      await expect(member.page.getByTestId('path-only-banner')).toBeVisible();
      await expect(folderRow(member, deep.name)).toBeVisible();
      await breadcrumbTo(member, rootName);
      await expect(folderRow(member, dept.name)).toBeVisible();
      await expect(
        member.page.getByRole('main').getByText(deptFileName, { exact: true })
      ).toHaveCount(0);
    } finally {
      await admin.api
        .delete(`/api/folders/${encodeURIComponent(root.id)}`)
        .catch(() => undefined);
    }
  });

  test('Flow B: shared items lists directly shared deep folder, nested file and root-loose file with path labels', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    const base = uniqueName(`T54B ${token()}`);
    const root = await createFolder(admin, { parentId: null, name: base });
    cleanup.registerFolder(root.id);
    const { dept, deep } = await buildTreeFromRoot(admin, root, base);

    const nestedFileName = `${base} Nested Share.txt`;
    const rootShareName = `${base} Root Share.txt`;
    const looseName = `${base} Loose Share.txt`;
    const nestedFile = await uploadFile(admin, {
      folderId: dept.id,
      name: nestedFileName,
      content: 'nested shared',
    });
    const rootFile = await uploadFile(admin, {
      folderId: root.id,
      name: rootShareName,
      content: 'root shared',
    });
    const looseFile = await uploadFile(admin, {
      folderId: null,
      name: looseName,
      content: 'root loose shared',
    });

    await grantPermission(admin, {
      targetType: 'folder',
      targetId: deep.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'viewer',
    });
    await grantPermission(admin, {
      targetType: 'file',
      targetId: nestedFile.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'viewer',
    });
    await grantPermission(admin, {
      targetType: 'file',
      targetId: rootFile.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'viewer',
    });
    await grantPermission(admin, {
      targetType: 'file',
      targetId: looseFile.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'viewer',
    });

    try {
      await member.page.goto('/workspace');
      await member.page.getByRole('link', { name: '共有アイテム' }).click();
      await expect
        .poll(() => new URL(member.page.url()).searchParams.get('view'))
        .toBe('shared');
      await expect(
        member.page.getByRole('heading', { name: '共有アイテム' })
      ).toBeVisible();

      const deepRow = member.page
        .getByTestId('shared-item-row')
        .filter({ hasText: deep.name });
      await expect(deepRow).toBeVisible();
      await expect(deepRow.getByTestId('shared-item-path')).toHaveText(
        `マイファイル / ${base} / ${dept.name} / ${deep.name}`
      );

      const nestedRow = member.page
        .getByTestId('shared-item-row')
        .filter({ hasText: nestedFileName });
      await expect(nestedRow).toBeVisible();
      await expect(nestedRow.getByTestId('shared-item-path')).toHaveText(
        `マイファイル / ${base} / ${dept.name}`
      );

      const rootRow = member.page
        .getByTestId('shared-item-row')
        .filter({ hasText: rootShareName });
      await expect(rootRow).toBeVisible();
      await expect(rootRow.getByTestId('shared-item-path')).toHaveText(
        `マイファイル / ${base}`
      );

      const looseRow = member.page
        .getByTestId('shared-item-row')
        .filter({ hasText: looseName });
      await expect(looseRow).toBeVisible();
      await expect(looseRow.getByTestId('shared-item-path')).toHaveText(
        'マイファイル (ルート)'
      );

      await deepRow
        .getByRole('button')
        .filter({ hasText: deep.name })
        .first()
        .click();
      await expect
        .poll(() => new URL(member.page.url()).searchParams.get('folderId'))
        .toBe(deep.id);

      await member.page.getByRole('link', { name: '共有アイテム' }).click();
      const popupPromise = member.context.waitForEvent('page');
      await member.page
        .getByTestId('shared-item-row')
        .filter({ hasText: nestedFileName })
        .getByRole('button')
        .filter({ hasText: nestedFileName })
        .first()
        .click();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      expect(popup.url()).toContain(
        `/workspace/file/${encodeURIComponent(nestedFile.id)}`
      );
      await popup.close();
    } finally {
      await softDeleteFile(admin, looseFile.id).catch(() => undefined);
      await admin.api
        .delete(`/api/folders/${encodeURIComponent(root.id)}`)
        .catch(() => undefined);
    }
  });

  test('Flow C: sys_admin switches to waterfall, reviews conflicts, sees inherited lock guidance and can still add a new principal', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const base = uniqueName(`T54C ${token()}`);
    const root = await createFolder(admin, { parentId: null, name: base });
    cleanup.registerFolder(root.id);
    const { dept, deep } = await buildTreeFromRoot(admin, root, base);

    await setInheritanceMode(admin, 'additive');
    // Additive child override: same member is viewer on the parent and editor
    // on the child.
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: dept.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'viewer',
    });
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: deep.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'editor',
    });

    try {
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
      await admin.page.getByTestId('enterprise-topic-folder-structure').click();
      const accessSection = admin.page.getByTestId(
        'enterprise-topic-card-folder-structure'
      );
      await expect(
        accessSection.getByRole('heading', {
          name: '権限継承モード (Additive / Waterfall)',
        })
      ).toBeVisible();
      await expect(
        accessSection.locator(
          'input[name="permissionInheritanceMode"][value="additive"]'
        )
      ).toBeChecked();

      await accessSection
        .locator('input[name="permissionInheritanceMode"][value="waterfall"]')
        .check();
      await accessSection
        .getByRole('button', { name: '継承モードを保存', exact: true })
        .click();
      await expect(
        accessSection.getByRole('status').filter({
          hasText: 'Waterfall',
        })
      ).toBeVisible();

      const conflictRow = accessSection
        .getByTestId('inheritance-conflict-row')
        .filter({ hasText: deep.name });
      await expect(conflictRow).toBeVisible();
      await expect(conflictRow).toContainText(DEV_USERS.member.displayName);
      await expect(conflictRow).toContainText('Editor');
      await expect(conflictRow).toContainText(dept.name);
      await expect(conflictRow).toContainText('Viewer');

      await admin.page.goto(
        `/workspace?folderId=${encodeURIComponent(deep.id)}`
      );
      await admin.page
        .getByRole('main')
        .getByRole('button', { name: '権限管理', exact: true })
        .click();
      const dialog = admin.page.getByRole('dialog', {
        name: `アクセス権限: ${deep.name}`,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByTestId('permission-inheritance-mode')
      ).toContainText('Waterfall');
      await expect(
        dialog
          .getByTestId('permission-inherited-guidance')
          .filter({ hasText: dept.name })
          .first()
      ).toContainText(dept.name);

      await dialog
        .locator('#permission-principal-search')
        .fill(DEV_USERS.member.email);
      await dialog
        .getByRole('listbox', { name: '検索候補' })
        .getByRole('option')
        .filter({ hasText: DEV_USERS.member.email })
        .first()
        .click();
      await expect(
        dialog.getByTestId('waterfall-inherited-notice')
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: '付与', exact: true })
      ).toBeDisabled();

      const locked = await admin.api.post('/api/permissions', {
        data: {
          targetType: 'folder',
          targetId: deep.id,
          granteeType: 'user',
          granteeId: DEV_USERS.member.id,
          role: 'viewer',
        },
      });
      expect(locked.status()).toBe(409);
      expect(await locked.json()).toMatchObject({
        code: 'WATERFALL_INHERITED_LOCKED',
        ancestorFolderId: dept.id,
        ancestorFolderName: dept.name,
        inheritedRole: 'viewer',
      });

      // Brand-new principal without an inherited grant is still grantable.
      await dialog
        .locator('#permission-principal-search')
        .fill(DEV_USERS.sec_admin.email);
      await dialog
        .getByRole('listbox', { name: '検索候補' })
        .getByRole('option')
        .filter({ hasText: DEV_USERS.sec_admin.email })
        .first()
        .click();
      await expect(
        dialog.getByTestId('waterfall-inherited-notice')
      ).toHaveCount(0);
      const grantButton = dialog.getByRole('button', {
        name: '付与',
        exact: true,
      });
      await expect(grantButton).toBeEnabled();
      await grantButton.click();
      await expect(
        dialog.getByText(DEV_USERS.sec_admin.displayName, { exact: false })
      ).toBeVisible();
    } finally {
      await setInheritanceMode(admin, 'additive').catch(() => undefined);
      await admin.api
        .delete(`/api/folders/${encodeURIComponent(root.id)}`)
        .catch(() => undefined);
    }
  });
});
