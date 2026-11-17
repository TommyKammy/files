import { expect, test } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  createAdminMemberApi,
  createFolder,
  deleteFolderQuietly,
  getFolderChildren,
  uploadFile,
} from './helpers/api';
import { installRealtimeProbe, uniqueName, waitForRealtimeConnected } from './helpers/browser';

async function openMemberSession(
  browser: Browser,
  baseURL: string,
  userId: string
): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const requestContext = await browser.newContext({ baseURL });
  const login = await requestContext.request.post('/auth/dev-login', {
    data: { userId },
    headers: { Origin: baseURL },
  });
  expect(login.status()).toBe(200);
  const storageState = await requestContext.request.storageState();
  await requestContext.close();

  const context = await browser.newContext({
    baseURL,
    storageState,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1440, height: 900 },
  });
  await installRealtimeProbe(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return { context, page };
}

test.describe('退職/移管オフボーディング (P11-4 / TOM-70)', () => {
  test('所有者フォルダ・共有リンク・ファイルリクエスト・セッションを後任メンバーへ一括移管し旧メンバーを即時追い出す', async ({
    as,
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const leaverEmail = `e2e-off-leaver-${suffix}@example.com`;
    const successorEmail = `e2e-off-successor-${suffix}@example.com`;
    const folderName = uniqueName('e2e-offboarding-root');
    const fileName = `handover-${suffix}.txt`;

    const leaver = await createAdminMemberApi(admin, {
      email: leaverEmail,
      displayName: 'E2E Offboarding Leaver',
      department: 'Handover',
    });
    const successor = await createAdminMemberApi(admin, {
      email: successorEmail,
      displayName: 'E2E Offboarding Successor',
      department: 'Handover',
    });

    const leaverSession = await openMemberSession(browser, baseURL!, leaver.id);
    const successorSession = await openMemberSession(
      browser,
      baseURL!,
      successor.id
    );
    let folderId: string | null = null;

    try {
      const leaverApi = { api: leaverSession.context.request };
      const folder = await createFolder(leaverApi, {
        parentId: null,
        name: folderName,
        classification: 'internal',
      });
      folderId = folder.id;
      await uploadFile(leaverApi, {
        folderId: folder.id,
        name: fileName,
        content: 'handover package',
      });

      const linkRes = await leaverSession.context.request.post(
        '/api/shared-links',
        {
          data: {
            targetType: 'folder',
            targetId: folder.id,
            accessScope: 'company_only',
          },
          headers: { Origin: baseURL! },
        }
      );
      expect(linkRes.status()).toBe(201);
      const linkBody = (await linkRes.json()) as {
        link: { id: string };
        token: string;
      };
      expect(linkBody.token).toBeTruthy();

      const requestRes = await leaverSession.context.request.post(
        '/api/file-requests',
        {
          data: {
            folderId: folder.id,
            title: `引継ぎ資料 ${suffix}`,
          },
          headers: { Origin: baseURL! },
        }
      );
      expect(requestRes.status()).toBe(201);
      const requestBody = (await requestRes.json()) as {
        fileRequest: { id: string; title: string };
      };

      // Keep the leaver's live workspace connected so the offboarding signal
      // must actively evict the browser session, not just invalidate D1.
      await leaverSession.page.goto('/workspace');
      await waitForRealtimeConnected(leaverSession.page);
      const meBefore = await leaverSession.context.request.get('/api/auth/me');
      expect(meBefore.status()).toBe(200);

      await admin.page.goto('/admin/users');
      const members = admin.page.getByTestId('admin-members-section');
      await expect(members).toBeVisible();
      await members.getByTestId('member-filter-query').fill(leaverEmail);
      await members.getByTestId('member-filter-apply').click();
      const row = admin.page
        .locator('[data-testid="admin-member-row"]')
        .filter({ hasText: leaverEmail });
      await expect(row).toBeVisible();

      await row.getByTestId('member-action-offboard').click();
      const modal = admin.page.getByTestId('member-offboarding-modal');
      await expect(modal).toBeVisible();
      await expect(
        modal.getByTestId('offboarding-preview-sole-owner')
      ).toContainText('1');
      await expect(
        modal.getByTestId('offboarding-preview-shared-links')
      ).toContainText('1');
      await expect(
        modal.getByTestId('offboarding-preview-file-requests')
      ).toContainText('1');
      await expect(
        modal.getByTestId('offboarding-preview-sessions')
      ).not.toContainText('0 件');
      await expect(
        modal.getByTestId('offboarding-owned-folder')
      ).toContainText(folderName);

      await modal.getByTestId('offboarding-next').click();
      await modal.getByTestId('offboarding-transfer-filter').fill(successorEmail);
      await modal
        .getByTestId('offboarding-transfer-select')
        .selectOption(successor.id);
      await modal
        .getByTestId('offboarding-shared-links-action')
        .selectOption('transfer_owner');
      await modal
        .getByTestId('offboarding-file-requests-action')
        .selectOption('transfer_owner');
      await modal.getByTestId('offboarding-user-action').selectOption('suspend');
      await expect(modal.getByTestId('offboarding-execute')).toBeDisabled();
      await modal.getByTestId('offboarding-confirm-input').fill('OFFBOARD');
      await expect(modal.getByTestId('offboarding-execute')).toBeEnabled();
      await modal.getByTestId('offboarding-execute').click();

      const summary = modal.getByTestId('offboarding-result-summary');
      await expect(summary).toContainText('オフボーディングが完了しました');
      await expect(summary).toContainText('フォルダ 1 件移管');
      await expect(summary).toContainText('共有リンク 移管 1 件');
      await expect(summary).toContainText('ファイルリクエスト 移管 1 件');
      await expect(summary).toContainText('セッション 1 件失効');
      await expect(modal.getByTestId('offboarding-result-replayed')).toHaveCount(
        0
      );
      await modal.getByTestId('offboarding-done').click();

      // The leaver is evicted in real time and cannot reuse the old cookie.
      await expect(
        leaverSession.page.getByRole('heading', {
          name: 'Files ワークスペースへサインイン',
        })
      ).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => {
          const res = await leaverSession.context.request.get('/api/auth/me');
          return res.status();
        })
        .toBe(401);

      // The successor continues to work in the transferred root folder.
      const rootList = await successorSession.context.request.get(
        '/api/folders/roots?limit=100'
      );
      expect(rootList.status()).toBe(200);
      const roots = (await rootList.json()) as {
        folders: Array<{ id: string; name: string }>;
      };
      expect(roots.folders.map((item) => item.id)).toContain(folder.id);

      const children = await getFolderChildren(
        { api: successorSession.context.request },
        folder.id
      );
      expect(children.effectiveRole).toBe('owner');
      expect(children.files.map((item) => item.name)).toContain(fileName);

      // The transferred shared link stays active with the successor as owner.
      const linksRes = await successorSession.context.request.get(
        `/api/shared-links?targetType=folder&targetId=${encodeURIComponent(
          folder.id
        )}`
      );
      expect(linksRes.status()).toBe(200);
      const linksBody = (await linksRes.json()) as {
        links: Array<{ id: string; createdBy: string }>;
      };
      expect(
        linksBody.links.find((link) => link.id === linkBody.link.id)?.createdBy
      ).toBe(successor.id);

      // The transferred file request stays active and visible to the successor.
      const requestsRes = await successorSession.context.request.get(
        `/api/file-requests?folderId=${encodeURIComponent(folder.id)}`
      );
      expect(requestsRes.status()).toBe(200);
      const requestsBody = (await requestsRes.json()) as {
        fileRequests: Array<{ id: string; title: string }>;
      };
      expect(
        requestsBody.fileRequests.some(
          (request) => request.id === requestBody.fileRequest.id
        )
      ).toBe(true);

      // The admin console reflects the suspended account.
      await members.getByTestId('member-filter-reset').click();
      await members.getByTestId('member-filter-query').fill(leaverEmail);
      await members.getByTestId('member-filter-apply').click();
      await expect(
        admin.page
          .locator('[data-testid="admin-member-row"]')
          .filter({ hasText: leaverEmail })
      ).toContainText('停止中');
    } finally {
      if (folderId) {
        await deleteFolderQuietly(
          { api: successorSession.context.request },
          folderId
        );
      }
      await leaverSession.context.close();
      await successorSession.context.close();
    }
  });
});
