import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import {
  acquireDriveLock,
  createFolder,
  findRootFolder,
  grantPermission,
  uploadFile,
  waitForLockStatus,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

function uniqueToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

test.describe('Admin content manager (TOM-65)', () => {
  test('一般メンバー所有ファイルを横断検索し、詳細検査・理由付き強制ロック解除・共有失効・confidential 検査ブロックを実ブラウザで検証する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(300_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const token = uniqueToken();
    const confidentialToken = uniqueToken();
    const lockId = `e2e-content-manager-${randomUUID()}`;
    const folderName = uniqueName('e2e-content-manager');
    const confidentialFolderName = uniqueName('e2e-content-manager-conf');

    try {
      const general = await findRootFolder(admin, '全社共有');
      const folder = await createFolder(admin, {
        parentId: general.id,
        name: folderName,
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

      // Member-owned file, member-acquired Drive lock and member-created link.
      const fileName = `content-manager-${token}.txt`;
      const uploaded = await uploadFile(member, {
        folderId: folder.id,
        name: fileName,
        content: `admin content manager fixture ${token}`,
      });
      await acquireDriveLock(member, uploaded.id, {
        lockId,
        ttlSeconds: 900,
      });
      const linkRes = await member.api.post('/api/shared-links', {
        data: {
          targetType: 'file',
          targetId: uploaded.id,
          accessScope: 'company_only',
          permissionLevel: 'view',
        },
      });
      expect(linkRes.status()).toBe(201);

      await admin.page.goto('/admin/content');
      await expect(
        admin.page.getByRole('heading', { name: 'コンテンツ', exact: true })
      ).toBeVisible();

      const manager = admin.page.getByTestId('admin-content-manager');
      await expect(manager).toBeVisible();
      const searchInput = manager.getByTestId('admin-content-query');
      const searchButton = manager.getByRole('button', {
        name: '検索',
        exact: true,
      });
      await expect(searchInput).toBeVisible();
      await expect(searchButton).toBeEnabled({ timeout: 30_000 });

      await searchInput.fill(token);
      const searchResponse = admin.page.waitForResponse((response) => {
        if (response.request().method() !== 'GET') return false;
        const url = new URL(response.url());
        return (
          url.pathname === '/api/admin/content/search' &&
          url.searchParams.get('query') === token &&
          response.ok()
        );
      });
      await searchButton.click();
      expect((await searchResponse).status()).toBe(200);

      const row = manager
        .getByTestId('admin-content-result-row')
        .filter({ hasText: fileName });
      await expect(row).toBeVisible();
      await expect(row).toContainText(member.user.displayName);
      await expect(row).toContainText(member.user.email);
      await expect(row).toContainText('Drive');

      const detailResponse = admin.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'GET' &&
          url.pathname === `/api/admin/content/file/${uploaded.id}` &&
          response.ok()
        );
      });
      await row.getByTestId('admin-content-result-open').click();
      await detailResponse;

      const inspector = admin.page.getByTestId('admin-content-inspector');
      await expect(inspector).toBeVisible();
      await expect(inspector).toContainText(fileName);
      await expect(inspector).toContainText(folderName);
      await expect(inspector).toContainText('Files Drive 排他ロック');
      await expect(inspector).toContainText(member.user.email);
      await expect(inspector).toContainText('表示のみ');
      await expect(
        inspector.getByRole('button', { name: '共有リンクを失効' })
      ).toBeVisible();

      // Audited single-use preview succeeds for a non-confidential file.
      const inspectReason = 'E2E 監査付きプレビュー確認';
      await inspector
        .getByLabel('検査理由 (3〜300文字)')
        .fill(inspectReason);
      const inspectResponse = admin.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'POST' &&
          url.pathname === `/api/admin/content/files/${uploaded.id}/inspect-preview`
        );
      });
      await inspector
        .getByRole('button', { name: '監査付きプレビューを開く' })
        .click();
      expect((await inspectResponse).status()).toBe(200);
      const inspectResult = inspector.getByTestId(
        'admin-content-inspect-result'
      );
      await expect(inspectResult).toBeVisible();
      await expect(inspectResult.getByTestId('admin-content-inspect-link')).toHaveAttribute(
        'href',
        /\/api\/storage\//
      );

      // Reason-gated force unlock must release the real FileLockHub lock.
      const unlockReason = 'E2E セキュリティ対応で強制解除';
      await inspector
        .getByLabel('強制解除の理由 (3〜300文字)')
        .fill(unlockReason);
      const unlockResponse = admin.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'POST' &&
          url.pathname ===
            `/api/admin/content/files/${uploaded.id}/force-unlock` &&
          response.ok()
        );
      });
      await inspector
        .getByRole('button', { name: 'ロックを強制解除' })
        .click();
      expect((await unlockResponse).status()).toBe(200);
      await expect(
        inspector.getByTestId('admin-content-action-notice')
      ).toContainText('ロックを強制解除しました');
      await expect(inspector).toContainText('保持中のロックはありません');

      const released = await waitForLockStatus(
        member,
        uploaded.id,
        (status) => status.lock === null
      );
      expect(released.lock).toBeNull();

      // Emergency shared-link revocation from the inspector.
      const revokeResponse = admin.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'POST' &&
          url.pathname.startsWith('/api/admin/shared-links/') &&
          url.pathname.endsWith('/revoke') &&
          response.ok()
        );
      });
      await inspector
        .getByRole('button', { name: '共有リンクを失効' })
        .click();
      expect((await revokeResponse).status()).toBe(200);
      await expect(inspector).toContainText('有効な共有リンクはありません。');

      const linksAfterRevoke = await member.api.get(
        `/api/shared-links?targetType=file&targetId=${encodeURIComponent(
          uploaded.id
        )}`
      );
      expect(linksAfterRevoke.status()).toBe(200);
      expect(
        ((await linksAfterRevoke.json()) as { links: unknown[] }).links
      ).toHaveLength(0);

      // confidential files are blocked by the deny_confidential policy even
      // with a justification; the blocked attempt is audited.
      const policyRes = await admin.api.patch('/api/admin/policies', {
        data: { adminContentInspectPolicy: 'deny_confidential' },
      });
      expect(policyRes.status()).toBe(200);
      expect(
        (
          (await policyRes.json()) as {
            policy: { adminContentInspectPolicy: string };
          }
        ).policy.adminContentInspectPolicy
      ).toBe('deny_confidential');

      const confidentialFolder = await createFolder(admin, {
        parentId: general.id,
        name: confidentialFolderName,
        classification: 'confidential',
      });
      cleanup.registerFolder(confidentialFolder.id);
      await grantPermission(admin, {
        targetType: 'folder',
        targetId: confidentialFolder.id,
        granteeType: 'user',
        granteeId: member.user.id,
        role: 'editor',
      });
      const confidentialFileName = `content-manager-conf-${confidentialToken}.txt`;
      const confidentialFile = await uploadFile(member, {
        folderId: confidentialFolder.id,
        name: confidentialFileName,
        content: `confidential admin content manager fixture ${confidentialToken}`,
      });
      expect(confidentialFile.classification).toBe('confidential');

      await inspector.getByRole('button', { name: '閉じる' }).click();
      await expect(inspector).toHaveCount(0);

      await searchInput.fill(confidentialToken);
      const confidentialSearchResponse = admin.page.waitForResponse(
        (response) => {
          if (response.request().method() !== 'GET') return false;
          const url = new URL(response.url());
          return (
            url.pathname === '/api/admin/content/search' &&
            url.searchParams.get('query') === confidentialToken &&
            response.ok()
          );
        }
      );
      await manager
        .getByRole('button', { name: '検索', exact: true })
        .click();
      await confidentialSearchResponse;

      const confidentialRow = manager
        .getByTestId('admin-content-result-row')
        .filter({ hasText: confidentialFileName });
      await expect(confidentialRow).toBeVisible();
      const confidentialDetailResponse = admin.page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === 'GET' &&
            url.pathname ===
              `/api/admin/content/file/${confidentialFile.id}` &&
            response.ok()
          );
        }
      );
      await confidentialRow.getByTestId('admin-content-result-open').click();
      await confidentialDetailResponse;

      await expect(inspector).toContainText(confidentialFileName);
      await expect(inspector).toContainText('confidential 検査禁止');
      await inspector
        .getByLabel('検査理由 (3〜300文字)')
        .fill('E2E 機密ファイル検査の試行');
      const blockedInspectResponse = admin.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'POST' &&
          url.pathname ===
            `/api/admin/content/files/${confidentialFile.id}/inspect-preview`
        );
      });
      await inspector
        .getByRole('button', { name: '監査付きプレビューを開く' })
        .click();
      expect((await blockedInspectResponse).status()).toBe(403);
      await expect(
        inspector.getByTestId('admin-content-action-error')
      ).toContainText('機密区分');
      await expect(
        inspector.getByTestId('admin-content-inspect-result')
      ).toHaveCount(0);

      const blockedAudit = await admin.api.get(
        '/api/audit-logs?action=admin.content.inspect&status=blocked&limit=10'
      );
      expect(blockedAudit.status()).toBe(200);
      const blockedLogs = (await blockedAudit.json()) as {
        logs: Array<{ action: string; status: string; targetId: string }>;
      };
      expect(
        blockedLogs.logs.some(
          (log) =>
            log.action === 'admin.content.inspect' &&
            log.status === 'blocked' &&
            log.targetId === confidentialFile.id
        )
      ).toBe(true);
    } finally {
      await admin.api
        .patch('/api/admin/policies', {
          data: { adminContentInspectPolicy: 'watermark_confidential' },
        })
        .catch(() => undefined);
    }
  });
});
