import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, DEV_USERS } from './fixtures';
import {
  createFolder,
  getFolderChildren,
  grantPermission,
  listPermissions,
  uploadFile,
  waitForFileInFolder,
  waitForFileVersion,
  type ApiActor,
  type FolderLike,
} from './helpers/api';
import { buildDocx } from './helpers/docx';
import { uniqueName } from './helpers/browser';

function token(): string {
  return `ar${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function createIsolatedRoot(
  admin: ApiActor,
  cleanup: { registerFolder: (folderId: string) => void },
  prefix: string
): Promise<FolderLike> {
  const root = await createFolder(admin, {
    parentId: null,
    name: uniqueName(prefix),
    classification: 'internal',
  });
  cleanup.registerFolder(root.id);
  return root;
}

async function ensureAdvancedRoles(admin: ApiActor): Promise<void> {
  const response = await admin.api.patch('/api/admin/policies', {
    data: { advancedRolesEnabled: true },
  });
  expect(response.status()).toBe(200);
}

async function openPermissionsModal(
  page: Page,
  targetName: string
): Promise<ReturnType<Page['getByRole']>> {
  await page.getByRole('button', { name: '権限管理', exact: true }).first().click();
  const dialog = page.getByRole('dialog', {
    name: `アクセス権限: ${targetName}`,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function grantRoleThroughModal(
  dialog: ReturnType<Page['getByRole']>,
  role:
    | 'viewer'
    | 'uploader'
    | 'previewer_uploader'
    | 'viewer_uploader'
): Promise<void> {
  await dialog
    .locator('#permission-principal-search')
    .fill(DEV_USERS.member.email);
  const listbox = dialog.getByRole('listbox', { name: '検索候補' });
  await expect(listbox).toBeVisible();
  await listbox.getByRole('option').first().click();
  await dialog.locator('#permission-role').selectOption(role);
  await dialog.getByRole('button', { name: '付与', exact: true }).click();
  await expect(
    dialog
      .getByTestId('permission-row-direct')
      .filter({ hasText: DEV_USERS.member.displayName })
      .first()
  ).toBeVisible();
}

async function uploadThroughDropzone(
  page: Page,
  input: { name: string; mimeType: string; content: string | Buffer }
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'ファイルを選択', exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: input.name,
    mimeType: input.mimeType,
    buffer: Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, 'utf8'),
  });
}

async function waitForChildFolder(
  admin: ApiActor,
  parentId: string,
  name: string
): Promise<void> {
  await expect
    .poll(async () => {
      const children = await getFolderChildren(admin, parentId);
      return children.folders.some((folder) => folder.name === name);
    })
    .toBe(true);
}

async function expectNoWorkspaceKeyboardRenameOrDelete(
  page: Page,
  rowName: string
): Promise<void> {
  await page
    .getByRole('main')
    .getByRole('button', { name: rowName, exact: true })
    .click();
  await page.keyboard.press('F2');
  await expect(page.locator('input[name="renameValue"]')).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(
    page.getByRole('main').getByRole('button', { name: rowName, exact: true })
  ).toBeVisible();
}

test.describe('高度ロール UI / アップロード専用・プレビュー専用 UX', () => {
  test('Flow A: /admin の高度ロール有効化スイッチが保存・再読込される', async ({
    as,
  }) => {
    const admin = await as('sys_admin');

    const reset = await admin.api.patch('/api/admin/policies', {
      data: { advancedRolesEnabled: false },
    });
    expect(reset.status()).toBe(200);

    await admin.page.goto('/admin');
    await expect(
      admin.page.getByRole('heading', {
        name: 'ガバナンス & セキュリティ統合ダッシュボード',
      })
    ).toBeVisible();

    const section = admin.page
      .locator('section')
      .filter({ has: admin.page.getByRole('heading', { name: 'アクセス制御' }) })
      .first();
    await expect(section).toBeVisible();
    await expect(
      section.getByRole('heading', {
        name: 'フォルダ構成モード (Open / Closed)',
      })
    ).toBeVisible();
    await expect(
      section.getByText(/既存のルートフォルダ・配下フォルダ・ファイル・権限は/).first()
    ).toBeVisible();
    await expect(
      section.locator('input[name="folderStructureMode"][value="open"]')
    ).toBeChecked();

    const toggle = admin.page.locator('#policy-advanced-roles-enabled');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('switch', '');
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    const save = admin.page.getByRole('button', { name: '変更を保存' });
    await expect(save).toBeEnabled();
    await save.click();

    await expect(
      admin.page.getByRole('status').filter({
        hasText:
          '高度ロール (Uploader / Previewer + Uploader / Viewer + Uploader) を有効化しました。',
      })
    ).toBeVisible();

    await admin.page.reload();
    await expect(
      admin.page.locator('#policy-advanced-roles-enabled')
    ).toBeChecked();
  });

  test('Flow B: 権限モーダルのロールグループ・継承表示・実効内訳・ファイル専用ロール制約', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');

    await ensureAdvancedRoles(admin);

    const root = await createIsolatedRoot(admin, cleanup, 'e2e-ar-perm');
    const parent = await createFolder(admin, {
      parentId: root.id,
      name: uniqueName('parent'),
      classification: 'internal',
    });
    const child = await createFolder(admin, {
      parentId: parent.id,
      name: uniqueName('child'),
      classification: 'internal',
    });
    const permissionFile = await uploadFile(admin, {
      folderId: child.id,
      name: `${token()}.txt`,
      content: 'permission modal file\n',
    });

    // Grant Viewer on the parent folder through the UI.
    await admin.page.goto(
      `/workspace?folderId=${encodeURIComponent(parent.id)}`
    );
    const parentDialog = await openPermissionsModal(admin.page, parent.name);
    const roleGroups = await parentDialog
      .locator('optgroup')
      .evaluateAll((groups) =>
        groups.map((group) => group.getAttribute('label'))
      );
    expect(roleGroups).toEqual(['所有者/管理', '編集', '投稿', '閲覧']);

    await parentDialog.locator('#permission-role').selectOption('viewer');
    await expect(
      parentDialog.locator('#permission-role-description')
    ).toContainText('DL');
    await grantRoleThroughModal(parentDialog, 'viewer');
    await parentDialog.getByRole('button', { name: '閉じる' }).click();

    // Grant Uploader on the child folder; viewer is inherited from the parent.
    await admin.page.goto(
      `/workspace?folderId=${encodeURIComponent(child.id)}`
    );
    const childDialog = await openPermissionsModal(admin.page, child.name);
    await grantRoleThroughModal(childDialog, 'uploader');

    const inheritedViewer = childDialog
      .getByTestId('permission-row-inherited')
      .filter({ hasText: DEV_USERS.member.displayName })
      .filter({ hasText: 'Viewer' })
      .first();
    await expect(inheritedViewer).toBeVisible();
    await expect(
      inheritedViewer.getByTestId('permission-inherited-badge')
    ).toContainText(`継承元: ${parent.name}`);
    await expect(
      inheritedViewer.getByRole('button', { name: /権限を削除/ })
    ).toHaveCount(0);

    const breakdown = childDialog
      .getByTestId('permission-breakdown-grantee')
      .filter({ hasText: DEV_USERS.member.displayName })
      .first();
    await expect(breakdown).toBeVisible();
    await expect(breakdown).toContainText(
      `親フォルダ (${parent.name}) の Viewer`
    );
    await expect(breakdown).toContainText('Viewer + Uploader');
    await childDialog.getByRole('button', { name: '閉じる' }).click();

    // File permission modal: only the five standard roles are offered.
    await admin.page
      .getByRole('main')
      .getByRole('button', { name: permissionFile.name, exact: true })
      .click();
    await admin.page.keyboard.press('i');
    const inspector = admin.page.getByRole('complementary', {
      name: '詳細インスペクタ',
    });
    await expect(inspector).toBeVisible();
    await inspector.getByRole('button', { name: '権限管理' }).click();

    const fileDialog = admin.page.getByRole('dialog', {
      name: `アクセス権限: ${permissionFile.name}`,
    });
    await expect(fileDialog).toBeVisible();
    const fileRoleGroups = await fileDialog
      .locator('optgroup')
      .evaluateAll((groups) =>
        groups.map((group) => group.getAttribute('label'))
      );
    expect(fileRoleGroups).toEqual(['所有者/管理', '編集', '閲覧']);
    const fileOptions = await fileDialog
      .locator('#permission-role option')
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value)
      );
    expect(fileOptions).toEqual([
      'owner',
      'co_owner',
      'editor',
      'viewer',
      'previewer',
    ]);
    await expect(fileDialog.getByText(/フォルダ専用です/)).toBeVisible();
    await fileDialog.getByRole('button', { name: '閉じる' }).click();

    const folderOnly = await admin.api.post('/api/permissions', {
      data: {
        targetType: 'file',
        targetId: permissionFile.id,
        granteeType: 'user',
        granteeId: DEV_USERS.member.id,
        role: 'uploader',
      },
    });
    expect(folderOnly.status()).toBe(400);
    expect((await folderOnly.json()) as { code?: string }).toMatchObject({
      code: 'ROLE_FOLDER_ONLY',
    });

    const permissionList = await listPermissions(admin, {
      targetType: 'folder',
      targetId: child.id,
    });
    expect(permissionList.advancedRolesEnabled).toBe(true);
    expect(permissionList.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          granteeId: DEV_USERS.member.id,
          role: 'uploader',
          inherited: false,
          synthesizedRole: 'viewer_uploader',
        }),
      ])
    );
  });

  test('Flow C: Uploader は新規アップロードとサブフォルダ作成のみ可能', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    await ensureAdvancedRoles(admin);

    const root = await createIsolatedRoot(admin, cleanup, 'e2e-ar-uploader');
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: root.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'uploader',
    });
    const hiddenFile = await uploadFile(admin, {
      folderId: root.id,
      name: `${token()}-hidden.txt`,
      content: 'uploader cannot see this file\n',
    });

    await member.page.goto(
      `/workspace?folderId=${encodeURIComponent(root.id)}`
    );
    const banner = member.page.getByTestId('workspace-permission-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('実効ロール: Uploader');
    await expect(banner).toContainText(
      'アップロードしたファイルはこの一覧に表示されません'
    );

    const conflictPolicy = member.page.getByLabel(
      '同名ファイル衝突時のポリシー'
    );
    await expect(conflictPolicy).toBeDisabled();
    await expect(
      conflictPolicy.locator('option[value="new_version"]')
    ).toBeDisabled();
    await expect(
      member.page.getByText('※ 新規アップロードのみ可（既存ファイルの上書き不可）')
    ).toBeVisible();

    const uploadedName = `${token()}-upload.txt`;
    await uploadThroughDropzone(member.page, {
      name: uploadedName,
      mimeType: 'text/plain',
      content: 'uploaded by uploader e2e\n',
    });
    await waitForFileInFolder(admin, root.id, uploadedName);
    await expect(
      member.page
        .getByRole('main')
        .getByRole('button', { name: uploadedName, exact: true })
    ).toHaveCount(0);
    await expect(
      member.page.getByText('Uploader 権限のためファイルは非表示です')
    ).toBeVisible();
    await expect(
      member.page
        .getByRole('main')
        .getByRole('button', { name: hiddenFile.name, exact: true })
    ).toHaveCount(0);

    const subfolderName = uniqueName('uploader-sub');
    await member.page
      .getByRole('button', { name: '新規フォルダ', exact: true })
      .click();
    const createDialog = member.page.getByRole('dialog', {
      name: '新規フォルダを作成',
    });
    await expect(createDialog).toBeVisible();
    await createDialog.locator('#workspace-modal-name').fill(subfolderName);
    await createDialog
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await expect(createDialog).toBeHidden();
    await waitForChildFolder(admin, root.id, subfolderName);

    const subfolderRow = member.page
      .getByRole('row')
      .filter({ hasText: subfolderName });
    await expect(subfolderRow).toBeVisible();
    await expectNoWorkspaceKeyboardRenameOrDelete(member.page, subfolderName);

    await subfolderRow.click({ button: 'right' });
    const menu = member.page.getByRole('menu', {
      name: 'コンテキストメニュー',
    });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: '名前の変更' })
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      menu.getByRole('menuitem', { name: 'ゴミ箱へ移動' })
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      menu.getByRole('menuitem', { name: '共有', exact: true })
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      menu.getByRole('menuitem', { name: 'ダウンロード' })
    ).toHaveCount(0);
    await expect(
      member.page.getByRole('button', { name: '権限管理', exact: true })
    ).toHaveCount(0);
    await member.page.keyboard.press('Escape');

    // Directly opening the hidden file is rejected by the API and UI.
    await member.page.goto(
      `/workspace/file/${encodeURIComponent(hiddenFile.id)}`
    );
    await expect(
      member.page.getByRole('heading', {
        name: 'ファイルを開けませんでした',
      })
    ).toBeVisible();
  });

  test('Flow D: Previewer + Uploader はプレビューと新規UPのみ（DL・変更・削除不可）', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    await ensureAdvancedRoles(admin);

    const root = await createIsolatedRoot(admin, cleanup, 'e2e-ar-previewer-up');
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: root.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'previewer_uploader',
    });
    const existing = await uploadFile(admin, {
      folderId: root.id,
      name: `${token()}-preview.txt`,
      content: 'preview-only watermark content\n',
    });

    await member.page.goto(
      `/workspace?folderId=${encodeURIComponent(root.id)}`
    );
    const banner = member.page.getByTestId('workspace-permission-banner');
    await expect(banner).toContainText('実効ロール: Previewer + Uploader');
    await expect(
      member.page.getByLabel('同名ファイル衝突時のポリシー')
    ).toBeDisabled();

    const uploadedName = `${token()}-pu.txt`;
    await uploadThroughDropzone(member.page, {
      name: uploadedName,
      mimeType: 'text/plain',
      content: 'previewer uploader new file\n',
    });
    await waitForFileInFolder(admin, root.id, uploadedName);

    const viewerPopupPromise = member.page.waitForEvent('popup');
    await member.page
      .getByRole('main')
      .getByRole('button', { name: existing.name, exact: true })
      .dblclick();
    const viewerPage = await viewerPopupPromise;
    await viewerPage.waitForLoadState('domcontentloaded');
    await expect(viewerPage.getByTestId('dynamic-watermark')).toBeVisible();
    await expect(
      viewerPage.getByRole('button', { name: 'ダウンロード' })
    ).toHaveCount(0);
    await expect(viewerPage.getByText(existing.name)).toBeVisible();
    await viewerPage.close();

    const fileRow = member.page
      .getByRole('row')
      .filter({ hasText: existing.name });
    await fileRow.getByRole('button', { name: /その他の操作/ }).click();
    const menu = member.page.getByRole('menu', {
      name: 'コンテキストメニュー',
    });
    await expect(menu).toBeVisible();
    for (const label of [
      'ダウンロード',
      '名前の変更',
      'コピー',
      '切り取り',
      '共有',
      'ゴミ箱へ移動',
    ]) {
      await expect(
        menu.getByRole('menuitem', { name: label, exact: true })
      ).toHaveAttribute('aria-disabled', 'true');
    }
    await member.page.keyboard.press('Escape');

    await expectNoWorkspaceKeyboardRenameOrDelete(
      member.page,
      existing.name
    );
    const stillThere = await getFolderChildren(admin, root.id);
    expect(stillThere.files.map((file) => file.id)).toContain(existing.id);

    await member.page
      .getByRole('main')
      .getByRole('button', { name: existing.name, exact: true })
      .click();
    await member.page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+c' : 'Control+c'
    );
    await expect(
      member.page.getByRole('region', { name: '仮想クリップボード' })
    ).toHaveCount(0);
  });

  test('Flow E: Viewer + Uploader は新版UP・WOPI編集・表示専用共有のみ', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    await ensureAdvancedRoles(admin);

    const root = await createIsolatedRoot(admin, cleanup, 'e2e-ar-viewer-up');
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: root.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'viewer_uploader',
    });
    const textFile = await uploadFile(admin, {
      folderId: root.id,
      name: `${token()}-vu.txt`,
      content: 'viewer uploader v1\n',
    });
    const docxFile = await uploadFile(admin, {
      folderId: root.id,
      name: `${token()}-vu.docx`,
      content: buildDocx({
        title: 'Viewer Uploader E2E',
        paragraphs: ['Viewer + Uploader collaborative editing fixture.'],
      }),
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    await member.page.goto(
      `/workspace?folderId=${encodeURIComponent(root.id)}`
    );
    const banner = member.page.getByTestId('workspace-permission-banner');
    await expect(banner).toContainText('実効ロール: Viewer + Uploader');

    const conflictPolicy = member.page.getByLabel(
      '同名ファイル衝突時のポリシー'
    );
    await expect(conflictPolicy).toBeEnabled();
    await conflictPolicy.selectOption('new_version');
    await uploadThroughDropzone(member.page, {
      name: textFile.name,
      mimeType: 'text/plain',
      content: 'viewer uploader v2\n',
    });
    await waitForFileVersion(admin, textFile.id, 2);

    // Share link creation from the inspector: display-only + watermark.
    await member.page
      .getByRole('main')
      .getByRole('button', { name: new RegExp(textFile.name) })
      .first()
      .click();
    await member.page.keyboard.press('i');
    const inspector = member.page.getByRole('complementary', {
      name: '詳細インスペクタ',
    });
    await expect(inspector).toBeVisible();
    await inspector
      .getByRole('button', { name: '共有リンク設定 (s)' })
      .click();

    const shareDialog = member.page.getByRole('dialog', {
      name: `共有リンク設定: ${textFile.name}`,
    });
    await expect(shareDialog).toBeVisible();
    await expect(shareDialog.getByText(/表示専用/)).toBeVisible();
    const downloadPermission = shareDialog.getByRole('checkbox', {
      name: 'ダウンロードを許可する',
    });
    await expect(downloadPermission).toBeDisabled();
    await expect(downloadPermission).not.toBeChecked();
    await expect(
      shareDialog.getByRole('checkbox', { name: /動的透かし/ })
    ).toBeChecked();
    await shareDialog.getByRole('button', { name: 'リンクを発行' }).click();
    await expect(shareDialog.locator('#share-generated-url')).toBeVisible();

    const linksResponse = await admin.api.get(
      `/api/shared-links?targetType=file&targetId=${encodeURIComponent(
        textFile.id
      )}`
    );
    expect(linksResponse.status()).toBe(200);
    const linksBody = (await linksResponse.json()) as {
      links: Array<{ canDownload: boolean; requireWatermark: boolean }>;
    };
    expect(linksBody.links).toHaveLength(1);
    expect(linksBody.links[0]).toMatchObject({
      canDownload: false,
      requireWatermark: true,
    });
    await shareDialog.getByRole('button', { name: '閉じる' }).click();

    // Real WOPI session response must grant write access to Viewer + Uploader.
    const wopiSession = member.page.waitForResponse(
      (response) =>
        response.url().includes(`/api/files/${docxFile.id}/wopi-session`) &&
        response.request().method() === 'POST'
    );
    await member.page.goto(
      `/workspace/file/${encodeURIComponent(docxFile.id)}`
    );
    const wopiResponse = await wopiSession;
    expect(wopiResponse.status()).toBe(201);
    const wopiBody = (await wopiResponse.json()) as {
      canWrite: boolean;
      readOnly: boolean;
      role: string;
      capabilities: string[];
    };
    expect(wopiBody).toMatchObject({
      canWrite: true,
      readOnly: false,
      role: 'viewer_uploader',
    });
    expect(wopiBody.capabilities).toContain('item.edit_content');
    await expect(
      member.page.getByTestId('wopi-session-status')
    ).toContainText('同時編集セッション');
    await expect(
      member.page.getByText('Collabora Online 同時編集')
    ).toBeVisible();

    // Back in the workspace: rename / cut / delete / permissions stay unavailable.
    await member.page.goto(
      `/workspace?folderId=${encodeURIComponent(root.id)}`
    );
    await expectNoWorkspaceKeyboardRenameOrDelete(member.page, docxFile.name);
    await member.page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+x' : 'Control+x'
    );
    await expect(
      member.page.getByRole('region', { name: '仮想クリップボード' })
    ).toHaveCount(0);

    const docxRow = member.page
      .getByRole('row')
      .filter({ hasText: docxFile.name });
    await docxRow.getByRole('button', { name: /その他の操作/ }).click();
    const menu = member.page.getByRole('menu', {
      name: 'コンテキストメニュー',
    });
    await expect(
      menu.getByRole('menuitem', { name: '名前の変更' })
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      menu.getByRole('menuitem', { name: '切り取り' })
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      menu.getByRole('menuitem', { name: 'ゴミ箱へ移動' })
    ).toHaveAttribute('aria-disabled', 'true');

    await menu.getByRole('menuitem', { name: '共有', exact: true }).hover();
    const shareSubmenu = member.page.getByRole('menu', {
      name: '共有 サブメニュー',
    });
    await expect(
      shareSubmenu.getByRole('menuitem', { name: '権限管理' })
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      shareSubmenu.getByRole('menuitem', { name: '共有リンク設定' })
    ).toHaveAttribute('aria-disabled', 'false');
    await member.page.keyboard.press('Escape');
  });

  test('Flow F: 390px 幅でも権限バナーと権限モーダルが横overflowしない', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    await ensureAdvancedRoles(admin);

    const root = await createIsolatedRoot(admin, cleanup, 'e2e-ar-mobile');
    const child = await createFolder(admin, {
      parentId: root.id,
      name: uniqueName('mobile-child'),
      classification: 'internal',
    });
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: root.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'viewer_uploader',
    });

    await admin.page.setViewportSize({ width: 390, height: 844 });
    await admin.page.goto(
      `/workspace?folderId=${encodeURIComponent(child.id)}`
    );
    await openPermissionsModal(admin.page, child.name);
    await expect
      .poll(() =>
        admin.page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      )
      .toBe(true);
    await admin.page
      .getByRole('dialog', { name: `アクセス権限: ${child.name}` })
      .getByRole('button', { name: '閉じる' })
      .click();

    await member.page.setViewportSize({ width: 390, height: 844 });
    await member.page.goto(
      `/workspace?folderId=${encodeURIComponent(root.id)}`
    );
    await expect(
      member.page.getByTestId('workspace-permission-banner')
    ).toBeVisible();
    await expect
      .poll(() =>
        member.page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      )
      .toBe(true);
  });
});
