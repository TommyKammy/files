import type { Locator, Page } from '@playwright/test';
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

/**
 * Keeps the admin console / audit endpoints and drops the shared
 * auth/sync/realtime calls every page makes.
 */
function adminConsoleApiCalls(paths: string[]): string[] {
  return paths.filter(
    (path) => path.startsWith('/api/admin/') || path === '/api/audit-logs'
  );
}

function unexpectedAdminCalls(
  paths: string[],
  allowed: readonly string[]
): string[] {
  return adminConsoleApiCalls(paths).filter((path) => !allowed.includes(path));
}

interface SubrouteTabCase {
  label: string;
  path: string;
  heading: string;
  section: 'content' | 'users' | 'settings' | 'reports';
  tabs: ReadonlyArray<{
    id: string;
    label: string;
    marker: (page: Page) => Locator;
  }>;
}

const SUBROUTE_TAB_CASES: readonly SubrouteTabCase[] = [
  {
    label: 'コンテンツ',
    path: '/admin/content',
    heading: 'コンテンツ',
    section: 'content',
    tabs: [
      {
        id: 'manager',
        label: 'コンテンツマネージャー',
        marker: (page) => page.getByTestId('admin-content-manager'),
      },
      {
        id: 'root-folders',
        label: 'ルートフォルダ管理',
        marker: (page) => page.locator('#admin-root-folders'),
      },
      {
        id: 'trash',
        label: 'ゴミ箱',
        marker: (page) => page.locator('#admin-trash-heading'),
      },
      {
        id: 'file-requests',
        label: 'ファイルリクエスト',
        marker: (page) => page.getByTestId('admin-file-requests-section'),
      },
      {
        id: 'ai-classification',
        label: 'AI 分類レビュー',
        marker: (page) =>
          page.getByRole('heading', { name: /AI 機密分類/ }),
      },
    ],
  },
  {
    label: 'ユーザーとグループ',
    path: '/admin/users',
    heading: 'ユーザーとグループ',
    section: 'users',
    tabs: [
      {
        id: 'members',
        label: '管理対象ユーザー',
        marker: (page) => page.getByTestId('admin-members-section'),
      },
      {
        id: 'groups',
        label: 'グループ',
        marker: (page) => page.getByTestId('admin-groups-section'),
      },
      {
        id: 'guests',
        label: '外部コラボレーター',
        marker: (page) => page.getByTestId('admin-guests-section'),
      },
      {
        id: 'delegations',
        label: '共同管理者 (Co-Admin)',
        marker: (page) => page.getByTestId('admin-delegations-section'),
      },
    ],
  },
  {
    label: 'ガバナンスと設定',
    path: '/admin/settings',
    heading: 'ガバナンスと設定',
    section: 'settings',
    tabs: [
      {
        id: 'sharing',
        label: 'コンテンツと共有',
        marker: (page) => page.getByTestId('guest-policy-section'),
      },
      {
        id: 'access',
        label: 'アクセス制御とフォルダ構成',
        marker: (page) => page.locator('#access-control-heading'),
      },
      {
        id: 'security',
        label: 'セキュリティとセッション',
        marker: (page) => page.getByTestId('admin-auth-control-section'),
      },
      {
        id: 'compliance',
        label: 'カスタム設定・利用規約',
        marker: (page) => page.getByTestId('admin-tos-section'),
      },
      {
        id: 'integrations',
        label: '統合 (Integrations)',
        marker: (page) => page.getByTestId('admin-integrations-section'),
      },
    ],
  },
  {
    label: 'レポートと監査',
    path: '/admin/reports',
    heading: 'レポートと監査',
    section: 'reports',
    tabs: [
      {
        id: 'audit-logs',
        label: '監査ログ',
        marker: (page) => page.locator('#admin-audit-logs'),
      },
      {
        id: 'permissions',
        label: 'アクセス権監査',
        marker: (page) => page.locator('#admin-permission-audit'),
      },
      {
        id: 'jobs',
        label: 'レポート出力・定期スケジュール',
        marker: (page) => page.getByTestId('admin-reports-section'),
      },
    ],
  },
];

async function expectActiveTab(
  page: Page,
  tabCase: SubrouteTabCase,
  activeTabId: string
): Promise<void> {
  for (const tab of tabCase.tabs) {
    await expect(page.getByTestId(`admin-tab-${tab.id}`)).toHaveAttribute(
      'aria-selected',
      tab.id === activeTabId ? 'true' : 'false'
    );
  }
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe(
    activeTabId
  );
}

