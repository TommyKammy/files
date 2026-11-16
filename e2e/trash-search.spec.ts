import { randomUUID } from 'node:crypto';
import { DEV_USERS, expect, test } from './fixtures';
import {
  createFolder,
  findRootFolder,
  listAllTrash,
  listTrash,
  softDeleteFile,
  softDeleteFolder,
  uploadFile,
  waitForFileInFolder,
  waitForTrashFile,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

async function inChunks<T>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(run));
  }
}

async function readRowCount(page: import('@playwright/test').Page): Promise<number> {
  const grid = page.getByRole('grid');
  if ((await grid.count()) === 0) return 0;
  return Number((await grid.getAttribute('aria-rowcount')) ?? '0');
}

test.describe('Trash search, filter, sort, pagination and retention UI (TOM-48)', () => {
  test('105件超のゴミ箱をカーソルで全件読み込み、後半アイテムまで表示できる', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(300_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-trash-bulk');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const folderNames = Array.from({ length: 106 }, (_, index) =>
      `${prefix}-${String(index).padStart(3, '0')}`
    );
    const fileNames = Array.from({ length: 4 }, (_, index) =>
      `${prefix}-file-${index}.txt`
    );

    const folders: Awaited<ReturnType<typeof createFolder>>[] = [];
    await inChunks(folderNames, 10, async (name) => {
      folders.push(
        await createFolder(admin, {
          parentId: container.id,
          name,
          classification: 'internal',
        })
      );
    });

    const files: Awaited<ReturnType<typeof uploadFile>>[] = [];
    await inChunks(fileNames, 2, async (name) => {
      files.push(
        await uploadFile(admin, {
          folderId: container.id,
          name,
          content: `trash bulk ${name} ${randomUUID()}\n`,
        })
      );
    });

    // Delete roughly half as sys_admin and half as member(editor) so the
    // deleter filter has two real candidates.
    for (let offset = 0; offset < folders.length; offset += 8) {
      await Promise.all(
        folders.slice(offset, offset + 8).map((folder, index) =>
          softDeleteFolder(
            (offset + index) % 2 === 0 ? admin : member,
            folder.id
          )
        )
      );
    }

    for (const [index, file] of files.entries()) {
      await softDeleteFile(index % 2 === 0 ? admin : member, file.id);
    }

    const allTrash = await listAllTrash(admin, { limit: 200 });
    const mine = allTrash.filter((item) => item.name.startsWith(prefix));
    expect(mine).toHaveLength(110);
    expect(
      mine.filter((item) => item.deletedBy === DEV_USERS.sys_admin.id)
        .length
    ).toBeGreaterThan(0);
    expect(
      mine.filter((item) => item.deletedBy === DEV_USERS.member.id).length
    ).toBeGreaterThan(0);

    await admin.page.goto('/workspace?view=trash');
    await expect(
      admin.page.getByRole('heading', { name: 'ゴミ箱', exact: true })
    ).toBeVisible();
    const grid = admin.page.getByRole('grid');
    await expect(grid).toBeVisible();
    await expect(grid).toHaveAttribute('aria-rowcount', '51');

    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const loadMore = admin.page.getByRole('button', {
        name: 'さらに読み込む',
      });
      if (!(await loadMore.isVisible().catch(() => false))) break;
      const before = await readRowCount(admin.page);
      await loadMore.click();
      await expect
        .poll(() => readRowCount(admin.page))
        .toBeGreaterThan(before);
    }

    await expect
      .poll(() => readRowCount(admin.page))
      .toBe(allTrash.length + 1);
    expect(await readRowCount(admin.page)).toBeGreaterThan(101);

    const lastItem = allTrash[allTrash.length - 1];
    expect(lastItem).toBeTruthy();
    await admin.page
      .locator('[data-workspace-table="true"]')
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    await expect(
      admin.page
        .getByRole('main')
        .getByRole('button', { name: lastItem.name, exact: true })
        .last()
    ).toBeVisible();
  });

  test('名前検索・種別/削除者フィルタ・4種ソート・保持期限バッジ・復元後即時消滅が実ブラウザで動作する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const root = await findRootFolder(admin, '全社共有');
    const prefix = uniqueName('e2e-trash-filter');
    const container = await createFolder(admin, {
      parentId: root.id,
      name: prefix,
      classification: 'internal',
    });
    cleanup.registerFolder(container.id);

    const apple = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-apple.txt`,
      content: `apple ${randomUUID()}\n`,
    });
    const banana = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-banana.txt`,
      content: `banana ${randomUUID()}\n`,
    });
    const cherry = await uploadFile(admin, {
      folderId: container.id,
      name: `${prefix}-cherry.txt`,
      content: `cherry ${randomUUID()}\n`,
    });
    const alphaFolder = await createFolder(admin, {
      parentId: container.id,
      name: `${prefix}-alpha-folder`,
      classification: 'internal',
    });
    const betaFolder = await createFolder(admin, {
      parentId: container.id,
      name: `${prefix}-beta-folder`,
      classification: 'internal',
    });
    const gammaFolder = await createFolder(admin, {
      parentId: container.id,
      name: `${prefix}-gamma-folder`,
      classification: 'internal',
    });

    await softDeleteFile(admin, apple.id);
    await softDeleteFile(admin, banana.id);
    await softDeleteFile(member, cherry.id);
    await softDeleteFolder(admin, alphaFolder.id);
    await softDeleteFolder(member, betaFolder.id);
    await softDeleteFolder(member, gammaFolder.id);

    await expect
      .poll(async () => {
        const response = await listTrash(admin, {
          query: prefix,
          limit: 200,
        });
        return response.items?.length ?? 0;
      })
      .toBe(6);

    await admin.page.goto('/workspace?view=trash');
    await expect(
      admin.page.getByRole('heading', { name: 'ゴミ箱', exact: true })
    ).toBeVisible();

    const search = admin.page.getByLabel('ゴミ箱を検索');
    await search.fill(prefix);
    await search.press('Enter');
    const grid = admin.page.getByRole('grid');
    await expect(grid).toHaveAttribute('aria-rowcount', '7');
    await expect(
      admin.page.getByText(`${prefix}-apple.txt`, { exact: true })
    ).toBeVisible();

    // Grid mode must expose the same Trash metadata and retention badge.
    await admin.page
      .getByRole('button', { name: 'グリッド', exact: true })
      .click();
    const appleCard = admin.page
      .locator('[data-row-index]')
      .filter({ hasText: `${prefix}-apple.txt` });
    await expect(appleCard).toContainText('削除者: Dev Admin');
    await expect(appleCard.locator('[data-retention-level]')).toBeVisible();
    await expect(appleCard.locator('[data-trash-purge-at]')).toBeVisible();
    await admin.page
      .getByRole('button', { name: 'リスト', exact: true })
      .click();
    await expect(grid).toBeVisible();

    const typeFilter = admin.page.getByLabel('種類で絞り込み');
    await typeFilter.selectOption('file');
    await expect(grid).toHaveAttribute('aria-rowcount', '4');
    await expect(
      admin.page.getByRole('row').filter({ hasText: `${prefix}-cherry.txt` })
    ).toBeVisible();
    await expect(
      admin.page.getByRole('row').filter({ hasText: `${prefix}-alpha-folder` })
    ).toHaveCount(0);

    await typeFilter.selectOption('folder');
    await expect(grid).toHaveAttribute('aria-rowcount', '4');
    await expect(
      admin.page.getByRole('row').filter({ hasText: `${prefix}-gamma-folder` })
    ).toBeVisible();
    await expect(
      admin.page.getByRole('row').filter({ hasText: `${prefix}-apple.txt` })
    ).toHaveCount(0);

    await typeFilter.selectOption('all');
    await expect(grid).toHaveAttribute('aria-rowcount', '7');

    const deleterFilter = admin.page.getByLabel('削除者で絞り込み');
    await expect(deleterFilter).toBeVisible();
    await deleterFilter.selectOption(DEV_USERS.sys_admin.id);
    await expect(grid).toHaveAttribute('aria-rowcount', '4');
    await expect(
      admin.page.getByRole('row').filter({ hasText: `${prefix}-apple.txt` })
    ).toBeVisible();
    await expect(
      admin.page.getByRole('row').filter({ hasText: `${prefix}-cherry.txt` })
    ).toHaveCount(0);

    await deleterFilter.selectOption(DEV_USERS.member.id);
    await expect(grid).toHaveAttribute('aria-rowcount', '4');
    await expect(
      admin.page.getByRole('row').filter({ hasText: `${prefix}-cherry.txt` })
    ).toBeVisible();

    await deleterFilter.selectOption('');
    await expect(grid).toHaveAttribute('aria-rowcount', '7');

    const sortSelect = admin.page.getByLabel('並び順');
    const sortCases = [
      'name_asc',
      'name_desc',
      'deletedAt_asc',
      'deletedAt_desc',
    ] as const;
    for (const sort of sortCases) {
      await sortSelect.selectOption(sort);
      const expected = await listTrash(admin, {
        query: prefix,
        limit: 200,
        sort,
      });
      const first = expected.items?.[0];
      expect(first).toBeTruthy();
      await expect
        .poll(async () =>
          (
            await admin.page.locator('[data-row-index="0"]').innerText()
          ).includes(first!.name)
        )
        .toBe(true);
    }

    const retention = await listTrash(admin, {
      query: prefix,
      limit: 200,
      sort: 'deletedAt_desc',
    });
    const retentionItem = retention.items?.find(
      (item) => item.name === `${prefix}-apple.txt`
    );
    expect(retentionItem).toBeTruthy();
    const appleRow = admin.page
      .getByRole('row')
      .filter({ hasText: `${prefix}-apple.txt` });
    await expect(
      appleRow.locator('[data-retention-level]')
    ).toHaveAttribute('data-retention-level', 'calm');
    await expect(appleRow.locator('[data-retention-level]')).toContainText(
      `残り ${retentionItem!.daysRemaining}日`
    );
    await expect(
      appleRow.locator('[data-trash-purge-at]')
    ).toHaveAttribute('data-trash-purge-at', retentionItem!.purgeAt!);

    const beforeRestore = await readRowCount(admin.page);
    await appleRow.getByRole('button', { name: '復元', exact: true }).click();
    await expect(appleRow).toHaveCount(0);
    await expect
      .poll(() => readRowCount(admin.page))
      .toBe(beforeRestore - 1);
    await waitForTrashFile(admin, `${prefix}-apple.txt`, { present: false });
    const restored = await waitForFileInFolder(
      admin,
      container.id,
      `${prefix}-apple.txt`,
      { present: true }
    );
    expect(restored?.id).toBe(apple.id);

    // Filtered-to-zero state must be distinct from the empty Trash state and
    // must offer a working clear action.
    await search.fill(`${prefix}-does-not-exist`);
    await search.press('Enter');
    await expect(
      admin.page.getByText('条件に一致するアイテムがありません', { exact: true })
    ).toBeVisible();
    await expect(
      admin.page.getByText('ゴミ箱は空です', { exact: true })
    ).toHaveCount(0);
    const clearButtons = admin.page.getByRole('button', {
      name: '条件をクリア',
      exact: true,
    });
    await expect(clearButtons.first()).toBeVisible();
    await clearButtons.last().click();
    await expect(search).toHaveValue('');
    await expect.poll(() => readRowCount(admin.page)).toBeGreaterThan(1);
  });
});
