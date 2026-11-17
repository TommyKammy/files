import { expect, test, DEV_USERS } from './fixtures';

/**
 * P13-1 / TOM-73 end-to-end Co-Admin delegation journey.
 *
 * The sys_admin grants the seeded ordinary member the "auditor" preset, then
 * a second browser context proves the rail/nav, focused routes, denied deep
 * links and API 403s work without touching the sys_admin / sec_admin flow.
 */
test.describe('Admin Co-Admin delegations (TOM-73)', () => {
  test('監査専任の付与・別コンテキスト利用・削除後の即時失効', async ({ as }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const member = await as('member');
    let delegationId: string | null = null;

    try {
      // Grant from the user-visible `/admin/users` console, not only via API.
      await admin.page.goto('/admin/users');
      await expect(
        admin.page.getByRole('heading', {
          name: 'ユーザーとグループ',
          exact: true,
        })
      ).toBeVisible();
      await expect(admin.page.getByTestId('admin-tab-members')).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await admin.page.getByTestId('admin-tab-delegations').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-delegations')
      ).toBeVisible();
      await expect(
        admin.page.getByTestId('delegation-create-open')
      ).toBeVisible();
      await admin.page.getByTestId('delegation-create-open').click();
      await admin.page
        .getByTestId('delegation-user-select')
        .selectOption(DEV_USERS.member.id);
      await admin.page.getByTestId('delegation-preset-auditor').click();
      await admin.page
        .locator('input[placeholder="例: 2026 Q4 監査対応"]')
        .fill('E2E TOM-73');
      await admin.page.getByTestId('delegation-submit').click();
      await expect(
        admin.page.getByTestId(`delegation-row-${DEV_USERS.member.id}`)
      ).toBeVisible();

      const listed = await admin.api.get('/api/admin/delegations');
      expect(listed.status()).toBe(200);
      const listedBody = (await listed.json()) as {
        delegations: Array<{
          id: string;
          userId: string;
          permissions: string[];
        }>;
      };
      const granted = listedBody.delegations.find(
        (item) => item.userId === DEV_USERS.member.id
      );
      expect(granted).toBeTruthy();
      delegationId = granted!.id;
      expect(granted!.permissions).toEqual([
        'admin.insights.read',
        'admin.audit.read',
        'admin.reports.run',
        'admin.policies.read',
      ]);

      // A fresh document load re-runs `/api/sync/bootstrap`, so the member's
      // existing cookie session immediately sees the new projection.
      await member.page.goto('/admin/insights');
      await expect(
        member.page.getByRole('link', { name: 'ガバナンス', exact: true })
      ).toBeVisible();
      await expect(
        member.page.getByRole('heading', { name: 'インサイト', exact: true })
      ).toBeVisible();
      await expect(
        member.page.getByTestId('admin-console-role-badge')
      ).toContainText('共同管理者');

      const visibleSections = await member.page
        .locator('[data-admin-section]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-admin-section'))
        );
      expect(visibleSections).toEqual(['all', 'insights', 'reports']);
      await expect(
        member.page.getByRole('link', { name: 'ユーザーとグループ', exact: true })
      ).toHaveCount(0);
      await expect(
        member.page.getByRole('link', { name: 'コンテンツ', exact: true })
      ).toHaveCount(0);
      await expect(
        member.page.getByRole('link', { name: 'ガバナンスと設定', exact: true })
      ).toHaveCount(0);

      // The permitted focused routes still work for the delegated member.
      await member.page.getByRole('link', { name: 'レポートと監査', exact: true }).click();
      await expect(member.page).toHaveURL(/\/admin\/reports$/);
      await expect(
        member.page.getByRole('heading', { name: 'レポートと監査', exact: true })
      ).toBeVisible();

      // A direct deep link to an undelegated section shows guidance and does
      // not mount the section API surface.
      await member.page.goto('/admin/users');
      await expect(member.page.getByTestId('admin-section-denied')).toBeVisible();
      await expect(member.page.getByText('権限がありません')).toBeVisible();
      await expect(
        member.page.getByRole('link', { name: 'インサイト', exact: true })
      ).toBeVisible();
      await expect(
        member.page.getByRole('link', { name: 'レポートと監査', exact: true })
      ).toBeVisible();

      // Server-side enforcement is the source of truth for undelegated and
      // sys_admin-only mutations.
      const createUser = await member.api.post('/api/admin/users', {
        data: {
          email: 'e2e-delegated-create@example.com',
          displayName: 'Delegated Create',
        },
      });
      expect(createUser.status()).toBe(403);
      const patchPolicies = await member.api.patch('/api/admin/policies', {
        data: { enforceCompanyOnlyLinks: true },
      });
      expect(patchPolicies.status()).toBe(403);
      const undelegatedUsers = await member.api.get('/api/admin/users');
      expect(undelegatedUsers.status()).toBe(403);
      const delegatedInsights = await member.api.get('/api/admin/insights');
      expect(delegatedInsights.status()).toBe(200);

      // Removing the delegation takes effect on the next request; no re-login
      // or session revocation is needed.
      const removed = await admin.api.delete(
        `/api/admin/delegations/${encodeURIComponent(delegationId)}`
      );
      expect(removed.status()).toBe(200);
      delegationId = null;

      const meAfter = await member.api.get('/api/auth/me');
      expect(meAfter.status()).toBe(200);
      const meAfterBody = (await meAfter.json()) as {
        user: { adminCapabilities: string[]; adminScope: unknown };
      };
      expect(meAfterBody.user.adminCapabilities).toEqual([]);
      expect(meAfterBody.user.adminScope).toBeNull();

      const insightsAfter = await member.api.get('/api/admin/insights');
      expect(insightsAfter.status()).toBe(403);

      await member.page.goto('/admin');
      await expect(
        member.page.getByText('アクセス権限がありません (403)')
      ).toBeVisible();
      await expect(
        member.page.getByRole('link', { name: 'ガバナンス', exact: true })
      ).toHaveCount(0);
      await expect(member.page.getByTestId('admin-console-nav')).toHaveCount(0);
    } finally {
      if (delegationId) {
        await admin.api
          .delete(`/api/admin/delegations/${encodeURIComponent(delegationId)}`)
          .catch(() => undefined);
      }
    }
  });

  test('既存の sys_admin / sec_admin ナビは完全な 6 タブのまま', async ({ as }) => {
    const sysAdmin = await as('sys_admin');
    await sysAdmin.page.goto('/admin');
    await expect(
      sysAdmin.page.getByTestId('admin-console-role-badge')
    ).toContainText('システム管理者');

    const sysSections = await sysAdmin.page
      .locator('[data-admin-section]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-admin-section'))
      );
    expect(sysSections).toEqual([
      'all',
      'insights',
      'content',
      'users',
      'settings',
      'reports',
    ]);

    const secAdmin = await as('sec_admin');
    await secAdmin.page.goto('/admin/users');
    await expect(
      secAdmin.page.getByTestId('admin-console-role-badge')
    ).toContainText('セキュリティ管理者');
    await expect(
      secAdmin.page.getByTestId('admin-console-nav')
    ).toBeVisible();
    await expect(
      secAdmin.page.getByRole('heading', {
        name: 'ユーザーとグループ',
        exact: true,
      })
    ).toBeVisible();
  });
});
