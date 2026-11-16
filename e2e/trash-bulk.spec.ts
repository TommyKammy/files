import { randomUUID } from 'node:crypto';
import { DEV_USERS, expect, test } from './fixtures';
import {
  createFolder,
  findRootFolder,
  getFolderChildren,
  grantPermission,
  softDeleteFile,
  softDeleteFolder,
  uploadFile,
  waitForFileInFolder,
  waitForTrashFile,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

async function openTrashFiltered(
  page: import('@playwright/test').Page,
  query: string
): Promise<void> {
  await page.goto('/workspace?view=trash');
  await expect(
    page.getByRole('heading', { name: 'ゴミ箱', exact: true })
  ).toBeVisible();
  const search = page.getByLabel('ゴミ箱を検索');
  await search.fill(query);
  await search.press('Enter');
}

function trashRow(
  page: import('@playwright/test').Page,
  name: string
): import('@playwright/test').Locator {
  return page.getByRole('row').filter({ hasText: name });
}

test.describe('Trash bulk restore / purge / empty UI (TOM-49)', () => {
  test('複数ファイルとフォルダをチェックボックス選択して一括復元できる', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-trash-bulk-restore');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const folder = await createFolder(admin, {
      parentId: container.id,
      name: `${prefix}-folder`,
      classification: 'internal',
    });
    const alpha = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-alpha.txt`,
      content: `restore alpha ${randomUUID()}\n`,
    });
    const beta = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-beta.txt`,
      content: `restore beta ${randomUUID()}\n`,
    });

    await softDeleteFolder(admin, folder.id);
    await softDeleteFile(admin, alpha.id);
    await softDeleteFile(admin, beta.id);

    await openTrashFiltered(admin.page, prefix);
    const grid = admin.page.getByRole('grid');
    await expect(grid).toHaveAttribute('aria-rowcount', '4');

    for (const name of [
      `${prefix}-folder`,
      `${prefix}-alpha.txt`,
      `${prefix}-beta.txt`,
    ]) {
      await trashRow(admin.page, name).getByRole('checkbox').click();
    }
    await expect(
      admin.page.locator('[data-trash-selected-count="3"]')
    ).toBeVisible();

    await admin.page
      .getByRole('button', { name: '選択項目を復元', exact: true })
      .click();

    await expect(trashRow(admin.page, `${prefix}-folder`)).toHaveCount(0);
    await expect(trashRow(admin.page, `${prefix}-alpha.txt`)).toHaveCount(0);
    await expect(trashRow(admin.page, `${prefix}-beta.txt`)).toHaveCount(0);
    await expect(
      admin.page.getByText('条件に一致するアイテムがありません', {
        exact: true,
      })
    ).toBeVisible();

    const restoredAlpha = await waitForFileInFolder(
      admin,
      container.id,
      `${prefix}-alpha.txt`,
      { present: true }
    );
    const restoredBeta = await waitForFileInFolder(
      admin,
      container.id,
      `${prefix}-beta.txt`,
      { present: true }
    );
    expect(restoredAlpha?.id).toBe(alpha.id);
    expect(restoredBeta?.id).toBe(beta.id);
    const children = await getFolderChildren(admin, container.id);
    expect(children.folders.map((item) => item.id)).toContain(folder.id);

    await admin.page.goto(
      `/workspace?folderId=${encodeURIComponent(container.id)}`
    );
    await expect(
      admin.page.getByRole('button', {
        name: `${prefix}-alpha.txt`,
        exact: true,
      })
    ).toBeVisible();
    await expect(
      admin.page.getByRole('button', {
        name: `${prefix}-beta.txt`,
        exact: true,
      })
    ).toBeVisible();
  });

  test('複数ファイルの完全削除は件数・復元不可・共有リンク/権限警告を確認してから実行する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-trash-bulk-purge');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const one = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-one.txt`,
      content: `purge one ${randomUUID()}\n`,
    });
    const two = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-two.txt`,
      content: `purge two ${randomUUID()}\n`,
    });
    await softDeleteFile(admin, one.id);
    await softDeleteFile(admin, two.id);

    await openTrashFiltered(admin.page, prefix);
    const grid = admin.page.getByRole('grid');
    await expect(grid).toHaveAttribute('aria-rowcount', '3');

    await trashRow(admin.page, `${prefix}-one.txt`).getByRole('checkbox').click();
    await trashRow(admin.page, `${prefix}-two.txt`).getByRole('checkbox').click();
    await expect(
      admin.page.locator('[data-trash-selected-count="2"]')
    ).toBeVisible();

    await admin.page
      .getByRole('button', { name: '完全削除', exact: true })
      .click();
    const dialog = admin.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('完全削除の確認');
    await expect(dialog).toContainText('2 件を完全に削除します。');
    await expect(dialog).toContainText('復元できません');
    await expect(dialog).toContainText('共有リンク');
    await expect(dialog).toContainText('アクセス権限');
    const cancel = dialog.getByRole('button', {
      name: 'キャンセル',
      exact: true,
    });
    await expect(cancel).toBeFocused();

    await dialog
      .getByRole('button', { name: '完全削除', exact: true })
      .click();

    await expect(trashRow(admin.page, `${prefix}-one.txt`)).toHaveCount(0);
    await expect(trashRow(admin.page, `${prefix}-two.txt`)).toHaveCount(0);
    await expect(
      admin.page.getByText('条件に一致するアイテムがありません', {
        exact: true,
      })
    ).toBeVisible();

    for (const file of [one, two]) {
      const res = await admin.api.get(
        `/api/files/${encodeURIComponent(file.id)}`
      );
      expect(res.status()).toBe(404);
    }
    await waitForTrashFile(admin, `${prefix}-one.txt`, { present: false });
    await waitForTrashFile(admin, `${prefix}-two.txt`, { present: false });
  });

  test('完全削除の部分失敗は理由をダイアログ表示し、失敗項目を一覧に残す', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-trash-bulk-partial');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const owned = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-owned.txt`,
      content: `owned ${randomUUID()}\n`,
    });
    const editorOnly = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-editor-only.txt`,
      content: `editor only ${randomUUID()}\n`,
    });

    // Member has owner on one file and only inherited editor on the other.
    await grantPermission(admin, {
      targetType: 'file',
      targetId: owned.id,
      granteeType: 'user',
      granteeId: DEV_USERS.member.id,
      role: 'owner',
    });

    await softDeleteFile(admin, owned.id);
    await softDeleteFile(admin, editorOnly.id);

    await openTrashFiltered(member.page, prefix);
    const grid = member.page.getByRole('grid');
    await expect(grid).toHaveAttribute('aria-rowcount', '3');

    await trashRow(member.page, `${prefix}-owned.txt`)
      .getByRole('checkbox')
      .click();
    await trashRow(member.page, `${prefix}-editor-only.txt`)
      .getByRole('checkbox')
      .click();

    await member.page
      .getByRole('button', { name: '完全削除', exact: true })
      .click();
    const confirm = member.page.getByRole('dialog');
    await expect(confirm).toContainText('2 件を完全に削除します。');
    await confirm
      .getByRole('button', { name: '完全削除', exact: true })
      .click();

    const result = member.page.getByRole('dialog');
    await expect(result).toContainText('完全削除の結果');
    await expect(result).toContainText('成功');
    await expect(result).toContainText('失敗');
    await expect(result).toContainText('完全削除の権限がありません');
    await expect(result).toContainText('FORBIDDEN');
    await expect(result).toContainText(`${prefix}-editor-only.txt`);

    await result.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(trashRow(member.page, `${prefix}-owned.txt`)).toHaveCount(0);
    await expect(
      trashRow(member.page, `${prefix}-editor-only.txt`)
    ).toBeVisible();
  });

  test('ゴミ箱を空にする確認ダイアログを経てゴミ箱が空になる', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-trash-empty');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const one = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-one.txt`,
      content: `empty one ${randomUUID()}\n`,
    });
    const two = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-two.txt`,
      content: `empty two ${randomUUID()}\n`,
    });
    await softDeleteFile(admin, one.id);
    await softDeleteFile(admin, two.id);

    await openTrashFiltered(admin.page, prefix);
    const grid = admin.page.getByRole('grid');
    await expect(grid).toHaveAttribute('aria-rowcount', '3');

    await admin.page
      .getByRole('button', { name: 'ゴミ箱を空にする', exact: true })
      .click();
    const dialog = admin.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('ゴミ箱を空にする確認');
    await expect(dialog).toContainText('件');
    await expect(dialog).toContainText('復元できません');
    await expect(dialog).toContainText('共有リンク');
    await expect(dialog).toContainText('アクセス権限');
    await expect(
      dialog.getByRole('button', { name: 'キャンセル', exact: true })
    ).toBeFocused();

    await dialog
      .getByRole('button', { name: 'ゴミ箱を空にする', exact: true })
      .click();

    await expect(
      admin.page.getByText('ゴミ箱は空です', { exact: true })
    ).toBeVisible();
    await expect(admin.page.getByRole('grid')).toHaveCount(0);
    for (const file of [one, two]) {
      const res = await admin.api.get(
        `/api/files/${encodeURIComponent(file.id)}`
      );
      expect(res.status()).toBe(404);
    }
  });
});
