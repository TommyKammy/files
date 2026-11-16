import { randomUUID } from 'node:crypto';
import { DEV_USERS, expect, test } from './fixtures';
import {
  createFolder,
  findRootFolder,
  softDeleteFile,
  softDeleteFolder,
  uploadFile,
} from './helpers/api';
import { uniqueName, waitForRealtimeConnected } from './helpers/browser';

function trashRegion(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: '管理者ゴミ箱一覧' });
}

function timelineRegion(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: '復元・完全削除監査タイムライン' });
}

async function searchAdminTrash(
  page: import('@playwright/test').Page,
  query: string
): Promise<void> {
  const search = page.getByLabel('管理者ゴミ箱を検索');
  await search.fill(query);
  await search.press('Enter');
}

test.describe('Admin tenant Trash UI (TOM-51)', () => {
  test('sec_admin が他ユーザーの削除済みファイル/フォルダを代理復元し、所有者の画面と監査タイムラインへ即時反映する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(240_000);
    const member = await as('member');
    const secAdmin = await as('sec_admin');
    const general = await findRootFolder(member, '全社共有');

    const prefix = uniqueName('e2e-admin-trash');
    const parentName = `${prefix}-parent`;
    const folderName = `${prefix}-folder`;
    const fileName = `${prefix}-file.txt`;
    const anchorName = `${prefix}-anchor.txt`;
    const content = `admin trash delegated restore ${randomUUID()}\n`;

    const parent = await createFolder(member, {
      parentId: general.id,
      name: parentName,
      classification: 'internal',
    });
    cleanup.registerFolder(parent.id);
    const file = await uploadFile(member, {
      folderId: parent.id,
      name: fileName,
      content,
    });
    await uploadFile(member, {
      folderId: parent.id,
      name: anchorName,
      content: `anchor ${randomUUID()}\n`,
    });
    const folder = await createFolder(member, {
      parentId: parent.id,
      name: folderName,
      classification: 'internal',
    });

    await softDeleteFile(member, file.id);
    await softDeleteFolder(member, folder.id);

    // Keep the owner's workspace open on the parent folder so the assertion
    // proves realtime delivery, not a navigation refresh.
    await member.page.goto(
      `/workspace?folderId=${encodeURIComponent(parent.id)}`
    );
    await expect(
      member.page
        .getByRole('main')
        .getByRole('button', { name: anchorName, exact: true })
    ).toBeVisible();
    await waitForRealtimeConnected(member.page);
    await expect(
      member.page
        .getByRole('main')
        .getByRole('button', { name: fileName, exact: true })
    ).toHaveCount(0);
    await expect(
      member.page
        .getByRole('main')
        .getByRole('button', { name: folderName, exact: true })
    ).toHaveCount(0);

    await secAdmin.page.goto('/admin');
    await expect(
      secAdmin.page.getByRole('heading', {
        name: 'ガバナンス & セキュリティ統合ダッシュボード',
      })
    ).toBeVisible();
    await expect(
      secAdmin.page.getByRole('heading', { name: 'ゴミ箱管理', exact: true })
    ).toBeVisible();
    await expect(
      secAdmin.page.getByText(
        /完全削除・空にする操作は sys_admin のみ許可されています/,
      )
    ).toBeVisible();
    await expect(
      secAdmin.page.getByRole('button', {
        name: 'テナント全体のゴミ箱を空にする',
      })
    ).toHaveCount(0);

    await searchAdminTrash(secAdmin.page, prefix);

    const region = trashRegion(secAdmin.page);
    const fileRow = region.getByRole('row').filter({ hasText: fileName });
    const folderRow = region.getByRole('row').filter({ hasText: folderName });
    await expect(fileRow).toBeVisible();
    await expect(folderRow).toBeVisible();
    await expect(fileRow).toContainText('Dev Member');
    await expect(fileRow).toContainText('ファイル');
    await expect(folderRow).toContainText('フォルダ');
    await expect(fileRow).toContainText(parentName);

    await fileRow.getByRole('button', { name: /代理復元/ }).click();
    const restoreDialog = secAdmin.page.getByRole('dialog', {
      name: '代理復元の確認',
    });
    await expect(restoreDialog).toBeVisible();
    await expect(restoreDialog).toContainText(fileName);
    await expect(restoreDialog).toContainText('Dev Member');
    await restoreDialog.getByRole('button', { name: '復元を実行' }).click();
    await expect(restoreDialog).toBeHidden();

    await expect(
      member.page
        .getByRole('main')
        .getByRole('button', { name: fileName, exact: true })
    ).toBeVisible({ timeout: 30_000 });

    await folderRow.getByRole('button', { name: /代理復元/ }).click();
    const folderRestoreDialog = secAdmin.page.getByRole('dialog', {
      name: '代理復元の確認',
    });
    await expect(folderRestoreDialog).toBeVisible();
    await expect(folderRestoreDialog).toContainText(folderName);
    await folderRestoreDialog
      .getByRole('button', { name: '復元を実行' })
      .click();
    await expect(folderRestoreDialog).toBeHidden();

    await expect(
      member.page
        .getByRole('main')
        .getByRole('button', { name: folderName, exact: true })
    ).toBeVisible({ timeout: 30_000 });

    const timeline = timelineRegion(secAdmin.page);
    const fileAudit = timeline
      .getByRole('row')
      .filter({ hasText: fileName })
      .filter({ hasText: '管理者代理: ファイル復元' });
    await expect(fileAudit).toBeVisible({ timeout: 30_000 });
    await expect(fileAudit).toContainText('Dev Member');
    await expect(fileAudit).toContainText('v1');
    await expect(fileAudit).toContainText(parentName);

    const folderAudit = timeline
      .getByRole('row')
      .filter({ hasText: folderName })
      .filter({ hasText: '管理者代理: フォルダ復元' });
    await expect(folderAudit).toBeVisible({ timeout: 30_000 });
    await expect(folderAudit).toContainText('Dev Member');

    const auditResponse = await secAdmin.api.get(
      `/api/audit-logs?actions=admin.file.restore&targetId=${encodeURIComponent(file.id)}`
    );
    expect(auditResponse.status()).toBe(200);
    const auditBody = (await auditResponse.json()) as {
      logs: Array<{
        action: string;
        actorEmail: string | null;
        metadata: Record<string, unknown> | null;
      }>;
    };
    expect(auditBody.logs).toHaveLength(1);
    expect(auditBody.logs[0]).toMatchObject({
      action: 'admin.file.restore',
      actorEmail: DEV_USERS.sec_admin.email,
    });
    expect(auditBody.logs[0].metadata).toMatchObject({
      targetName: fileName,
      onBehalfOfUserId: DEV_USERS.member.id,
      ownerId: DEV_USERS.member.id,
      sourceVersion: 1,
      targetParentId: parent.id,
    });

    const memberFile = await member.api.get(
      `/api/files/${encodeURIComponent(file.id)}`
    );
    expect(memberFile.status()).toBe(200);
    const memberFileBody = (await memberFile.json()) as {
      file: { deleted_at: string | null; folder_id: string | null };
    };
    expect(memberFileBody.file.deleted_at).toBeNull();
    expect(memberFileBody.file.folder_id).toBe(parent.id);
  });

  test('sec_admin は空にする操作が制限され、sys_admin は確認文字列を経てテナント全体を空にし監査に残す', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(240_000);
    const member = await as('member');
    const secAdmin = await as('sec_admin');
    const sysAdmin = await as('sys_admin');
    const general = await findRootFolder(member, '全社共有');

    const prefix = uniqueName('e2e-admin-trash-empty');
    const parentName = `${prefix}-parent`;
    const fileName = `${prefix}-delete-me.txt`;

    const parent = await createFolder(member, {
      parentId: general.id,
      name: parentName,
      classification: 'internal',
    });
    cleanup.registerFolder(parent.id);
    const file = await uploadFile(member, {
      folderId: parent.id,
      name: fileName,
      content: `tenant empty fixture ${randomUUID()}\n`,
    });
    await softDeleteFile(member, file.id);

    await secAdmin.page.goto('/admin');
    await expect(
      secAdmin.page.getByRole('heading', { name: 'ゴミ箱管理', exact: true })
    ).toBeVisible();
    await searchAdminTrash(secAdmin.page, prefix);
    const secRegion = trashRegion(secAdmin.page);
    await expect(
      secRegion.getByRole('row').filter({ hasText: fileName })
    ).toBeVisible();
    await expect(
      secAdmin.page.getByText(
        /完全削除・空にする操作は sys_admin のみ許可されています/
      )
    ).toBeVisible();
    await expect(
      secAdmin.page.getByRole('button', {
        name: 'テナント全体のゴミ箱を空にする',
      })
    ).toHaveCount(0);

    const forbiddenEmpty = await secAdmin.api.post('/api/admin/trash/empty', {
      data: { confirm: 'EMPTY_TENANT_TRASH' },
    });
    expect(forbiddenEmpty.status()).toBe(403);
    expect((await forbiddenEmpty.json()) as { code?: string }).toMatchObject({
      code: 'FORBIDDEN',
    });
    const forbiddenDelete = await secAdmin.api.delete(
      '/api/admin/trash/items',
      { data: { items: [{ type: 'file', id: file.id }] } }
    );
    expect(forbiddenDelete.status()).toBe(403);

    await sysAdmin.page.goto('/admin');
    await expect(
      sysAdmin.page.getByRole('heading', { name: 'ゴミ箱管理', exact: true })
    ).toBeVisible();
    await searchAdminTrash(sysAdmin.page, prefix);
    await expect(
      trashRegion(sysAdmin.page)
        .getByRole('row')
        .filter({ hasText: fileName })
    ).toBeVisible();

    const emptyButton = sysAdmin.page.getByRole('button', {
      name: 'テナント全体のゴミ箱を空にする',
    });
    await expect(emptyButton).toBeVisible();
    await emptyButton.click();

    const emptyDialog = sysAdmin.page.getByRole('dialog', {
      name: 'テナント全体のゴミ箱を空にする',
    });
    await expect(emptyDialog).toBeVisible();
    const confirmButton = emptyDialog.getByRole('button', {
      name: '空にする',
      exact: true,
    });
    await expect(confirmButton).toBeDisabled();
    const confirmInput = emptyDialog.getByLabel('確認文字列');
    await confirmInput.fill('EMPTY_TRASH');
    await expect(confirmButton).toBeDisabled();
    await confirmInput.fill('EMPTY_TENANT_TRASH');
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(emptyDialog).toBeHidden({ timeout: 60_000 });

    await expect(
      sysAdmin.page.getByText(/テナント全体のゴミ箱を空にする: 成功/)
    ).toBeVisible({ timeout: 30_000 });

    await searchAdminTrash(sysAdmin.page, '');
    await expect(
      sysAdmin.page.getByText('ゴミ箱は空です', { exact: true })
    ).toBeVisible({ timeout: 30_000 });

    const timeline = timelineRegion(sysAdmin.page);
    await expect(
      timeline
        .getByRole('row')
        .filter({ hasText: 'テナントゴミ箱を空にする' })
    ).toBeVisible({ timeout: 30_000 });

    const auditResponse = await sysAdmin.api.get(
      '/api/audit-logs?actions=admin.trash.empty&limit=200'
    );
    expect(auditResponse.status()).toBe(200);
    const auditBody = (await auditResponse.json()) as {
      logs: Array<{
        action: string;
        actorEmail: string | null;
        metadata: Record<string, unknown> | null;
      }>;
    };
    const emptyAudit = auditBody.logs.find(
      (log) => log.action === 'admin.trash.empty'
    );
    expect(emptyAudit).toBeTruthy();
    expect(emptyAudit?.actorEmail).toBe(DEV_USERS.sys_admin.email);
    expect(emptyAudit?.metadata).toMatchObject({
      deletedCount: expect.any(Number),
      skippedCount: expect.any(Number),
      failedCount: expect.any(Number),
    });
    expect(
      Number((emptyAudit?.metadata as { deletedCount?: number })?.deletedCount)
    ).toBeGreaterThanOrEqual(1);

    const purged = await sysAdmin.api.get(
      `/api/files/${encodeURIComponent(file.id)}`
    );
    expect(purged.status()).toBe(404);
  });
});
