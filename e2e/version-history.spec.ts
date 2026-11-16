import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  acquireDriveLock,
  createFolder,
  getFileDetails,
  grantPermission,
  releaseDriveLock,
  uploadFile,
  type ApiActor,
} from './helpers/api';
import { uniqueName, waitForRealtimeConnected } from './helpers/browser';

function token(): string {
  return `vh${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

/** Exact byte lengths make the version size assertions unambiguous. */
function versionContent(version: 1 | 2): string {
  return version === 1
    ? `V1-${'A'.repeat(117)}`
    : `V2-${'B'.repeat(57)}`;
}

const V1_BYTES = 120;
const V2_BYTES = 60;

async function createVersionedFile(
  admin: ApiActor,
  folderId: string,
  fileName: string
): Promise<{ fileId: string; v1Content: string; v2Content: string }> {
  const v1Content = versionContent(1);
  const v2Content = versionContent(2);
  const v1 = await uploadFile(admin, {
    folderId,
    name: fileName,
    content: v1Content,
  });
  expect(v1.current_version_num).toBe(1);
  const v2 = await uploadFile(admin, {
    folderId,
    name: fileName,
    content: v2Content,
    conflictPolicy: 'new_version',
  });
  expect(v2.id).toBe(v1.id);
  const detail = await getFileDetails(admin, v1.id);
  expect(detail.file.current_version_num).toBe(2);
  expect(detail.versions.map((version) => version.version_num)).toEqual([
    2, 1,
  ]);
  return { fileId: v1.id, v1Content, v2Content };
}

async function waitForFileRow(page: Page, fileName: string) {
  const row = page.getByRole('row').filter({ hasText: fileName });
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function openVersionHistoryFromContextMenu(
  page: Page,
  fileName: string
): Promise<void> {
  const row = await waitForFileRow(page, fileName);
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'コンテキストメニュー' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '詳細', exact: true }).hover();
  const submenu = page.getByRole('menu', { name: '詳細 サブメニュー' });
  await expect(submenu).toBeVisible();
  await submenu
    .getByRole('menuitem', { name: '版履歴', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: `版履歴: ${fileName}` })
  ).toBeVisible();
}

async function openInspectorFromContextMenu(
  page: Page,
  fileName: string
): Promise<void> {
  const row = await waitForFileRow(page, fileName);
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'コンテキストメニュー' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '詳細', exact: true }).hover();
  const submenu = page.getByRole('menu', { name: '詳細 サブメニュー' });
  await submenu
    .getByRole('menuitem', { name: '詳細インスペクタ', exact: true })
    .click();
  await expect(page.locator('aside[aria-label="詳細インスペクタ"]')).toBeVisible();
}

test.describe('version history E2E', () => {
  test('コンテキストメニューと詳細インスペクタから版履歴を開き、過去版を実データでプレビューする', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const fileName = `${token()}.txt`;
    const folder = await createFolder(admin, {
      parentId: null,
      name: uniqueName('e2e-version-history'),
      classification: 'internal',
    });
    cleanup.registerFolder(folder.id);
    const { v1Content } = await createVersionedFile(admin, folder.id, fileName);

    await admin.page.goto(`/workspace?folderId=${encodeURIComponent(folder.id)}`);
    const row = await waitForFileRow(admin.page, fileName);
    await expect(row.getByText('v2', { exact: true })).toBeVisible();

    // Entry point 1: 詳細インスペクタ → 「版履歴を開く」
    await openInspectorFromContextMenu(admin.page, fileName);
    const inspector = admin.page.locator('aside[aria-label="詳細インスペクタ"]');
    await expect(inspector.getByText(/v2 \(meta #\d+\)/)).toBeVisible();
    await inspector.getByTestId('inspector-open-version-history').click();

    let dialog = admin.page.getByRole('dialog', {
      name: `版履歴: ${fileName}`,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('version-row-2')).toBeVisible();
    await expect(dialog.getByTestId('version-row-1')).toBeVisible();

    // Newest first: v2 (current) then v1, each with size/author/date.
    const versionRows = dialog.locator('[data-testid^="version-row-"]');
    await expect(versionRows).toHaveCount(2);
    await expect(versionRows.nth(0)).toHaveAttribute('data-version-num', '2');
    await expect(versionRows.nth(1)).toHaveAttribute('data-version-num', '1');
    await expect(dialog.getByTestId('version-current-2')).toHaveText('現在版');
    await expect(dialog.getByTestId('version-current-1')).toHaveCount(0);
    await expect(
      dialog.getByTestId('version-row-2').getByText(`${V2_BYTES} B`, {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      dialog.getByTestId('version-row-1').getByText(`${V1_BYTES} B`, {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      dialog.getByTestId('version-row-1').getByText('作成者: Dev Admin')
    ).toBeVisible();
    await expect(
      dialog.getByTestId('version-row-1').getByText(/\d{4}\/\d{2}\/\d{2}/)
    ).toBeVisible();
    await expect(
      dialog.getByTestId('version-row-1').getByText('完了', { exact: true })
    ).toBeVisible();

    // Modal keyboard scope must swallow workspace single-key shortcuts.
    await admin.page.keyboard.press('Delete');
    await expect(dialog).toBeVisible();
    await expect(
      admin.page.getByRole('row').filter({ hasText: fileName })
    ).toBeVisible();

    // Escape closes the modal and returns focus to the inspector trigger.
    await admin.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(
      inspector.getByTestId('inspector-open-version-history')
    ).toBeFocused();

    // Entry point 2: コンテキストメニュー → 詳細 → 版履歴
    await openVersionHistoryFromContextMenu(admin.page, fileName);
    dialog = admin.page.getByRole('dialog', { name: `版履歴: ${fileName}` });
    await expect(dialog.getByTestId('version-row-2')).toBeVisible();

    // Historical version preview uses the v1 content-url, not the current one.
    await dialog.getByTestId('version-preview-1').click();
    const preview = admin.page.getByRole('dialog', {
      name: `プレビュー: ${fileName}`,
    });
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('preview-version-label')).toHaveText(
      'v1 (過去版)'
    );
    await expect(preview.getByText(v1Content, { exact: true })).toBeVisible();
    await expect(preview.getByTestId('preview-version-label')).toBeVisible();

    await preview.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(dialog).toBeVisible();

    await admin.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('過去版を復元すると v3 が現在版になり、一覧・インスペクタ・別タブへ即時反映される', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(120_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const fileName = `${token()}.txt`;
    const folder = await createFolder(admin, {
      parentId: null,
      name: uniqueName('e2e-version-restore'),
      classification: 'internal',
    });
    cleanup.registerFolder(folder.id);
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: folder.id,
      granteeType: 'user',
      granteeId: member.user.id,
      role: 'editor',
    });
    const { fileId, v1Content } = await createVersionedFile(
      admin,
      folder.id,
      fileName
    );
    void fileId;

    const folderUrl = `/workspace?folderId=${encodeURIComponent(folder.id)}`;

    // Second BrowserContext (member) observes TenantSyncHub without reloading.
    await member.page.goto(folderUrl);
    await waitForRealtimeConnected(member.page);
    const memberRow = await waitForFileRow(member.page, fileName);
    await expect(memberRow.getByText('v2', { exact: true })).toBeVisible();
    await expect(
      memberRow.getByText(`${V2_BYTES} B`, { exact: true })
    ).toBeVisible();

    await admin.page.goto(folderUrl);
    await waitForRealtimeConnected(admin.page);
    const adminRow = await waitForFileRow(admin.page, fileName);

    // Open inspector first so we can prove its version/size refresh in place.
    await openInspectorFromContextMenu(admin.page, fileName);
    const inspector = admin.page.locator('aside[aria-label="詳細インスペクタ"]');
    await expect(inspector.getByText(/v2 \(meta #\d+\)/)).toBeVisible();
    await expect(
      inspector.getByText(`${V2_BYTES} B`, { exact: true })
    ).toBeVisible();
    await inspector.getByTestId('inspector-open-version-history').click();

    const dialog = admin.page.getByRole('dialog', {
      name: `版履歴: ${fileName}`,
    });
    await expect(dialog.getByTestId('version-restore-1')).toBeVisible();
    await expect(dialog.getByTestId('version-restore-2')).toHaveCount(0);
    await dialog.getByTestId('version-restore-1').click();

    const confirm = admin.page.getByRole('dialog', {
      name: 'バージョンの復元確認',
    });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText('復元元', { exact: true })).toBeVisible();
    await expect(confirm.getByText('v1', { exact: true }).first()).toBeVisible();
    await expect(
      confirm.getByText('現在のバージョン', { exact: true })
    ).toBeVisible();
    await expect(confirm.getByText('v2', { exact: true }).first()).toBeVisible();
    await expect(
      confirm.getByText('復元後の新しい現在版')
    ).toBeVisible();
    await expect(confirm.getByText('v3', { exact: true }).first()).toBeVisible();
    await expect(
      confirm.getByText(/削除されません/)
    ).toBeVisible();
    await expect(
      confirm.getByRole('button', { name: 'キャンセル' })
    ).toBeFocused();
    const confirmButton = confirm.getByTestId('version-restore-confirm');
    await expect(confirmButton).toHaveText('v1 に戻す');

    await confirmButton.click();
    await expect(confirm).toBeHidden();

    // Version list re-fetched from the API: v3 (current), v2, v1.
    await expect(dialog.getByTestId('version-row-3')).toBeVisible({
      timeout: 30_000,
    });
    const restoredRows = dialog.locator('[data-testid^="version-row-"]');
    await expect(restoredRows).toHaveCount(3);
    await expect(restoredRows.nth(0)).toHaveAttribute('data-version-num', '3');
    await expect(restoredRows.nth(1)).toHaveAttribute('data-version-num', '2');
    await expect(restoredRows.nth(2)).toHaveAttribute('data-version-num', '1');
    await expect(dialog.getByTestId('version-current-3')).toHaveText('現在版');
    await expect(dialog.getByTestId('version-current-2')).toHaveCount(0);
    await expect(
      dialog.getByTestId('version-row-3').getByText(`${V1_BYTES} B`, {
        exact: true,
      })
    ).toBeVisible();
    await expect(dialog.getByTestId('version-comment-3')).toHaveText(
      'v1 から復元'
    );

    // Close the history dialog; toast is visible once the native top layer is gone.
    await admin.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(
      admin.page.getByText(
        `v1 を復元しました。v3 として現在版を更新しました。`,
        { exact: true }
      )
    ).toBeVisible();

    // Inspector updated without reopening it.
    await expect(inspector).toBeVisible();
    await expect(inspector.getByText(/v3 \(meta #\d+\)/)).toBeVisible();
    await expect(
      inspector.getByText(`${V1_BYTES} B`, { exact: true })
    ).toBeVisible();

    // Workspace list updated without reload.
    await expect(adminRow.getByText('v3', { exact: true })).toBeVisible();
    await expect(
      adminRow.getByText(`${V1_BYTES} B`, { exact: true })
    ).toBeVisible();

    // Other browser context receives file.version_restored over TenantSyncHub.
    const memberRowAfter = member.page
      .getByRole('row')
      .filter({ hasText: fileName });
    await expect(memberRowAfter.getByText('v3', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      memberRowAfter.getByText(`${V1_BYTES} B`, { exact: true })
    ).toBeVisible();

    // The restored bytes are the historical v1 payload on the server.
    const detail = await getFileDetails(admin, fileId);
    expect(detail.file.current_version_num).toBe(3);
    expect(detail.file.size_bytes).toBe(V1_BYTES);
    expect(detail.file.updated_at).toBeTruthy();
    const expectedUpdatedLabel = new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Tokyo',
    }).format(new Date(detail.file.updated_at!));
    await expect(
      inspector.getByText(expectedUpdatedLabel, { exact: true })
    ).toBeVisible();
    const versions = await admin.api.get(
      `/api/files/${encodeURIComponent(fileId)}/versions?limit=10`
    );
    expect(versions.ok()).toBe(true);
    const body = (await versions.json()) as {
      versions: Array<{ versionNum: number; sizeBytes: number }>;
    };
    expect(body.versions.map((version) => version.versionNum)).toEqual([
      3, 2, 1,
    ]);
    expect(body.versions[0]?.sizeBytes).toBe(V1_BYTES);
    expect(v1Content.length).toBe(V1_BYTES);
  });

  test('viewer は復元不可でDL可、previewer はDL不可かつ confidential 過去版に透かしが出る', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(120_000);
    const admin = await as('sys_admin');
    const member = await as('member');

    // viewer folder (internal)
    const viewerFileName = `${token()}-viewer.txt`;
    const viewerFolder = await createFolder(admin, {
      parentId: null,
      name: uniqueName('e2e-version-viewer'),
      classification: 'internal',
    });
    cleanup.registerFolder(viewerFolder.id);
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: viewerFolder.id,
      granteeType: 'user',
      granteeId: member.user.id,
      role: 'viewer',
    });
    await createVersionedFile(admin, viewerFolder.id, viewerFileName);

    await member.page.goto(
      `/workspace?folderId=${encodeURIComponent(viewerFolder.id)}`
    );
    await waitForFileRow(member.page, viewerFileName);
    await openVersionHistoryFromContextMenu(member.page, viewerFileName);
    let dialog = member.page.getByRole('dialog', {
      name: `版履歴: ${viewerFileName}`,
    });
    await expect(dialog.getByTestId('version-row-2')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'このバージョンに戻す' })
    ).toHaveCount(0);
    await expect(dialog.getByTestId('version-download-1')).toBeEnabled();
    await expect(dialog.getByTestId('version-download-1')).toHaveText(
      'ダウンロード'
    );
    await member.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // previewer folder (confidential)
    const previewerFileName = `${token()}-previewer.txt`;
    const previewerFolder = await createFolder(admin, {
      parentId: null,
      name: uniqueName('e2e-version-previewer'),
      classification: 'confidential',
    });
    cleanup.registerFolder(previewerFolder.id);
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: previewerFolder.id,
      granteeType: 'user',
      granteeId: member.user.id,
      role: 'previewer',
    });
    const { v1Content } = await createVersionedFile(
      admin,
      previewerFolder.id,
      previewerFileName
    );

    await member.page.goto(
      `/workspace?folderId=${encodeURIComponent(previewerFolder.id)}`
    );
    await waitForFileRow(member.page, previewerFileName);
    await openVersionHistoryFromContextMenu(member.page, previewerFileName);
    dialog = member.page.getByRole('dialog', {
      name: `版履歴: ${previewerFileName}`,
    });
    await expect(dialog.getByTestId('version-row-2')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'このバージョンに戻す' })
    ).toHaveCount(0);
    await expect(dialog.getByTestId('version-download-1')).toBeDisabled();
    await expect(dialog.getByTestId('version-download-1')).toHaveText(
      'ダウンロード不可'
    );
    await expect(
      dialog.getByText(/Previewer 権限のためダウンロードはできません/)
    ).toBeVisible();

    await dialog.getByTestId('version-preview-1').click();
    const preview = member.page.getByRole('dialog', {
      name: `プレビュー: ${previewerFileName}`,
    });
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('preview-version-label')).toHaveText(
      'v1 (過去版)'
    );
    await expect(preview.getByText(v1Content, { exact: true })).toBeVisible();
    const watermark = preview.locator('.watermark-protected-viewport');
    await expect(watermark).toBeVisible();
    await expect(
      watermark.getByText(/dev-member@example\.com/).first()
    ).toBeVisible();
    await expect(
      preview.getByRole('button', { name: 'ダウンロード', exact: true })
    ).toHaveCount(0);

    await preview.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(preview).toBeHidden();
    await member.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('desktop_exclusive ロック中の復元は FILE_LOCKED となりロック保有者を表示する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(120_000);
    const admin = await as('sys_admin');
    const fileName = `${token()}-locked.txt`;
    const folder = await createFolder(admin, {
      parentId: null,
      name: uniqueName('e2e-version-locked'),
      classification: 'internal',
    });
    cleanup.registerFolder(folder.id);
    const { fileId } = await createVersionedFile(
      admin,
      folder.id,
      fileName
    );

    await admin.page.goto(`/workspace?folderId=${encodeURIComponent(folder.id)}`);
    await waitForFileRow(admin.page, fileName);
    await openVersionHistoryFromContextMenu(admin.page, fileName);
    const dialog = admin.page.getByRole('dialog', {
      name: `版履歴: ${fileName}`,
    });
    await expect(dialog.getByTestId('version-row-2')).toBeVisible();

    const lockId = `e2e-lock-${token()}`;
    await acquireDriveLock(admin, fileId, { lockId, ttlSeconds: 300 });
    try {
      await dialog.getByTestId('version-restore-1').click();
      const confirm = admin.page.getByRole('dialog', {
        name: 'バージョンの復元確認',
      });
      await expect(confirm).toBeVisible();
      await confirm.getByTestId('version-restore-confirm').click();

      const banner = confirm.getByTestId('version-restore-error');
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(banner).toContainText(
        'ファイルが編集中のため復元できませんでした'
      );
      const lockOwner = confirm.getByTestId('version-lock-owner');
      await expect(lockOwner).toContainText('ロック保有者: Dev Admin');
      await expect(lockOwner).toContainText('dev-admin@example.com');
      await expect(lockOwner).toContainText('Files Drive 排他ロック');
      await expect(confirm.getByTestId('version-restore-confirm')).toBeEnabled();

      await confirm.getByRole('button', { name: 'キャンセル' }).click();
      await expect(confirm).toBeHidden();
      await expect(dialog.getByTestId('version-restore-1')).toBeFocused();

      // History was re-synchronized: still v2 current, v1 restorable.
      await expect(dialog.getByTestId('version-current-2')).toHaveText('現在版');
      await expect(dialog.getByTestId('version-restore-1')).toBeVisible();
    } finally {
      await releaseDriveLock(admin, fileId, lockId);
    }

    await admin.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
