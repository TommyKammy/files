import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import {
  createFolder,
  findRootFolder,
  getFolderChildren,
  searchFiles,
  uploadFile,
  waitForFileInFolder,
  waitForRootFolder,
  waitForTrashFile,
} from './helpers/api';
import {
  uniqueName,
  waitForRealtimeConnected,
} from './helpers/browser';

function token(): string {
  return `e2e${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

async function expectWorkspaceRoot(page: import('@playwright/test').Page): Promise<void> {
  // The sidebar folder tree also exposes folder buttons; assertions are scoped
  // to <main> so they prove the workspace table rendered the roots.
  const workspace = page.getByRole('main');
  await expect(
    workspace.getByRole('button', { name: '全社共有', exact: true })
  ).toBeVisible();
  await expect(
    workspace.getByRole('button', { name: '機密プロジェクト', exact: true })
  ).toBeVisible();
}

async function uploadThroughFileChooser(
  page: import('@playwright/test').Page,
  payload: { name: string; mimeType: string; content: string }
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'ファイルを選択', exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: payload.name,
    mimeType: payload.mimeType,
    buffer: Buffer.from(payload.content, 'utf8'),
  });
}

test.describe('workspace baseline E2E', () => {
  test('開発ログインでワークスペースと全社共有ルートが表示される', async ({ page }) => {
    await page.goto('/workspace');

    await expect(
      page.getByRole('heading', { name: 'Files ワークスペースへサインイン' })
    ).toBeVisible();

    const devAccounts = await page.request.get('/auth/dev-accounts');
    expect(devAccounts.status()).toBe(200);
    const accountsBody = (await devAccounts.json()) as {
      enabled: boolean;
      accounts: Array<{ id: string; role: string }>;
    };
    expect(accountsBody.enabled).toBe(true);
    expect(accountsBody.accounts.map((account) => account.id).sort()).toEqual([
      'dev-admin-001',
      'dev-member-001',
      'dev-sec-001',
    ]);

    const sysAdminButton = page.getByRole('button', {
      name: /システム管理者 \(sys_admin\)/,
    });
    await expect(sysAdminButton).toBeVisible();
    await sysAdminButton.click();

    await expectWorkspaceRoot(page);
    await expect(page.getByText('Dev Admin', { exact: true })).toBeVisible();

    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const meBody = (await me.json()) as {
      user: { id: string; role: string; tenantId: string };
    };
    expect(meBody.user).toEqual({
      id: 'dev-admin-001',
      role: 'sys_admin',
      tenantId: 'tenant-default',
      email: 'dev-admin@example.com',
      displayName: 'Dev Admin',
      ipAddress: expect.any(String),
    });
  });

  test('一意フォルダ作成・小サイズファイルのアップロード・一覧/検索確認', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    await admin.page.goto('/workspace');
    await expectWorkspaceRoot(admin.page);

    const folderName = uniqueName('e2e-folder');
    const searchToken = token();
    const fileName = `${searchToken}.txt`;
    const content = `Files E2E upload ${randomUUID()}\n日本語本文も含む小サイズファイルです。\n`;

    await admin.page.getByRole('button', { name: '新規フォルダ', exact: true }).click();
    const dialog = admin.page.getByRole('dialog', { name: '新規フォルダを作成' });
    await expect(dialog).toBeVisible();
    await dialog.locator('#workspace-modal-name').fill(folderName);
    await dialog.locator('#workspace-modal-classification').selectOption('internal');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();

    const folder = await waitForRootFolder(admin, folderName);
    cleanup.registerFolder(folder.id);

    // Reload after the server-side create so the UI uses the persisted folder id,
    // not the optimistic temp id.
    await admin.page.reload();
    await expectWorkspaceRoot(admin.page);
    const folderRow = admin.page
      .getByRole('main')
      .getByRole('button', { name: folderName, exact: true });
    await expect(folderRow).toBeVisible();
    await folderRow.dblclick();

    await expect
      .poll(() => new URL(admin.page.url()).searchParams.get('folderId'))
      .toBe(folder.id);
    await expect(admin.page.getByText('実効ロール: owner')).toBeVisible();

    await uploadThroughFileChooser(admin.page, {
      name: fileName,
      mimeType: 'text/plain',
      content,
    });

    const uploaded = await waitForFileInFolder(admin, folder.id, fileName);
    expect(uploaded).not.toBeNull();
    expect(uploaded!.size_bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(uploaded!.classification).toBe('internal');
    expect(uploaded!.current_version_num).toBe(1);

    const fileRowButton = admin.page
      .getByRole('main')
      .getByRole('button', { name: fileName, exact: true });
    await expect(fileRowButton).toBeVisible();
    await expect(fileRowButton).toBeEnabled();

    const children = await getFolderChildren(admin, folder.id);
    expect(children.files.map((file) => file.name)).toContain(fileName);
    expect(children.files.find((file) => file.name === fileName)?.size_bytes).toBe(
      Buffer.byteLength(content, 'utf8')
    );

    const ftsResults = await searchFiles(admin, searchToken);
    expect(ftsResults.map((result) => result.id)).toContain(uploaded!.id);

    await admin.page.getByRole('button', { name: /横断検索/ }).click();
    const palette = admin.page.getByRole('dialog', { name: '横断検索' });
    await expect(palette).toBeVisible();
    await palette
      .getByRole('combobox', { name: 'ワークスペースを検索' })
      .fill(searchToken);
    const result = palette.getByRole('option').filter({ hasText: fileName });
    await expect(result).toBeVisible();
    await expect(result).toContainText(fileName);
    await palette.getByRole('button', { name: '検索を閉じる' }).click();
    await expect(palette).toBeHidden();
  });

  test('ファイルをゴミ箱へ移動し、ゴミ箱から復元できる', async ({ as, cleanup }) => {
    const admin = await as('sys_admin');
    const general = await findRootFolder(admin, '全社共有');
    const folderName = uniqueName('e2e-trash');
    const folder = await createFolder(admin, {
      parentId: general.id,
      name: folderName,
      classification: 'internal',
    });
    cleanup.registerFolder(folder.id);

    const fileName = `${token()}.txt`;
    const content = `trash and restore ${randomUUID()}\n`;
    const uploaded = await uploadFile(admin, {
      folderId: folder.id,
      name: fileName,
      content,
    });
    expect(uploaded.folder_id).toBe(folder.id);

    await admin.page.goto(`/workspace?folderId=${encodeURIComponent(folder.id)}`);
    await expect(
      admin.page.getByRole('main').getByRole('button', {
        name: fileName,
        exact: true,
      })
    ).toBeEnabled();

    await admin.page
      .getByRole('checkbox', { name: `${fileName} を選択` })
      .click();
    const selectionBar = admin.page.getByRole('toolbar', { name: '一括操作' });
    await expect(selectionBar).toBeVisible();
    await expect(selectionBar.getByText('1 件選択中')).toBeVisible();
    await selectionBar.getByRole('button', { name: 'ゴミ箱', exact: true }).click();

    await waitForTrashFile(admin, fileName, { present: true });
    await waitForFileInFolder(admin, folder.id, fileName, { present: false });

    await admin.page.getByRole('link', { name: 'ゴミ箱', exact: true }).click();
    await expect(
      admin.page.getByRole('heading', { name: 'ゴミ箱', exact: true })
    ).toBeVisible();
    const trashRow = admin.page.getByRole('row').filter({ hasText: fileName });
    await expect(trashRow).toBeVisible();
    await expect(trashRow.getByRole('button', { name: '復元', exact: true })).toBeVisible();
    await trashRow.getByRole('button', { name: '復元', exact: true }).click();

    await waitForFileInFolder(admin, folder.id, fileName, { present: true });
    await waitForTrashFile(admin, fileName, { present: false });
    await expect(trashRow).toHaveCount(0);

    await admin.page.goto(`/workspace?folderId=${encodeURIComponent(folder.id)}`);
    const restoredRow = admin.page
      .getByRole('main')
      .getByRole('button', { name: fileName, exact: true });
    await expect(restoredRow).toBeEnabled();
    await expect(restoredRow).toHaveText(fileName);
  });

  test('sys_admin/sec_admin は /admin にアクセスでき、member は 403 で拒否される', async ({
    as,
  }) => {
    const admin = await as('sys_admin');
    const secAdmin = await as('sec_admin');
    const member = await as('member');

    for (const session of [admin, secAdmin]) {
      await session.page.goto('/admin');
      await expect(
        session.page.getByRole('heading', {
          name: 'ガバナンス & セキュリティ統合ダッシュボード',
        })
      ).toBeVisible();
      await expect(
        session.page.getByRole('link', { name: 'ガバナンス', exact: true })
      ).toBeVisible();

      const stats = await session.api.get('/api/admin/storage-stats');
      expect(stats.status()).toBe(200);
    }

    await member.page.goto('/admin');
    await expect(
      member.page.getByText('アクセス権限がありません (403)')
    ).toBeVisible();
    await expect(
      member.page.getByRole('heading', {
        name: 'ガバナンス & セキュリティ統合ダッシュボード',
      })
    ).toHaveCount(0);
    await expect(
      member.page.getByRole('link', { name: 'ガバナンス', exact: true })
    ).toHaveCount(0);

    const forbidden = await member.api.get('/api/admin/storage-stats');
    expect(forbidden.status()).toBe(403);

    await member.page.goto('/workspace');
    const memberWorkspace = member.page.getByRole('main');
    await expect(
      memberWorkspace.getByRole('button', { name: '全社共有', exact: true })
    ).toBeVisible();
    // member must not see the confidential root (seed grants it to sys_admin only).
    await expect(
      memberWorkspace.getByRole('button', {
        name: '機密プロジェクト',
        exact: true,
      })
    ).toHaveCount(0);
    await expect(
      member.page.getByRole('link', { name: 'ガバナンス', exact: true })
    ).toHaveCount(0);
  });

  test('2 ブラウザコンテキスト間で TenantSyncHub WebSocket によりアップロードが同期される', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    const general = await findRootFolder(admin, '全社共有');
    const folder = await createFolder(admin, {
      parentId: general.id,
      name: uniqueName('e2e-sync'),
      classification: 'internal',
    });
    cleanup.registerFolder(folder.id);

    const initialFile = `${token()}.txt`;
    await uploadFile(admin, {
      folderId: folder.id,
      name: initialFile,
      content: `initial content ${randomUUID()}\n`,
    });

    const folderUrl = `/workspace?folderId=${encodeURIComponent(folder.id)}`;
    await Promise.all([
      admin.page.goto(folderUrl),
      member.page.goto(folderUrl),
    ]);

    await expect(
      admin.page.getByRole('main').getByRole('button', {
        name: initialFile,
        exact: true,
      })
    ).toBeEnabled();
    await expect(
      member.page.getByRole('main').getByRole('button', {
        name: initialFile,
        exact: true,
      })
    ).toBeEnabled();
    await expect(member.page.getByText('実効ロール: editor')).toBeVisible();

    await Promise.all([
      waitForRealtimeConnected(admin.page),
      waitForRealtimeConnected(member.page),
    ]);

    const syncedFile = `${token()}.txt`;
    const syncedContent = `realtime propagated ${randomUUID()}\n`;
    await uploadThroughFileChooser(admin.page, {
      name: syncedFile,
      mimeType: 'text/plain',
      content: syncedContent,
    });

    await waitForFileInFolder(admin, folder.id, syncedFile, { present: true });
    await expect(
      admin.page.getByRole('main').getByRole('button', {
        name: syncedFile,
        exact: true,
      })
    ).toBeEnabled();

    // No reload / navigation is performed on the member page: this row can only
    // appear through the TenantSyncHub invalidation + delta reconcile path.
    await expect(
      member.page.getByRole('main').getByRole('button', {
        name: syncedFile,
        exact: true,
      })
    ).toBeEnabled({ timeout: 20_000 });
    await expect
      .poll(() => new URL(member.page.url()).searchParams.get('folderId'))
      .toBe(folder.id);
  });
});
