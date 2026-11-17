import { expect, test } from './fixtures';
import type { RoleSession } from './fixtures';

const SEEDED_FOLDER_ID = 'folder-root-general';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function resetCompliance(admin: RoleSession): Promise<void> {
  const tos = await admin.api.put('/api/admin/tos', {
    data: { enabled: false },
  });
  expect(tos.status()).toBe(200);
  const policies = await admin.api.patch('/api/admin/policies', {
    data: {
      allowFileRequests: true,
      fileRequestMaxSizeBytes: 104857600,
      fileRequestEnforceAllowedExtensions: false,
      brandingOrgName: null,
      brandingContactInfo: null,
      brandingFooterNote: null,
      quotaWarnThresholdPct: 80,
      quotaCriticalThresholdPct: 90,
    },
  });
  expect(policies.status()).toBe(200);
  const siem = await admin.api.put('/api/admin/siem', {
    data: { enabled: false, url: null, clearSecret: true },
  });
  expect(siem.status()).toBe(200);
}

test.describe('カスタム ToS・ファイルリクエスト全社ガバナンス・ブランディング (TOM-72)', () => {
  test('ToS 有効化 → 別コンテキストのメンバーが同意するまでブロック → 同意で解放', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const suffix = uniqueSuffix();
    const title = `E2E 利用規約 ${suffix}`;

    try {
      await resetCompliance(admin);

      await admin.page.goto('/admin/settings');
      await admin.page.getByTestId('admin-tab-compliance').click();
      await expect(admin.page).toHaveURL(
        /\/admin\/settings\?tab=compliance$/
      );
      const tosSection = admin.page.getByTestId('admin-tos-section');
      await expect(tosSection).toBeVisible();
      await expect(
        admin.page.getByRole('heading', {
          name: 'カスタム利用規約 (ToS) 同意管理',
        })
      ).toBeVisible();

      await tosSection.getByTestId('admin-tos-enabled').check();
      await tosSection.getByTestId('admin-tos-audience').selectOption('all_users');
      await tosSection.getByTestId('admin-tos-title').fill(title);
      await tosSection
        .getByTestId('admin-tos-body')
        .fill('# 第1条\n\nE2E テスト用の利用規約です。\n\n- 機密情報を適切に扱うこと');
      await tosSection.getByTestId('admin-tos-save').click();
      await expect(tosSection.getByTestId('admin-tos-notice')).toContainText(
        '利用規約を保存しました'
      );

      await member.page.goto('/workspace');
      const modal = member.page.getByTestId('tos-acceptance-modal');
      await expect(modal).toBeVisible();
      await expect(modal).toContainText(title);
      await expect(modal).toContainText('第1条');
      await expect(modal.getByTestId('tos-acceptance-submit')).toBeDisabled();

      await modal.getByTestId('tos-acceptance-checkbox').check();
      await modal.getByTestId('tos-acceptance-submit').click();

      // Acceptance reloads the workspace, so the blocking modal disappears
      // without a manual refresh.
      await expect(member.page.getByTestId('tos-acceptance-modal')).toHaveCount(0);
      const status = await member.api.get('/api/auth/tos');
      expect(status.status()).toBe(200);
      const statusBody = (await status.json()) as {
        tos: { requiresAcceptance: boolean; version: number };
      };
      expect(statusBody.tos.requiresAcceptance).toBe(false);

      const workspace = await member.api.get('/api/shared-items');
      expect(workspace.status()).toBe(200);
    } finally {
      await resetCompliance(admin);
    }
  });

  test('ファイルリクエスト作成 → 全社一覧 → 緊急停止 → 公開ページ停止', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const suffix = uniqueSuffix();
    const title = `E2E 収集ボックス ${suffix}`;
    let requestId: string | null = null;
    let token: string | null = null;

    try {
      await resetCompliance(admin);

      const create = await member.api.post('/api/file-requests', {
        data: { folderId: SEEDED_FOLDER_ID, title },
      });
      expect(create.status()).toBe(201);
      const created = (await create.json()) as {
        fileRequest: { id: string };
        token: string;
      };
      requestId = created.fileRequest.id;
      token = created.token;

      const publicBefore = await admin.api.get(`/api/fr/${token}`);
      expect(publicBefore.status()).toBe(200);

      await admin.page.goto('/admin/content');
      await admin.page.getByTestId('admin-tab-file-requests').click();
      await expect(admin.page).toHaveURL(
        /\/admin\/content\?tab=file-requests$/
      );
      const section = admin.page.getByTestId('admin-file-requests-section');
      await expect(section).toBeVisible();
      const row = section
        .getByTestId('admin-file-request-row')
        .filter({ hasText: title });
      await expect(row).toBeVisible();
      await expect(row).toContainText('受付中');
      await expect(row).toContainText('全社共有');

      await row.getByTestId(`admin-file-request-disable-${requestId}`).click();
      await expect(
        section.getByTestId('admin-file-request-notice')
      ).toContainText('緊急停止しました');
      await expect(row).toContainText('停止済み');

      await admin.page.goto(`/fr/${token}`);
      await expect(
        admin.page.getByRole('heading', {
          name: 'このファイル収集リンクは現在利用できません',
        })
      ).toBeVisible();
      const publicAfter = await admin.api.get(`/api/fr/${token}`);
      expect(publicAfter.status()).toBe(410);
      const publicBody = (await publicAfter.json()) as { code?: string };
      expect(publicBody.code).toBe('REQUEST_CLOSED');
    } finally {
      if (requestId) {
        await admin.api
          .post(`/api/admin/file-requests/${encodeURIComponent(requestId)}/disable`)
          .catch(() => undefined);
      }
      await resetCompliance(admin);
    }
  });

  test('テナントブランディング設定 → 共有リンク画面に組織名と法務フッターを表示', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    const suffix = uniqueSuffix();
    const orgName = `E2E 組織 ${suffix}`;
    const contactInfo = 'e2e-security@example.com';
    const footerNote = `社外秘 / E2E 法務注記 ${suffix}`;
    let linkToken: string | null = null;

    try {
      await resetCompliance(admin);

      const link = await member.api.post('/api/shared-links', {
        data: {
          targetType: 'folder',
          targetId: SEEDED_FOLDER_ID,
          accessScope: 'company_only',
        },
      });
      expect(link.status()).toBe(201);
      linkToken = ((await link.json()) as { token: string }).token;

      await admin.page.goto('/admin/settings');
      await admin.page.getByTestId('admin-tab-compliance').click();
      await expect(admin.page).toHaveURL(
        /\/admin\/settings\?tab=compliance$/
      );
      const section = admin.page.getByTestId('admin-governance-policy-section');
      await expect(section).toBeVisible();
      await section.getByTestId('admin-branding-org-name').fill(orgName);
      await section.getByTestId('admin-branding-contact-info').fill(contactInfo);
      await section.getByTestId('admin-branding-footer-note').fill(footerNote);
      await section.getByTestId('admin-governance-policy-save').click();
      await expect(
        section.getByTestId('admin-governance-policy-notice')
      ).toContainText('保存しました');

      await member.page.goto(`/s/${linkToken}`);
      await expect(
        member.page.getByTestId('shared-link-branding-org')
      ).toContainText(orgName);
      await expect(
        member.page.getByTestId('shared-link-branding-footer')
      ).toContainText(footerNote);
      await expect(member.page.getByText(`お問い合わせ: ${contactInfo}`)).toBeVisible();
    } finally {
      await resetCompliance(admin);
    }
  });
});
