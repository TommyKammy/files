import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test, DEV_USERS } from './fixtures';
import {
  createFolder,
  getFileDetails,
  grantPermission,
  uploadFile,
  type FolderLike,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

const POLICY_DEFAULTS = {
  allowSharedLinkEdit: false,
  allowPublicEditLinks: false,
  allowViewerShareLinks: false,
};

async function setSharePolicy(
  actor: { api: APIRequestContext },
  patch: Partial<typeof POLICY_DEFAULTS>
): Promise<void> {
  const res = await actor.api.patch('/api/admin/policies', {
    data: { ...POLICY_DEFAULTS, ...patch },
  });
  expect(
    res.status(),
    `PATCH /api/admin/policies ${JSON.stringify(patch)}`
  ).toBe(200);
}

async function createIsolatedRoot(
  admin: { api: APIRequestContext },
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

async function focusWorkspaceRow(page: Page, name: string): Promise<void> {
  const row = page.getByRole('main').getByRole('button', { name, exact: true });
  await expect(row).toBeVisible();
  await row.click();
}

async function openSharePopover(page: Page, name: string) {
  await focusWorkspaceRow(page, name);
  await page.keyboard.press('s');
  const dialog = page.getByRole('dialog', {
    name: `共有リンク設定: ${name}`,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function readGeneratedToken(
  dialog: ReturnType<Page['getByRole']>
): Promise<string> {
  const input = dialog.locator('#share-generated-url');
  await expect(input).toBeVisible();
  const value = await input.inputValue();
  const url = new URL(value);
  const token = url.pathname.split('/').filter(Boolean).pop();
  expect(token, 'generated share URL must include a token').toBeTruthy();
  return token!;
}

test.describe('TOM-56 shared-link permission levels', () => {
  test('Flow A: sys_admin が編集リンク・Viewer共有リンクポリシーを保存・再読込できる', async ({
    as,
  }) => {
    const admin = await as('sys_admin');
    try {
      await setSharePolicy(admin, POLICY_DEFAULTS);
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

      const editToggle = admin.page.locator('#policy-allow-shared-link-edit');
      const viewerToggle = admin.page.locator('#policy-allow-viewer-share-links');
      const publicToggle = admin.page.locator('#policy-allow-public-edit-links');

      await expect(editToggle).toBeVisible();
      await expect(editToggle).toHaveAttribute('switch', '');
      await expect(editToggle).not.toBeChecked();
      await expect(publicToggle).toBeDisabled();

      await editToggle.check();
      await expect(publicToggle).toBeEnabled();
      await viewerToggle.check();
      await admin.page
        .getByRole('button', { name: 'ポリシーを保存', exact: true })
        .click();
      await expect(
        admin.page.getByRole('status').filter({
          hasText: 'テナントガバナンスポリシーを更新しました。',
        })
      ).toBeVisible();

      await admin.page.reload();
      await expect(
        admin.page.locator('#policy-allow-shared-link-edit')
      ).toBeChecked();
      await expect(
        admin.page.locator('#policy-allow-viewer-share-links')
      ).toBeChecked();
      await expect(
        admin.page.locator('#policy-allow-public-edit-links')
      ).not.toBeChecked();
    } finally {
      await setSharePolicy(admin, POLICY_DEFAULTS);
    }
  });

  test('Flow B: editor が view リンクを作成し、単一使用プレビューと edit リンクを確認できる', async ({
    as,
    cleanup,
    browser,
    baseURL,
  }) => {
    const admin = await as('sys_admin');
    const editor = await as('member');
    try {
      await setSharePolicy(admin, {
        allowSharedLinkEdit: true,
        allowViewerShareLinks: true,
      });
      const root = await createIsolatedRoot(admin, cleanup, 'sll-b');
      const fileName = `${uniqueName('share-b')}.txt`;
      await uploadFile(admin, {
        folderId: root.id,
        name: fileName,
        content: 'flow-b preview content\nsecond line',
        mimeType: 'text/plain; charset=utf-8',
      });
      await grantPermission(admin, {
        targetType: 'folder',
        targetId: root.id,
        granteeType: 'user',
        granteeId: DEV_USERS.member.id,
        role: 'editor',
      });

      await editor.page.goto(`/workspace?folderId=${root.id}`);
      let dialog = await openSharePopover(editor.page, fileName);

      const viewRadio = dialog.getByRole('radio', { name: /表示のみ \(view\)/ });
      const downloadRadio = dialog.getByRole('radio', {
        name: /表示 \+ ダウンロード \(download\)/,
      });
      const editRadio = dialog.getByRole('radio', {
        name: /表示 \+ DL \+ 編集 \(edit\)/,
      });
      await expect(viewRadio).toBeEnabled();
      await expect(downloadRadio).toBeEnabled();
      await expect(editRadio).toBeEnabled();

      await viewRadio.check();
      await dialog.getByRole('button', { name: 'リンクを発行' }).click();
      const viewToken = await readGeneratedToken(dialog);
      await dialog.getByRole('button', { name: '閉じる' }).click();

      // A public view link opened anonymously hides download and previews
      // through the single-use stream. (The editor's own collaborator grants
      // would union item.download, so anonymous is the authoritative view.)
      const anonContext = await browser.newContext({
        baseURL,
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
      });
      try {
        const anonPage = await anonContext.newPage();
        const previewRequests: string[] = [];
        anonPage.on('request', (request) => {
          if (request.url().includes('/api/storage/preview-stream?token=')) {
            previewRequests.push(request.url());
          }
        });
        await anonPage.goto(`/s/${viewToken}`);
        await expect(anonPage.getByTestId('shared-link-permission-level')).toHaveText(
          '表示のみ'
        );
        await expect(
          anonPage.getByRole('button', { name: 'ダウンロード' })
        ).toHaveCount(0);
        await anonPage.getByRole('button', { name: 'セキュアプレビュー' }).click();
        await expect
          .poll(() => previewRequests.length, {
            message: 'preview should use /api/storage/preview-stream',
          })
          .toBeGreaterThan(0);
        await expect(anonPage.getByText(fileName).first()).toBeVisible();
        await expect(
          anonPage.locator('.watermark-protected-viewport')
        ).toBeVisible();
      } finally {
        await anonContext.close();
      }

      // Back to the workspace: quick PATCH the view link to download, then
      // create a company-only edit link through the same popover.
      await editor.page.goto(`/workspace?folderId=${root.id}`);
      dialog = await openSharePopover(editor.page, fileName);
      const levelSelect = dialog.locator('select[id^="share-level-"]').first();
      await expect(levelSelect).toBeVisible();
      await expect(levelSelect).toHaveValue('view');
      await levelSelect.selectOption('download');
      await expect(levelSelect).toHaveValue('download');

      const editRadioAfterReload = dialog.getByRole('radio', {
        name: /表示 \+ DL \+ 編集 \(edit\)/,
      });
      await editRadioAfterReload.check();
      await expect(dialog.locator('#share-edit-warning')).toContainText(
        '認証済みユーザー限定'
      );
      await dialog.locator('#share-access-scope').selectOption('company_only');
      await dialog.getByRole('button', { name: 'リンクを発行' }).click();
      const editToken = await readGeneratedToken(dialog);
      await dialog.getByRole('button', { name: '閉じる' }).click();

      // Edit link landing exposes the elevated capabilities.
      await editor.page.goto(`/s/${editToken}`);
      await expect(editor.page.getByTestId('shared-link-permission-level')).toHaveText(
        '表示 + DL + 編集'
      );
      await expect(
        editor.page.getByTestId('shared-link-composed-access')
      ).toBeVisible();
      await expect(editor.page.getByTestId('shared-link-upload-zone')).toBeVisible();
    } finally {
      await setSharePolicy(admin, POLICY_DEFAULTS);
    }
  });

  test('Flow C: viewer は view のみ作成でき、edit リンク経由でアップロードできるが管理操作は不可', async ({
    as,
    cleanup,
    playwright,
    baseURL,
  }) => {
    const admin = await as('sys_admin');
    const viewer = await as('member');
    try {
      await setSharePolicy(admin, {
        allowSharedLinkEdit: true,
        allowViewerShareLinks: true,
        allowPublicEditLinks: false,
      });
      const root = await createIsolatedRoot(admin, cleanup, 'sll-c');
      const fileName = `${uniqueName('share-c')}.pdf`;
      const target = await uploadFile(admin, {
        folderId: root.id,
        name: fileName,
        content: '%PDF-1.4\nflow-c-version-1',
        mimeType: 'application/pdf',
      });
      // Root creation already grants the sys_admin owner access.
      await grantPermission(admin, {
        targetType: 'folder',
        targetId: root.id,
        granteeType: 'user',
        granteeId: DEV_USERS.member.id,
        role: 'viewer',
      });

      const editLinkRes = await admin.api.post('/api/shared-links', {
        data: {
          targetType: 'file',
          targetId: target.id,
          accessScope: 'company_only',
          permissionLevel: 'edit',
        },
      });
      expect(editLinkRes.status()).toBe(201);
      const editLink = (await editLinkRes.json()) as { token: string };

      await viewer.page.goto(`/workspace?folderId=${root.id}`);
      const dialog = await openSharePopover(viewer.page, fileName);
      await expect(
        dialog.locator('#share-viewer-view-only-banner')
      ).toBeVisible();
      const viewRadio = dialog.getByRole('radio', { name: /表示のみ \(view\)/ });
      const downloadRadio = dialog.getByRole('radio', {
        name: /表示 \+ ダウンロード \(download\)/,
      });
      const editRadio = dialog.getByRole('radio', {
        name: /表示 \+ DL \+ 編集 \(edit\)/,
      });
      await expect(viewRadio).toBeChecked();
      await expect(downloadRadio).toBeDisabled();
      await expect(editRadio).toBeDisabled();
      await dialog.getByRole('button', { name: 'リンクを発行' }).click();
      await readGeneratedToken(dialog);
      await dialog.getByRole('button', { name: '閉じる' }).click();

      // Viewer + edit link composes into upload/WOPI capabilities.
      await viewer.page.goto(`/s/${editLink.token}`);
      await expect(viewer.page.getByTestId('shared-link-permission-level')).toHaveText(
        '表示 + DL + 編集'
      );
      const composed = viewer.page.getByTestId('shared-link-composed-access');
      await expect(composed).toBeVisible();
      await expect(composed).toContainText('viewer_uploader');
      await expect(composed).toContainText('新規アップロード');
      await expect(composed).toContainText('上書き保存');
      await expect(composed).toContainText('WOPI編集');
      await expect(composed).toContainText('削除・権限・共有管理は不可');
      await expect(
        viewer.page.getByRole('button', { name: /削除|権限管理/ })
      ).toHaveCount(0);

      // Upload a new version through the shared-link landing UI.
      const updatedContent = '%PDF-1.4\nflow-c-version-2';
      await viewer.page.locator('#shared-link-upload-input').setInputFiles({
        name: fileName,
        mimeType: 'application/pdf',
        buffer: Buffer.from(updatedContent, 'utf8'),
      });
      await expect(
        viewer.page.getByRole('status').filter({ hasText: 'アップロードしました' })
      ).toBeVisible();
      const details = await getFileDetails(admin, target.id);
      expect(details.file.current_version_num).toBe(2);

      // Public anonymous editing is denied (policy is off and the link is company-only).
      const origin = baseURL ?? 'http://localhost:13000';
      const anonApi = await playwright.request.newContext({
        baseURL: origin,
        extraHTTPHeaders: { Origin: origin },
      });
      try {
        const anonUpload = await anonApi.post(
          `/api/s/${editLink.token}/upload-init`,
          {
            data: {
              fileName,
              mimeType: 'application/pdf',
              sizeBytes: 12,
              conflictPolicy: 'new_version',
            },
          }
        );
        expect([401, 403]).toContain(anonUpload.status());
        const anonError = (await anonUpload.json()) as { code?: string };
        expect(['AUTH_REQUIRED', 'AUTH_REQUIRED_FOR_EDIT']).toContain(
          anonError.code
        );

        const publicEdit = await admin.api.post('/api/shared-links', {
          data: {
            targetType: 'file',
            targetId: target.id,
            accessScope: 'public',
            permissionLevel: 'edit',
            password: 'PublicEdit1!',
            expiresInDays: 3,
          },
        });
        expect(publicEdit.status()).toBe(403);
        expect(((await publicEdit.json()) as { code?: string }).code).toBe(
          'PUBLIC_EDIT_LINK_DISABLED'
        );
      } finally {
        await anonApi.dispose();
      }
    } finally {
      await setSharePolicy(admin, POLICY_DEFAULTS);
    }
  });
});
