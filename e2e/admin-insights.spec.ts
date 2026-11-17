import { expect, test } from './fixtures';

test.describe('Admin insights dashboard (TOM-67)', () => {
  test('KPI カード・7/30日切替・SVG チャート・トレンドテーブルを表示する', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const page = admin.page;

    const initialRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/admin/insights' &&
        url.searchParams.get('days') === '7'
      );
    });
    await page.goto('/admin/insights');
    await initialRequest;

    await expect(
      page.getByRole('heading', { name: 'インサイト', exact: true })
    ).toBeVisible();
    await expect(page.getByTestId('admin-insights-dashboard')).toBeVisible();
    await expect(
      page.getByText('ストレージ使用量 & 機密分類内訳')
    ).toBeVisible();

    for (const testId of [
      'insights-kpi-unset-shared',
      'insights-kpi-locked',
      'insights-kpi-blocked',
      'insights-kpi-public-links',
      'insights-kpi-members',
      'insights-kpi-guests',
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
    await expect(page.getByTestId('insights-kpi-blocked')).toContainText(
      'セキュリティブロック (7日)'
    );
    await expect(page.getByTestId('insights-blocked-breakdown')).toBeVisible();
    await expect(page.getByTestId('insights-blocked-dlp')).toBeVisible();
    await expect(page.getByTestId('insights-blocked-password')).toBeVisible();
    await expect(page.getByTestId('insights-blocked-domain')).toBeVisible();
    await expect(page.getByTestId('insights-blocked-ip')).toBeVisible();

    await expect(page.getByTestId('insights-trend-chart')).toBeVisible();
    await expect(page.getByTestId('insights-trend-table')).toBeVisible();
    await expect(page.getByTestId('insights-trend-row')).toHaveCount(7);

    const thirtyDayRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/admin/insights' &&
        url.searchParams.get('days') === '30'
      );
    });
    await page.getByTestId('insights-range-30').click();
    await thirtyDayRequest;

    await expect(page.getByTestId('insights-range-30')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByTestId('insights-kpi-blocked')).toContainText(
      'セキュリティブロック (30日)'
    );
    await expect(page.getByTestId('insights-trend-row')).toHaveCount(30);

    await page.getByTestId('insights-range-7').click();
    await expect(page.getByTestId('insights-range-7')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByTestId('insights-trend-row')).toHaveCount(7);
  });

  test('KPI からブロック監査・コンテンツ・ユーザー・設定へドリルダウンする', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const page = admin.page;

    await page.goto('/admin/insights');
    await expect(page.getByTestId('admin-insights-dashboard')).toBeVisible();

    const blockedAuditRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/audit-logs' &&
        url.searchParams.get('actions')?.includes('auth.ip_blocked') === true
      );
    });
    await page.getByTestId('insights-kpi-blocked').click();
    await blockedAuditRequest;
    await expect(page).toHaveURL(
      /\/admin\/reports\?auditPreset=security$/
    );
    await expect(
      page.getByRole('heading', { name: 'レポートと監査', exact: true })
    ).toBeVisible();
    await expect(page.getByText('セキュリティブロック監査のみ')).toBeVisible();

    await page.goto('/admin/insights');
    await expect(page.getByTestId('admin-insights-dashboard')).toBeVisible();
    await page.getByTestId('insights-kpi-unset-shared').click();
    await expect(page).toHaveURL(/\/admin\/content$/);
    await expect(
      page.getByRole('heading', { name: 'コンテンツ', exact: true })
    ).toBeVisible();

    await page.goto('/admin/insights');
    await expect(page.getByTestId('admin-insights-dashboard')).toBeVisible();
    await page.getByTestId('insights-kpi-members').click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(
      page.getByRole('heading', { name: 'ユーザーとグループ', exact: true })
    ).toBeVisible();

    await page.goto('/admin/insights');
    await expect(page.getByTestId('admin-insights-dashboard')).toBeVisible();
    await page.getByTestId('insights-kpi-public-links').click();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(
      page.getByRole('heading', { name: 'ガバナンスと設定', exact: true })
    ).toBeVisible();
  });

  test('member はインサイト画面と API の両方で拒否される', async ({ as }) => {
    test.setTimeout(180_000);
    const member = await as('member');
    await member.page.goto('/admin/insights');
    await expect(
      member.page.getByText('アクセス権限がありません (403)')
    ).toBeVisible();
    await expect(member.page.getByTestId('admin-insights-dashboard')).toHaveCount(
      0
    );

    // A signed-in member session must be rejected by the API boundary even
    // when the UI is bypassed.
    const res = await member.api.get('/api/admin/insights?days=7');
    expect(res.status()).toBe(403);
  });
});
