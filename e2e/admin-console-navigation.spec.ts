import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const ADMIN_ROUTES = [
  {
    href: '/admin',
    label: 'すべて（統合ビュー）',
    heading: 'ガバナンス & セキュリティ統合ダッシュボード',
  },
  { href: '/admin/insights', label: 'インサイト', heading: 'インサイト' },
  { href: '/admin/content', label: 'コンテンツ', heading: 'コンテンツ' },
  {
    href: '/admin/users',
    label: 'ユーザーとグループ',
    heading: 'ユーザーとグループ',
  },
  {
    href: '/admin/settings',
    label: 'ガバナンスと設定',
    heading: 'ガバナンスと設定',
  },
  {
    href: '/admin/reports',
    label: 'レポートと監査',
    heading: 'レポートと監査',
  },
] as const;

function navLink(page: Page, label: string) {
  return page.getByRole('link', { name: label, exact: true });
}

function recordApiRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      paths.push(url.pathname);
    }
  });
  return paths;
}

test.describe('Admin console multi-view navigation (TOM-63)', () => {
  test('統合ビューと全5サブルートを遷移・再読込でき、サブナビが現在地を示す', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const page = admin.page;

    await page.goto('/admin');
    await expect(
      page.getByRole('heading', {
        name: 'ガバナンス & セキュリティ統合ダッシュボード',
        exact: true,
      })
    ).toBeVisible();

    for (const route of ADMIN_ROUTES) {
      await navLink(page, route.label).click();
      await expect(page).toHaveURL(new RegExp(`${route.href.replace(/\//g, '\\/')}$`));
      await expect(navLink(page, route.label)).toHaveAttribute(
        'aria-current',
        'page'
      );
      await expect(
        page.getByRole('heading', { name: route.heading, exact: true })
      ).toBeVisible();

      // A hard reload proves every subroute is a real App Router entry point,
      // not only a client-side projection of the integrated view.
      await page.reload();
      await expect(
        page.getByRole('heading', { name: route.heading, exact: true })
      ).toBeVisible();
      await expect(navLink(page, route.label)).toHaveAttribute(
        'aria-current',
        'page'
      );
      await expect(page.getByTestId('admin-console-nav')).toBeVisible();
    }
  });

  test('サブナビはキーボードフォーカスで前後に移動できる', async ({ as }) => {
    const admin = await as('sys_admin');
    const page = admin.page;

    await page.goto('/admin');
    const insights = navLink(page, 'インサイト');
    const content = navLink(page, 'コンテンツ');

    await insights.focus();
    await expect(insights).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(content).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(insights).toBeFocused();
  });

  test('モバイル幅でもサブナビが表示され、レポートへ遷移できる', async ({
    as,
  }) => {
    const secAdmin = await as('sec_admin');
    const page = secAdmin.page;

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/users');
    await expect(page.getByTestId('admin-console-nav')).toBeVisible();
    await expect(
      page.getByTestId('admin-console-role-badge')
    ).toContainText('sec_admin');

    await navLink(page, 'レポートと監査').click();
    await expect(page).toHaveURL(/\/admin\/reports$/);
    await expect(navLink(page, 'レポートと監査')).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  test('フォーカスルートは他セクションの API を呼ばない', async ({ as }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');

    async function openRoute(
      href: string,
      heading: string,
      expectedPaths: string[]
    ): Promise<{ page: Page; apiPaths: string[] }> {
      // Each view gets a fresh page so a request still settling on the
      // previous route can never be attributed to the focused route.
      const page = await admin.context.newPage();
      const apiPaths = recordApiRequests(page);
      await page.goto(href);
      await expect(
        page.getByRole('heading', { name: heading, exact: true })
      ).toBeVisible();
      for (const path of expectedPaths) {
        await expect.poll(() => apiPaths.includes(path)).toBe(true);
      }
      return { page, apiPaths };
    }

    const forbidden = [
      '/api/admin/storage-stats',
      '/api/admin/ai-suggestions',
      '/api/audit-logs',
      '/api/admin/guests',
      '/api/admin/insights',
    ];

    // /admin/users: only the guest section self-fetches.
    const users = await openRoute('/admin/users', 'ユーザーとグループ', [
      '/api/admin/guests',
    ]);
    for (const path of forbidden.filter(
      (path) => path !== '/api/admin/guests'
    )) {
      expect(users.apiPaths).not.toContain(path);
    }
    expect(users.apiPaths).not.toContain('/api/admin/policies');
    await users.page.close();

    // /admin/insights: the dedicated insights aggregate (including its O(1)
    // storage snapshot) only. No other admin endpoint may be fetched.
    const insights = await openRoute('/admin/insights', 'インサイト', [
      '/api/admin/insights',
    ]);
    for (const path of forbidden.filter(
      (path) => path !== '/api/admin/insights'
    )) {
      expect(insights.apiPaths).not.toContain(path);
    }
    await insights.page.close();

    // /admin/content: AI suggestions from the dashboard hook. Root folders
    // and Trash self-fetch through their own endpoints (Trash also loads its
    // own restore/purge timeline via /api/audit-logs).
    const content = await openRoute('/admin/content', 'コンテンツ', [
      '/api/admin/ai-suggestions',
    ]);
    for (const path of forbidden.filter(
      (path) =>
        path !== '/api/admin/ai-suggestions' && path !== '/api/audit-logs'
    )) {
      expect(content.apiPaths).not.toContain(path);
    }
    await content.page.close();

    // /admin/settings: policies, shared links and inheritance conflicts.
    const settings = await openRoute('/admin/settings', 'ガバナンスと設定', [
      '/api/admin/policies',
      '/api/admin/shared-links',
      '/api/admin/policies/inheritance-conflicts',
    ]);
    for (const path of forbidden) {
      expect(settings.apiPaths).not.toContain(path);
    }
    await settings.page.close();

    // /admin/reports: audit logs from the dashboard hook; the permission
    // audit panel self-fetches /api/admin/permissions.
    const reports = await openRoute('/admin/reports', 'レポートと監査', [
      '/api/audit-logs',
      '/api/admin/permissions',
    ]);
    expect(reports.apiPaths).not.toContain('/api/admin/storage-stats');
    expect(reports.apiPaths).not.toContain('/api/admin/ai-suggestions');
    expect(reports.apiPaths).not.toContain('/api/admin/guests');
    await reports.page.close();
  });

  test('コンテンツ/ユーザーから監査プリセット付きレポートへ遷移する', async ({
    as,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const page = admin.page;

    await page.goto('/admin/content');
    await expect(
      page.getByRole('heading', { name: 'コンテンツ', exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'ルートフォルダ管理', exact: true })
    ).toBeVisible();

    const rootFolderAuditRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/audit-logs' &&
        url.searchParams
          .get('actions')
          ?.includes('admin.root_folder.create') === true
      );
    });
    await page.getByRole('button', { name: '監査ログを表示' }).click();
    await rootFolderAuditRequest;
    await expect(page).toHaveURL(
      /\/admin\/reports\?auditPreset=rootFolder$/
    );
    await expect(navLink(page, 'レポートと監査')).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(page.getByText('ルートフォルダ監査のみ')).toBeVisible();

    await page.goto('/admin/users');
    await expect(
      page.getByRole('heading', { name: 'ユーザーとグループ', exact: true })
    ).toBeVisible();
    const guestAuditRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/audit-logs' &&
        url.searchParams
          .get('actionPrefixes')
          ?.includes('admin.guest.') === true
      );
    });
    await page.getByRole('button', { name: 'ゲスト監査ログを表示' }).click();
    await guestAuditRequest;
    await expect(page).toHaveURL(/\/admin\/reports\?auditPreset=guest$/);
    await expect(page.getByText('ゲスト監査のみ')).toBeVisible();
  });

  test('sys_admin / sec_admin の権限バッジを表示し、member は 403 で拒否する', async ({
    as,
  }) => {
    const sysAdmin = await as('sys_admin');
    await sysAdmin.page.goto('/admin');
    await expect(
      sysAdmin.page.getByTestId('admin-console-role-badge')
    ).toHaveText('システム管理者 (sys_admin)');
    await expect(
      sysAdmin.page.getByTestId('admin-console-role-badge')
    ).toHaveAttribute('data-role', 'sys_admin');

    const secAdmin = await as('sec_admin');
    await secAdmin.page.goto('/admin/users');
    await expect(
      secAdmin.page.getByTestId('admin-console-role-badge')
    ).toHaveText('セキュリティ管理者 (sec_admin)');
    await expect(
      secAdmin.page.getByTestId('admin-console-role-badge')
    ).toHaveAttribute('data-role', 'sec_admin');

    const member = await as('member');
    await member.page.goto('/admin/users');
    await expect(
      member.page.getByText('アクセス権限がありません (403)')
    ).toBeVisible();
    await expect(member.page.getByTestId('admin-console-nav')).toHaveCount(0);
    await expect(
      member.page.getByRole('heading', {
        name: 'ユーザーとグループ',
        exact: true,
      })
    ).toHaveCount(0);
  });
});
