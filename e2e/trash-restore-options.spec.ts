import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import {
  createFolder,
  findRootFolder,
  getFolderChildren,
  listTrash,
  softDeleteFile,
  softDeleteFolder,
  uploadFile,
  waitForFileInFolder,
  waitForTrashFile,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

function trashRow(
  page: import('@playwright/test').Page,
  name: string
): import('@playwright/test').Locator {
  return page.getByRole('row').filter({ hasText: name });
}

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

test.describe('Trash restore options: parent chain, conflicts, destination (TOM-50)', () => {
  test('親フォルダごと削除しても、子ファイル復元時に親チェーンが初期選択され、無関係な削除ファイルはゴミ箱に残る', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-restore-chain');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const parent = await createFolder(admin, {
      parentId: container.id,
      name: `${prefix}-parent`,
      classification: 'internal',
    });
    const target = await uploadFile(admin, {
      folderId: parent.id,
      name: `${prefix}-child.txt`,
      content: `restore chain target ${randomUUID()}\n`,
    });
    const unrelated = await uploadFile(admin, {
      folderId: parent.id,
      name: `${prefix}-unrelated.txt`,
      content: `restore chain unrelated ${randomUUID()}\n`,
    });

    // Deliberately different deletion batches: unrelated first, then the
    // target file, then the shared parent folder.
    await softDeleteFile(admin, unrelated.id);
    await softDeleteFile(admin, target.id);
    await softDeleteFolder(admin, parent.id);

    const listed = await listTrash(admin, { query: prefix, limit: 200 });
    const listedIds = (listed.items ?? []).map((item) => item.id);
    expect(listedIds).toContain(parent.id);
    expect(listedIds).toContain(target.id);
    expect(listedIds).toContain(unrelated.id);

    await openTrashFiltered(admin.page, prefix);
    const targetRow = trashRow(admin.page, `${prefix}-child.txt`);
    await expect(targetRow).toBeVisible();
    await targetRow.getByRole('button', { name: '復元', exact: true }).click();

    const dialog = admin.page.getByRole('dialog', {
      name: 'ゴミ箱から復元',
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('元の親フォルダが削除されています', { exact: false })
    ).toBeVisible();
    const parentChain = dialog.getByRole('checkbox');
    await expect(parentChain).toBeChecked();
    await expect(parentChain).toBeEnabled();

    await dialog.getByRole('button', { name: '復元する', exact: true }).click();
    await expect(dialog).toBeHidden();

    const restored = await waitForFileInFolder(
      admin,
      parent.id,
      `${prefix}-child.txt`,
      { present: true }
    );
    expect(restored?.id).toBe(target.id);
    await expect
      .poll(async () => {
        const children = await getFolderChildren(admin, container.id);
        return children.folders.some((folder) => folder.id === parent.id);
      })
      .toBe(true);

    // The unrelated file was deleted in another batch and must stay in Trash.
    await waitForTrashFile(admin, `${prefix}-unrelated.txt`, {
      present: true,
    });
    await expect(trashRow(admin.page, `${prefix}-unrelated.txt`)).toBeVisible();
    await expect(trashRow(admin.page, `${prefix}-child.txt`)).toHaveCount(0);
    await expect(trashRow(admin.page, `${prefix}-parent`)).toHaveCount(0);

    await admin.page.goto(
      `/workspace?folderId=${encodeURIComponent(parent.id)}`
    );
    await expect(
      admin.page
        .getByRole('main')
        .getByRole('button', { name: `${prefix}-child.txt`, exact: true })
    ).toBeVisible();
  });

  test('同名ファイル存在時は409で推奨名を提示し、自動リネームで元ファイルと共存させる', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-restore-conflict');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const victim = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-collision.txt`,
      content: `conflict victim ${randomUUID()}\n`,
    });
    await softDeleteFile(admin, victim.id);
    const active = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-collision.txt`,
      content: `conflict active survivor ${randomUUID()}\n`,
    });

    await openTrashFiltered(admin.page, prefix);
    const row = trashRow(admin.page, `${prefix}-collision.txt`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '復元', exact: true }).click();

    const dialog = admin.page.getByRole('dialog', {
      name: 'ゴミ箱から復元',
    });
    await expect(dialog).toBeVisible();
    const conflict = dialog.locator('[data-restore-conflict="true"]');
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText(
      `${prefix}-collision (Restored).txt`
    );

    await dialog.getByRole('button', { name: '復元する', exact: true }).click();
    const error = dialog.locator('[data-trash-restore-error="true"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText('NAME_CONFLICT');
    await expect(error).toContainText(
      `${prefix}-collision (Restored).txt`
    );

    await error
      .getByRole('button', { name: /推奨名.*で再試行/ })
      .click();
    await expect(dialog).toBeHidden();

    const restored = await waitForFileInFolder(
      admin,
      container.id,
      `${prefix}-collision (Restored).txt`,
      { present: true }
    );
    expect(restored?.id).toBe(victim.id);
    const survivor = await waitForFileInFolder(
      admin,
      container.id,
      `${prefix}-collision.txt`,
      { present: true }
    );
    expect(survivor?.id).toBe(active.id);
    await waitForTrashFile(admin, `${prefix}-collision.txt`, {
      present: false,
    });
  });

  test('機密フォルダをツリーから選ぶとパンくず・分類下限・昇格警告が表示され、トーストと昇格済み一覧に反映される', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-restore-secret');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const file = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-promote.txt`,
      content: `secret destination ${randomUUID()}\n`,
    });
    await softDeleteFile(admin, file.id);

    await openTrashFiltered(admin.page, prefix);
    const row = trashRow(admin.page, `${prefix}-promote.txt`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '復元', exact: true }).click();

    const dialog = admin.page.getByRole('dialog', {
      name: 'ゴミ箱から復元',
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('radio', { name: /別のフォルダへ復元/ })
      .check();

    const secretRow = dialog.locator(
      '[data-restore-destination-id="folder-root-confidential"]'
    );
    await expect(secretRow).toBeVisible();
    await secretRow.click();

    await expect(
      dialog.locator('[data-restore-destination-path]').first()
    ).toContainText('機密プロジェクト');
    await expect(dialog.locator('[data-restore-upgrade="true"]')).toBeVisible();
    await expect(dialog.locator('[data-restore-upgrade="true"]')).toContainText(
      '極秘'
    );
    await expect(dialog).toContainText('共有リンク');
    await expect(dialog).toContainText('権限');

    await dialog.getByRole('button', { name: '復元する', exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () =>
        admin.page
          .locator('[data-workspace-toast-stack="true"]')
          .innerText()
          .catch(() => '')
      )
      .toContain('機密プロジェクト');

    const restored = await waitForFileInFolder(
      admin,
      'folder-root-confidential',
      `${prefix}-promote.txt`,
      { present: true }
    );
    expect(restored?.id).toBe(file.id);
    expect(restored?.classification).toBe('confidential');

    await admin.page.goto('/workspace?folderId=folder-root-confidential');
    const restoredRow = admin.page
      .getByRole('row')
      .filter({ hasText: `${prefix}-promote.txt` });
    await expect(restoredRow).toBeVisible();
    await expect(restoredRow).toContainText('極秘');
    await waitForTrashFile(admin, `${prefix}-promote.txt`, {
      present: false,
    });
  });
});
