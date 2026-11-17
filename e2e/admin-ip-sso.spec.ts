import { expect, test, DEV_USERS } from './fixtures';
import type { RoleSession } from './fixtures';

const BLOCKED_ENTRY = '203.0.113.250';

async function resetAuthControls(admin: RoleSession): Promise<void> {
  const response = await admin.api.patch('/api/admin/policies', {
    data: {
      ipAllowlistEnabled: false,
      ipAllowlistScope: 'admin_only',
      ipAllowlist: [],
      requireSsoLogin: false,
      ssoAllowedDomains: [],
    },
  });
  expect(response.status()).toBe(200);
}

test.describe('IP 許可リスト & OIDC SSO 認証統制 (TOM-66)', () => {
  test('Flow A: 自己ロックアウト防止 → 現在 IP 追加 → スコープ保存 → リロード永続化', async ({
    as,
  }) => {
    const admin = await as('sys_admin');
    try {
      await resetAuthControls(admin);

      await admin.page.goto('/admin/settings');
      const section = admin.page.getByTestId('ip-allowlist-section');
      await expect(section).toBeVisible();
      await expect(
        admin.page.getByRole('heading', {
          name: 'IP 許可リスト & OIDC SSO 認証統制',
        })
      ).toBeVisible();

      // 1. Enable the allowlist with an entry that excludes the operator IP.
      await section.getByTestId('ip-allowlist-input').fill(BLOCKED_ENTRY);
      await section.getByTestId('ip-allowlist-add').click();
      await expect(
        section
          .getByTestId('ip-allowlist-entry')
          .filter({ hasText: BLOCKED_ENTRY })
      ).toBeVisible();
      await section.getByTestId('ip-allowlist-enabled').check();
      await section.getByTestId('ip-allowlist-save').click();

      const lockoutError = section.getByTestId('ip-allowlist-error');
      await expect(lockoutError).toBeVisible();
      await expect(lockoutError).toContainText('SELF_IP_LOCKOUT_PREVENTED');
      await expect(lockoutError).toContainText('自己ロックアウト');

      // 2. Add the current client IP with the one-click action.
      const currentIp = (
        await section.getByTestId('ip-allowlist-current-ip').innerText()
      ).trim();
      expect(currentIp).not.toBe('');
      expect(currentIp).not.toBe('取得中...');

      await section
        .getByRole('button', {
          name: `${BLOCKED_ENTRY} を許可リストから削除`,
        })
        .click();
      await section.getByTestId('ip-allowlist-add-current').click();
      await expect(
        section
          .getByTestId('ip-allowlist-entry')
          .filter({ hasText: currentIp })
      ).toBeVisible();

      // 3. Widen the scope and persist.
      await section
        .getByTestId('ip-allowlist-scope')
        .selectOption('internal_users');
      await section.getByTestId('ip-allowlist-save').click();
      await expect(section.getByTestId('ip-allowlist-notice')).toContainText(
        'IP 許可リストを保存しました'
      );

      // 4. Reload and verify D1 persistence.
      await admin.page.reload();
      const reloaded = admin.page.getByTestId('ip-allowlist-section');
      await expect(reloaded).toBeVisible();
      await expect(reloaded.getByTestId('ip-allowlist-enabled')).toBeChecked();
      await expect(reloaded.getByTestId('ip-allowlist-scope')).toHaveValue(
        'internal_users'
      );
      await expect(
        reloaded
          .getByTestId('ip-allowlist-entry')
          .filter({ hasText: currentIp })
      ).toBeVisible();
      await expect(reloaded.getByTestId('ip-allowlist-notice')).toHaveCount(0);
    } finally {
      await resetAuthControls(admin);
    }
  });

  test('Flow B: SSO ステータス確認 → require_sso_login 有効化で別コンテキストの dev-login を拒否 → クリーン復元', async ({
    as,
    baseURL,
    playwright,
  }) => {
    const admin = await as('sys_admin');
    try {
      await resetAuthControls(admin);

      await admin.page.goto('/admin/settings');
      const statusSection = admin.page.getByTestId('sso-status-section');
      await expect(statusSection).toBeVisible();
      await expect(statusSection).toContainText('ENVIRONMENT');
      await expect(statusSection).toContainText('ALLOW_DEV_AUTH');
      await expect(statusSection).toContainText('現在の接続元 IP');
      await expect(statusSection).toContainText('/auth/callback');
      // E2E intentionally runs without a real IdP; the empty state must be
      // explicit instead of pretending a provider is configured.
      await expect(admin.page.getByTestId('sso-provider-empty')).toContainText(
        '構成済みの IdP'
      );

      const policySection = admin.page.getByTestId('sso-policy-section');
      await expect(policySection).toBeVisible();
      await policySection.getByTestId('sso-domain-input').fill('@Example.COM');
      await policySection.getByTestId('sso-domain-add').click();
      await expect(
        policySection
          .getByTestId('sso-domain-entry')
          .filter({ hasText: '@example.com' })
      ).toBeVisible();
      await policySection.getByTestId('require-sso-login').check();
      await policySection.getByTestId('sso-policy-save').click();
      await expect(
        policySection.getByTestId('sso-policy-notice')
      ).toContainText('OIDC SSO ログインを必須にしました');

      expect(baseURL).toBeTruthy();
      const anonymous = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { Origin: baseURL! },
      });
      try {
        const devLogin = await anonymous.post('/auth/dev-login', {
          data: { userId: DEV_USERS.member.id },
        });
        expect(devLogin.status()).toBe(403);
        const devLoginBody = (await devLogin.json()) as { code?: string };
        expect(devLoginBody.code).toBe('SSO_LOGIN_REQUIRED');
      } finally {
        await anonymous.dispose();
      }

      // Existing D1 session cookies remain valid, so the admin can still
      // inspect and roll back the policy.
      await admin.page.reload();
      const reloaded = admin.page.getByTestId('sso-policy-section');
      await expect(reloaded).toBeVisible();
      await expect(reloaded.getByTestId('require-sso-login')).toBeChecked();
      await expect(
        reloaded
          .getByTestId('sso-domain-entry')
          .filter({ hasText: '@example.com' })
      ).toBeVisible();
    } finally {
      await resetAuthControls(admin);
    }
  });
});
