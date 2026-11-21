import { randomUUID } from 'node:crypto';
import { expect, test, DEV_USERS } from './fixtures';
import { createFolder, uploadFile } from './helpers/api';
import { uniqueName } from './helpers/browser';
import { buildDocx } from './helpers/docx';

function shortToken(): string {
  return `e2e${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

test.describe('Phase 1-3 Box parity features E2E', () => {
  test('Recents / Favorites & Collections / My Tasks / Notification Bell と通知設定が動作する', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const root = await createFolder(admin, {
      parentId: null,
      name: uniqueName('parity-nav'),
      classification: 'internal',
    });
    cleanup.registerFolder(root.id);

    const fileName = `${shortToken()}-report.txt`;
    const uploaded = await uploadFile(admin, {
      folderId: root.id,
      name: fileName,
      mimeType: 'text/plain',
      content: 'Recents, Favorites, Tasks & Notifications E2E payload',
    });

    // Seed recent, favorite, collection, and task via API
    const touchRes = await admin.api.post('/api/recents/touch', {
      data: { itemType: 'file', itemId: uploaded.id, action: 'preview' },
    });
    expect(touchRes.status()).toBe(200);

    const favRes = await admin.api.post('/api/favorites', {
      data: { itemType: 'file', itemId: uploaded.id },
    });
    expect([200, 201]).toContain(favRes.status());

    const colName = uniqueName('e2e-col');
    const colRes = await admin.api.post('/api/collections', {
      data: { name: colName, color: 'indigo' },
    });
    expect(colRes.status()).toBe(201);
    const colBody = (await colRes.json()) as { collection: { id: string } };

    const addColItemRes = await admin.api.post(
      `/api/collections/${encodeURIComponent(colBody.collection.id)}/items`,
      {
        data: { itemType: 'file', itemId: uploaded.id },
      }
    );
    expect([200, 201]).toContain(addColItemRes.status());

    const taskTitle = `承認依頼-${shortToken()}`;
    const taskRes = await admin.api.post(
      `/api/items/file/${encodeURIComponent(uploaded.id)}/tasks`,
      {
        data: {
          title: taskTitle,
          message: '内容を確認してください',
          assigneeId: DEV_USERS.sys_admin.id,
        },
      }
    );
    expect(taskRes.status()).toBe(201);

    // 1. Recents view
    await admin.page.goto('/workspace?view=recents');
    await expect(
      admin.page.getByRole('heading', { name: '最近使用した項目' })
    ).toBeVisible();
    await expect(admin.page.getByText(fileName)).toBeVisible();

    // 2. Favorites & Collections view
    await admin.page.goto('/workspace?view=favorites');
    await expect(
      admin.page.getByRole('heading', { name: 'お気に入り & コレクション' })
    ).toBeVisible();
    await expect(admin.page.getByText(fileName)).toBeVisible();

    const colButton = admin.page.getByRole('button', { name: new RegExp(colName) });
    await expect(colButton).toBeVisible();
    await colButton.click();
    await expect(admin.page.getByText(fileName)).toBeVisible();

    // 3. My Tasks view
    await admin.page.goto('/workspace?view=tasks');
    await expect(
      admin.page.getByRole('heading', { name: 'マイタスク' })
    ).toBeVisible();
    await expect(admin.page.getByText(taskTitle)).toBeVisible();

    // 4. Notification Bell popover & email notification preferences toggle
    const bellBtn = admin.page.getByTestId('notification-bell-button');
    await expect(bellBtn).toBeVisible();
    await bellBtn.click();

    const popover = admin.page.getByTestId('notification-popover');
    await expect(popover).toBeVisible();

    const settingsToggle = admin.page.getByTestId('notification-settings-toggle');
    await settingsToggle.click();

    const settingsPanel = admin.page.getByTestId('notification-settings-panel');
    await expect(settingsPanel).toBeVisible();

    const firstCheckbox = settingsPanel.locator('input[type="checkbox"]').first();
    await expect(firstCheckbox).toBeVisible();
    const initialChecked = await firstCheckbox.isChecked();
    const prefUpdatePromise = admin.page.waitForResponse(
      (res) =>
        res.url().includes('/api/notifications/preferences') &&
        res.request().method() === 'PATCH'
    );
    await firstCheckbox.click();
    const prefUpdateRes = await prefUpdatePromise;
    expect(prefUpdateRes.status()).toBe(200);
    await expect(firstCheckbox).toBeChecked({ checked: !initialChecked });
  });

  test('詳細検索ページ (/workspace/search) で属性フィルタと OOXML .docx 本文検索ができる', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const root = await createFolder(admin, {
      parentId: null,
      name: uniqueName('parity-search'),
      classification: 'confidential',
    });
    cleanup.registerFolder(root.id);

    const docxBodyToken = `DocxFullText${shortToken()}`;
    const docxName = `${shortToken()}-spec.docx`;
    const docxBuffer = buildDocx({
      title: 'E2E Search Document',
      paragraphs: [
        'これは OOXML 本文全文検索のテスト文書です。',
        `検索キーワード: ${docxBodyToken}`,
      ],
    });
    await uploadFile(admin, {
      folderId: root.id,
      name: docxName,
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: docxBuffer,
    });

    const tagToken = `tag-${shortToken()}`;
    const txtName = `${shortToken()}-contract.txt`;
    const txtFile = await uploadFile(admin, {
      folderId: root.id,
      name: txtName,
      mimeType: 'text/plain',
      content: 'Tagged confidential contract',
    });
    const tagRes = await admin.api.post(
      `/api/items/file/${encodeURIComponent(txtFile.id)}/tags`,
      { data: { tag: tagToken } }
    );
    expect([200, 201]).toContain(tagRes.status());

    // 1. OOXML .docx full-text search
    await admin.page.goto('/workspace/search');
    await expect(
      admin.page.getByRole('heading', { name: 'ワークスペース詳細検索' })
    ).toBeVisible();

    const queryInput = admin.page.getByLabel('検索キーワード');
    await queryInput.fill(docxBodyToken);
    await admin.page.getByRole('button', { name: '検索', exact: true }).click();
    await expect(admin.page.getByText(docxName)).toBeVisible();

    // 2. Filter bar (classification + extension + tag)
    await admin.page.getByRole('button', { name: 'リセット', exact: true }).click();
    await admin.page
      .getByLabel('機密分類')
      .selectOption('confidential');
    await admin.page.getByPlaceholder('例: pdf, docx').fill('txt');
    await admin.page.getByPlaceholder('例: urgent, 契約').fill(tagToken);
    await admin.page.getByRole('button', { name: '検索', exact: true }).click();
    await expect(admin.page.getByText(txtName)).toBeVisible();
  });

  test('ワークスペース列表示・クイックフィルタ・ソート・ロック・インスペクタタブが動作する', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const root = await createFolder(admin, {
      parentId: null,
      name: uniqueName('parity-ws'),
      classification: 'internal',
    });
    cleanup.registerFolder(root.id);

    const alphaName = `alpha-${shortToken()}.txt`;
    const betaName = `beta-${shortToken()}.txt`;
    await uploadFile(admin, {
      folderId: root.id,
      name: alphaName,
      mimeType: 'text/plain',
      content: 'Alpha file content',
    });
    await uploadFile(admin, {
      folderId: root.id,
      name: betaName,
      mimeType: 'text/plain',
      content: 'Beta file content',
    });

    await admin.page.goto(`/workspace?folderId=${encodeURIComponent(root.id)}`);
    const main = admin.page.getByRole('main');
    await expect(main.getByRole('button', { name: alphaName, exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: betaName, exact: true })).toBeVisible();

    // 1. Column customization toggle
    await admin.page.getByTestId('workspace-columns-toggle').click();
    const colsPopover = admin.page.getByTestId('workspace-columns-popover');
    await expect(colsPopover).toBeVisible();
    const sizeCheckbox = admin.page.getByTestId('workspace-col-checkbox-size');
    await expect(sizeCheckbox).toBeChecked();
    await sizeCheckbox.click();
    await expect(sizeCheckbox).not.toBeChecked();
    await sizeCheckbox.click();
    await expect(sizeCheckbox).toBeChecked();
    await admin.page.keyboard.press('Escape');

    // 2. Server-side sort header click
    const updatedHeader = main.locator('thead th', { hasText: '更新日時' });
    const sortBtn = updatedHeader.getByRole('button');
    await sortBtn.click();
    await expect(updatedHeader).toHaveAttribute('aria-sort', /ascending|descending/);

    // 3. In-folder quick filter
    const quickFilter = admin.page.getByLabel('フォルダ内を名前で絞り込み');
    await quickFilter.fill('alpha');
    await expect(main.getByRole('button', { name: alphaName, exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: betaName, exact: true })).toBeHidden();
    await quickFilter.fill('');
    await expect(main.getByRole('button', { name: betaName, exact: true })).toBeVisible();

    // 4. Select file & open Inspector
    await main.getByRole('button', { name: alphaName, exact: true }).click();
    await admin.page.keyboard.press('i');

    // Manual lock / unlock from Inspector
    const lockBtn = admin.page.getByTestId('inspector-lock-button');
    await expect(lockBtn).toBeVisible();
    await lockBtn.click();
    await expect(admin.page.getByTestId('inspector-lock-banner')).toBeVisible();

    const unlockBtn = admin.page.getByTestId('inspector-unlock-button');
    await expect(unlockBtn).toBeVisible();
    await unlockBtn.click();
    await expect(admin.page.getByTestId('inspector-lock-banner')).toBeHidden();

    // 5. Inspector tabs: 詳細 (tags), コメント (@mention), アクティビティ, タスク
    const newTag = `urgent-${shortToken()}`;
    await admin.page.getByLabel('新しいタグ').fill(newTag);
    await admin.page.getByRole('button', { name: '追加', exact: true }).click();
    await expect(admin.page.getByText(`#${newTag}`)).toBeVisible();

    await admin.page.getByTestId('inspector-tab-comments').click();
    await expect(admin.page.getByTestId('inspector-comments-panel')).toBeVisible();
    await admin.page
      .getByTestId('comment-composer-input')
      .fill('@dev-member レビューをお願いします');
    await admin.page.getByTestId('comment-submit-button').click();
    await expect(
      admin.page.getByTestId('inspector-comments-panel').getByText('@dev-member')
    ).toBeVisible();

    await admin.page.getByTestId('inspector-tab-activity').click();
    await expect(admin.page.getByTestId('inspector-activity-panel')).toBeVisible();

    await admin.page.getByTestId('inspector-tab-tasks').click();
    await expect(admin.page.getByTestId('inspector-tasks-panel')).toBeVisible();
  });

  test('Admin Console メタデータテンプレートと Visual Branding 設定が保存できる', async ({
    as,
  }) => {
    const admin = await as('sys_admin');

    // 1. Metadata Templates tab
    await admin.page.goto('/admin/content?tab=metadata-templates');
    await expect(
      admin.page.getByRole('heading', { name: 'カスタムメタデータテンプレート' })
    ).toBeVisible();

    const tplKey = `tpl_${shortToken().toLowerCase()}`;
    const tplName = `E2Eテンプレート-${shortToken()}`;
    await admin.page
      .getByRole('button', { name: 'テンプレート作成' })
      .click();
    await admin.page.locator('#meta-tpl-key').fill(tplKey);
    await admin.page.locator('#meta-tpl-display-name').fill(tplName);
    await admin.page.getByPlaceholder('contract_no').first().fill('doc_ref');
    await admin.page.getByPlaceholder('契約番号').first().fill('文書番号');
    await admin.page
      .getByRole('button', { name: /テンプレートを作成|保存/ })
      .click();
    await expect(admin.page.getByText(tplName)).toBeVisible();

    // 2. Visual Branding settings
    await admin.page.goto('/admin/settings?tab=compliance');
    const orgInput = admin.page.getByTestId('admin-branding-org-name');
    await expect(orgInput).toBeVisible();
    const accentInput = admin.page.getByTestId('admin-branding-accent-color');
    await expect(accentInput).toBeVisible();
    await expect(admin.page.getByTestId('admin-branding-logo-input')).toBeAttached();

    const testOrgName = `E2E Corp ${shortToken()}`;
    await orgInput.fill(testOrgName);
    await accentInput.fill('#2563eb');
    await admin.page.getByTestId('admin-governance-policy-save').click();
    await expect(admin.page.getByTestId('admin-governance-policy-notice')).toBeVisible();
  });

  test('一括 ZIP ダウンロードと共有フォルダのサブフォルダ遷移 (/s/:token) が動作する', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const root = await createFolder(admin, {
      parentId: null,
      name: uniqueName('parity-share-zip'),
      classification: 'public',
    });
    cleanup.registerFolder(root.id);

    const subFolderName = uniqueName('sub');
    const subFolder = await createFolder(admin, {
      parentId: root.id,
      name: subFolderName,
      classification: 'public',
    });

    const file1Name = `${shortToken()}-one.txt`;
    const file2Name = `${shortToken()}-two.txt`;
    const subFileName = `${shortToken()}-inside.txt`;

    await uploadFile(admin, {
      folderId: root.id,
      name: file1Name,
      mimeType: 'text/plain',
      content: 'File 1 in root',
    });
    await uploadFile(admin, {
      folderId: root.id,
      name: file2Name,
      mimeType: 'text/plain',
      content: 'File 2 in root',
    });
    await uploadFile(admin, {
      folderId: subFolder.id,
      name: subFileName,
      mimeType: 'text/plain',
      content: 'File inside subfolder',
    });

    // 1. Bulk ZIP download from workspace selection bar
    await admin.page.goto(`/workspace?folderId=${encodeURIComponent(root.id)}`);
    await admin.page.getByLabel(`${file1Name} を選択`).click();
    await admin.page.getByLabel(`${file2Name} を選択`).click();

    const zipBtn = admin.page.getByRole('button', { name: 'ZIPダウンロード' });
    await expect(zipBtn).toBeVisible();
    const zipResponsePromise = admin.page.waitForResponse(
      (res) =>
        res.url().includes('/api/files/bulk-zip') &&
        res.request().method() === 'POST'
    );
    await zipBtn.click();
    const zipRes = await zipResponsePromise;
    expect(zipRes.status()).toBe(200);

    // 2. Shared folder subfolder navigation (/s/:token)
    const linkRes = await admin.api.post('/api/shared-links', {
      data: {
        targetType: 'folder',
        targetId: root.id,
        accessScope: 'public',
        permissionLevel: 'viewer',
      },
    });
    expect(linkRes.status()).toBe(201);
    const linkBody = (await linkRes.json()) as { token: string };

    await admin.page.goto(`/s/${encodeURIComponent(linkBody.token)}`);
    await expect(admin.page.getByText(subFolderName)).toBeVisible();
    await admin.page.getByRole('button', { name: subFolderName }).click();
    await expect(admin.page.getByText(subFileName)).toBeVisible();
  });
});