/**
 * The delayed-mount contract renders exactly one section panel. Nested
 * tablists (e.g. the permission audit panel) are intentionally excluded by
 * the `admin-tabpanel-` test id prefix, so this asserts the shell never
 * stacks sibling tabs below each other.
 */
async function expectOnlyTabPanel(
  page: Page,
  tabCase: SubrouteTabCase,
  activeTabId: string
): Promise<void> {
  await expect(page.getByTestId(`admin-tabpanel-${activeTabId}`)).toBeVisible();
  await expect(page.locator('[data-testid^="admin-tabpanel-"]')).toHaveCount(1);
  for (const tab of tabCase.tabs) {
    if (tab.id === activeTabId) continue;
    await expect(
      tab.marker(page),
      `${tab.label} must not be stacked underneath ${activeTabId}`
    ).toHaveCount(0);
  }
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
      // Let the delayed-mount effects of the active tab settle before
      // asserting that no sibling tab issued its own endpoint.
      await page.waitForLoadState('networkidle');
      return { page, apiPaths };
    }

    // /admin/users defaults to the `members` tab: only the member list is
    // mounted, so the guests/groups/SCIM/delegations panels (and the
    // settings bundle) must not self-fetch.
    const users = await openRoute('/admin/users', 'ユーザーとグループ', [
      '/api/admin/users',
    ]);
    for (const path of [
      '/api/admin/guests',
      '/api/admin/groups',
      '/api/admin/scim-tokens',
      '/api/admin/delegations',
      '/api/admin/policies',
      '/api/admin/settings-bundle',
    ]) {
      expect(users.apiPaths, `users tab must not call ${path}`).not.toContain(
        path
      );
    }
    expect(unexpectedAdminCalls(users.apiPaths, ['/api/admin/users'])).toEqual(
      []
    );
    await users.page.close();

    // /admin/insights: the dedicated insights aggregate (including its O(1)
    // storage snapshot) only. No other admin endpoint may be fetched.
    const insights = await openRoute('/admin/insights', 'インサイト', [
      '/api/admin/insights',
    ]);
    expect(
      unexpectedAdminCalls(insights.apiPaths, ['/api/admin/insights'])
    ).toEqual([]);
    await insights.page.close();

    // /admin/content defaults to the `manager` tab: only the content search
    // endpoint is fetched. Trash/root-folders/file-requests/AI review own
    // their endpoints and must wait for an explicit tab selection.
    const content = await openRoute('/admin/content', 'コンテンツ', [
      '/api/admin/content/search',
    ]);
    for (const path of [
      '/api/admin/ai-suggestions',
      '/api/admin/trash',
      '/api/admin/root-folders',
      '/api/admin/file-requests',
    ]) {
      expect(content.apiPaths, `content manager must not call ${path}`).not.toContain(
        path
      );
    }
    expect(
      unexpectedAdminCalls(content.apiPaths, ['/api/admin/content/search'])
    ).toEqual([]);
    await content.page.close();

    // /admin/settings defaults to the `sharing` tab: the consolidated
    // settings-bundle only (no child waterfall).
    const settings = await openRoute('/admin/settings', 'ガバナンスと設定', [
      '/api/admin/settings-bundle',
    ]);
    for (const path of [
      '/api/admin/storage-stats',
      '/api/admin/ai-suggestions',
      '/api/audit-logs',
      '/api/admin/guests',
      '/api/admin/insights',
    ]) {
      expect(settings.apiPaths).not.toContain(path);
    }
    for (const redundantPath of [
      '/api/admin/policies',
      '/api/admin/shared-links',
      '/api/admin/policies/inheritance-conflicts',
      '/api/admin/sso/status',
      '/api/admin/tos',
      '/api/admin/siem',
      '/api/admin/sessions',
      '/api/guests/invitations',
    ]) {
      expect(settings.apiPaths).not.toContain(redundantPath);
    }
    expect(
      unexpectedAdminCalls(settings.apiPaths, ['/api/admin/settings-bundle'])
    ).toEqual([]);
    await settings.page.close();

    // /admin/reports defaults to the `audit-logs` tab: the audit log feed
    // only. The permission audit panel and async report console must stay
    // unmounted until their own tab is selected.
    const reports = await openRoute('/admin/reports', 'レポートと監査', [
      '/api/audit-logs',
    ]);
    for (const path of [
      '/api/admin/permissions',
      '/api/admin/reports/jobs',
      '/api/admin/reports/schedules',
      '/api/admin/storage-stats',
      '/api/admin/ai-suggestions',
      '/api/admin/guests',
      '/api/admin/insights',
      '/api/admin/policies',
      '/api/admin/settings-bundle',
      '/api/admin/sessions',
      '/api/admin/groups',
      '/api/admin/shared-links',
    ]) {
      expect(reports.apiPaths, `audit-logs tab must not call ${path}`).not.toContain(
        path
      );
    }
    expect(
      unexpectedAdminCalls(reports.apiPaths, ['/api/audit-logs'])
    ).toEqual([]);
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
    await page.getByTestId('admin-tab-root-folders').click();
    await expect(page.getByTestId('admin-tab-root-folders')).toHaveAttribute(
      'aria-selected',
      'true'
    );
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
    await page.getByTestId('admin-tab-guests').click();
    await expect(page.getByTestId('admin-tab-guests')).toHaveAttribute(
      'aria-selected',
      'true'
    );
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

  for (const tabCase of SUBROUTE_TAB_CASES) {
    test(`${tabCase.label}: 水平タブはクリック・URL・リロード・キーボード移動で単一パネルを維持する`, async ({
      as,
    }) => {
      test.setTimeout(240_000);
      const admin = await as('sys_admin');
      const page = admin.page;
      const defaultTab = tabCase.tabs[0];
      const secondTab = tabCase.tabs[1];
      const thirdTab = tabCase.tabs[2];
      const lastTab = tabCase.tabs[tabCase.tabs.length - 1];

      await page.goto(tabCase.path);
      await expect(
        page.getByRole('heading', { name: tabCase.heading, exact: true })
      ).toBeVisible();

      const tablist = page.getByTestId('admin-section-tabs');
      await expect(tablist).toBeVisible();
      const tabButtons = tablist.getByRole('tab');
      await expect(tabButtons).toHaveCount(tabCase.tabs.length);

      // Horizontal tablist: every tab shares the same top edge and flows
      // left-to-right instead of wrapping into stacked rows.
      const tops = await tabButtons.evaluateAll((elements) =>
        elements.map((element) =>
          Math.round(element.getBoundingClientRect().top)
        )
      );
      expect(new Set(tops).size).toBe(1);
      const lefts = await tabButtons.evaluateAll((elements) =>
        elements.map((element) =>
          Math.round(element.getBoundingClientRect().left)
        )
      );
      for (let index = 1; index < lefts.length; index += 1) {
        expect(lefts[index]).toBeGreaterThan(lefts[index - 1]);
      }

      expect(new URL(page.url()).searchParams.get('tab')).toBeNull();
      for (const tab of tabCase.tabs) {
        await expect(page.getByTestId(`admin-tab-${tab.id}`)).toHaveAttribute(
          'aria-selected',
          tab.id === defaultTab.id ? 'true' : 'false'
        );
      }
      await expectOnlyTabPanel(page, tabCase, defaultTab.id);

      // Clicking a different tab updates the URL and swaps the single panel.
      await page.getByTestId(`admin-tab-${secondTab.id}`).click();
      await expectActiveTab(page, tabCase, secondTab.id);
      await expectOnlyTabPanel(page, tabCase, secondTab.id);

      // Reload restores the tab from `?tab=`.
      await page.reload();
      await expect(
        page.getByTestId(`admin-tabpanel-${secondTab.id}`)
      ).toBeVisible();
      await expectActiveTab(page, tabCase, secondTab.id);
      await expectOnlyTabPanel(page, tabCase, secondTab.id);

      // WAI-ARIA roving focus: ArrowRight / ArrowLeft wrap around, Home and
      // End jump to the edges, and selecting a tab also moves focus + URL.
      const secondButton = page.getByTestId(`admin-tab-${secondTab.id}`);
      await secondButton.focus();
      await expect(secondButton).toBeFocused();

      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId(`admin-tab-${thirdTab.id}`)).toBeFocused();
      await expectActiveTab(page, tabCase, thirdTab.id);
      await expectOnlyTabPanel(page, tabCase, thirdTab.id);

      await page.keyboard.press('ArrowLeft');
      await expect(secondButton).toBeFocused();
      await expectActiveTab(page, tabCase, secondTab.id);
      await expectOnlyTabPanel(page, tabCase, secondTab.id);

      await page.keyboard.press('Home');
      await expect(
        page.getByTestId(`admin-tab-${defaultTab.id}`)
      ).toBeFocused();
      await expectActiveTab(page, tabCase, defaultTab.id);
      await expectOnlyTabPanel(page, tabCase, defaultTab.id);

      await page.keyboard.press('End');
      await expect(page.getByTestId(`admin-tab-${lastTab.id}`)).toBeFocused();
      await expectActiveTab(page, tabCase, lastTab.id);
      await expectOnlyTabPanel(page, tabCase, lastTab.id);
    });
  }

  test('/admin/settings?tab=integrations はおすすめ統合・4 種フィルタ・インライン設定を提供する', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const page = admin.page;

    await page.goto('/admin/settings?tab=integrations');
    await expect(
      page.getByRole('heading', { name: 'ガバナンスと設定', exact: true })
    ).toBeVisible();
    await expect(page.getByTestId('admin-tab-integrations')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByTestId('admin-tabpanel-integrations')).toBeVisible();

    const section = page.getByTestId('admin-integrations-section');
    await expect(section).toBeVisible();

    // Box-style top section: a collapsed/expanded `おすすめの統合` details.
    const recommendedDetails = page.getByTestId(
      'integrations-recommended-details'
    );
    const recommendedSummary = page.getByTestId(
      'integrations-recommended-summary'
    );
    await expect(recommendedSummary).toContainText('おすすめの統合');
    await expect(recommendedDetails).toHaveJSProperty('open', true);
    await expect(
      page.getByTestId('integration-recommended-card-scim-provisioning')
    ).toBeVisible();

    await recommendedSummary.click();
    await expect(recommendedDetails).toHaveJSProperty('open', false);
    await expect(
      page.getByTestId('integration-recommended-card-scim-provisioning')
    ).toBeHidden();

    await recommendedSummary.click();
    await expect(recommendedDetails).toHaveJSProperty('open', true);
    await expect(
      page.getByTestId('integration-recommended-card-scim-provisioning')
    ).toBeVisible();

    const resultCount = page.getByTestId('integrations-filter-result-count');
    await expect(resultCount).toHaveText('5 件の統合');

    // 種別 (official / custom)
    await page.getByTestId('integrations-filter-official').selectOption('custom');
    await expect(resultCount).toHaveText('1 件の統合');
    await expect(page.getByTestId('integration-card-siem-webhook')).toBeVisible();
    await expect(
      page.getByTestId('integration-card-scim-provisioning')
    ).toHaveCount(0);
    await page.getByTestId('integrations-filter-reset').click();
    await expect(resultCount).toHaveText('5 件の統合');

    // カテゴリ (ID 管理)
    await page
      .getByTestId('integrations-filter-category')
      .selectOption('identity');
    await expect(resultCount).toHaveText('2 件の統合');
    await expect(
      page.getByTestId('integration-card-scim-provisioning')
    ).toBeVisible();
    await expect(page.getByTestId('integration-card-oidc-sso')).toBeVisible();
    await expect(
      page.getByTestId('integration-card-siem-webhook')
    ).toHaveCount(0);
    await page.getByTestId('integrations-filter-reset').click();

    // 利用状況 (未設定) — assert every visible card reports that status.
    await page
      .getByTestId('integrations-filter-status')
      .selectOption('not_configured');
    const statusCards = page.locator('[data-testid^="integration-card-"]');
    const visibleStatuses = await statusCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute('data-integration-status'))
    );
    expect(visibleStatuses.length).toBeGreaterThan(0);
    expect(new Set(visibleStatuses)).toEqual(new Set(['not_configured']));
    await expect(resultCount).toHaveText(
      `${visibleStatuses.length} 件の統合`
    );
    await page.getByTestId('integrations-filter-reset').click();

    // 注目 (featured only)
    await page.getByTestId('integrations-filter-featured').check();
    await expect(resultCount).toHaveText('4 件の統合');
    await expect(
      page.getByTestId('integration-card-workers-ai-classification')
    ).toHaveCount(0);
    await page.getByTestId('integrations-filter-reset').click();
    await expect(resultCount).toHaveText('5 件の統合');

    // Search query
    await page.getByTestId('integrations-filter-query').fill('SIEM');
    await expect(resultCount).toHaveText('1 件の統合');
    await expect(page.getByTestId('integration-card-siem-webhook')).toBeVisible();
    await expect(page.getByTestId('integration-card-oidc-sso')).toHaveCount(0);
    await page.getByTestId('integrations-filter-reset').click();
    await expect(resultCount).toHaveText('5 件の統合');

    // In-place SCIM token + SIEM configuration panels (no tab jump).
    const inlineConfig = page.getByTestId('integrations-inline-config');
    await expect(
      inlineConfig.getByTestId('admin-scim-tokens-section')
    ).toBeVisible();
    await expect(
      inlineConfig.getByTestId('admin-siem-section')
    ).toBeVisible();
    await expect(page.getByTestId('scim-endpoint-base-url')).toBeVisible();
    await expect(page.getByTestId('admin-siem-url')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=integrations$/);
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
