import fs from 'node:fs/promises';
import { expect, test } from './fixtures';

function utcDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

test.describe('Admin reports & enhanced audit search (TOM-68)', () => {
  test('監査ログを期間・操作者・対象で絞り込み、CSV 出力リンクへ反映する', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');

    // Creating a report job also appends `admin.report.requested`, giving the
    // audit filter a deterministic actor + target pair.
    const createRes = await admin.api.post('/api/admin/reports/jobs', {
      data: { reportType: 'users_and_guests' },
    });
    expect(createRes.status()).toBe(202);
    const created = (await createRes.json()) as { jobId: string };
    expect(created.jobId).toBeTruthy();

    const page = admin.page;
    await page.goto('/admin/reports');
    await expect(
      page.getByRole('heading', { name: 'レポートと監査', exact: true })
    ).toBeVisible();

    // The reports page is now split into horizontal tabs. The audit log tab
    // is the default, and the async report/schedule section must not be
    // stacked underneath it on the same page.
    await expect(page.getByTestId('admin-tab-audit-logs')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByTestId('admin-tabpanel-audit-logs')).toBeVisible();
    await expect(page.getByTestId('admin-tab-jobs')).toHaveAttribute(
      'aria-selected',
      'false'
    );
    await expect(page.getByTestId('admin-reports-section')).toHaveCount(0);

    const from = utcDay(-3);
    const to = utcDay(0);
    await page.getByLabel('監査ログの開始日で絞り込む').fill(from);
    await page.getByLabel('監査ログの終了日で絞り込む').fill(to);
    await page
      .getByLabel('監査ログの操作者メールで絞り込む')
      .fill('dev-admin@example.com');

    const filteredRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/audit-logs' &&
        url.searchParams.get('from') === from &&
        url.searchParams.get('to') === to &&
        url.searchParams.get('actorEmail') === 'dev-admin@example.com' &&
        url.searchParams.get('targetId') === created.jobId
      );
    });
    await page.getByLabel('監査ログの対象 ID で絞り込む').fill(created.jobId);
    await filteredRequest;

    const auditSection = page.locator('#admin-audit-logs');
    await expect(
      auditSection.getByText('admin.report.requested', { exact: true })
    ).toBeVisible();

    const csvLink = page.getByRole('link', { name: 'CSV 出力' });
    const href = await csvLink.getAttribute('href');
    expect(href).toBeTruthy();
    const csvUrl = new URL(href!, 'http://localhost');
    expect(csvUrl.pathname).toBe('/api/audit-logs');
    expect(csvUrl.searchParams.get('format')).toBe('csv');
    expect(csvUrl.searchParams.get('limit')).toBe('200');
    expect(csvUrl.searchParams.get('from')).toBe(from);
    expect(csvUrl.searchParams.get('to')).toBe(to);
    expect(csvUrl.searchParams.get('actorEmail')).toBe(
      'dev-admin@example.com'
    );
    expect(csvUrl.searchParams.get('targetId')).toBe(created.jobId);

    await page.getByTestId('audit-clear-filters').click();
    await expect(page.getByLabel('監査ログの開始日で絞り込む')).toHaveValue('');
    await expect(page.getByLabel('監査ログの終了日で絞り込む')).toHaveValue('');
    await expect(
      page.getByLabel('監査ログの操作者メールで絞り込む')
    ).toHaveValue('');
    await expect(
      page.getByLabel('監査ログの対象 ID で絞り込む')
    ).toHaveValue('');
    await expect(page.getByTestId('audit-clear-filters')).toBeVisible();
  });

  test('非同期レポートを作成・完了・CSV ダウンロードし、定期実行を管理する', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const page = admin.page;

    await page.goto('/admin/reports');
    await expect(
      page.getByRole('heading', { name: 'レポートと監査', exact: true })
    ).toBeVisible();
    await expect(page.getByTestId('admin-tab-audit-logs')).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Report jobs and recurring schedules live in the `jobs` tab.
    await page.getByTestId('admin-tab-jobs').click();
    await expect(page.getByTestId('admin-tab-jobs')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByTestId('admin-tabpanel-jobs')).toBeVisible();
    await expect(page.getByTestId('admin-reports-section')).toBeVisible();

    const createResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/admin/reports/jobs' &&
        response.request().method() === 'POST'
      );
    });
    await page.getByTestId('admin-report-submit').click();
    const createdResponse = await createResponse;
    expect(createdResponse.status()).toBe(202);
    const created = (await createdResponse.json()) as {
      jobId: string;
      job: { status: string };
    };
    expect(created.job.status).toBe('queued');

    const jobRow = page.locator(`[data-job-id="${created.jobId}"]`);
    await expect(jobRow).toBeVisible();
    await expect(jobRow.getByTestId('admin-report-job-status')).toHaveText(
      '完了',
      { timeout: 90_000 }
    );
    await expect(jobRow.getByTestId('admin-report-job-status')).toHaveAttribute(
      'data-status',
      'completed'
    );

    const downloadPromise = page.waitForEvent('download');
    await jobRow.getByTestId('admin-report-job-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('.csv');
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const csv = await fs.readFile(downloadPath!, 'utf8');
    expect(csv.split('\n')[0]).toBe(
      'id,created_at,action,status,actor_id,actor_email,actor_ip,target_type,target_id,classification_snapshot,metadata_json'
    );

    // Recurring schedule creation.
    const scheduleName = `E2E weekly users ${Date.now()}`;
    const scheduleResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/admin/reports/schedules' &&
        response.request().method() === 'POST'
      );
    });
    await page.getByTestId('admin-report-schedule-name').fill(scheduleName);
    await page
      .getByTestId('admin-report-schedule-type')
      .selectOption('users_and_guests');
    await page
      .getByTestId('admin-report-schedule-cadence')
      .selectOption('weekly');
    await page.getByTestId('admin-report-schedule-retention').fill('14');
    await page.getByTestId('admin-report-schedule-submit').click();
    const createdScheduleResponse = await scheduleResponse;
    expect(createdScheduleResponse.status()).toBe(201);
    const schedule = (await createdScheduleResponse.json()) as {
      schedule: { id: string; enabled: boolean };
    };
    expect(schedule.schedule.enabled).toBe(true);

    const scheduleRow = page.locator(
      `[data-schedule-id="${schedule.schedule.id}"]`
    );
    await expect(scheduleRow).toBeVisible();
    await expect(scheduleRow).toContainText(scheduleName);

    // Enable/disable toggle.
    const toggleResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname ===
          `/api/admin/reports/schedules/${schedule.schedule.id}` &&
        response.request().method() === 'PATCH'
      );
    });
    const toggle = scheduleRow.getByTestId('admin-report-schedule-toggle');
    await toggle.click();
    expect((await toggleResponse).status()).toBe(200);
    await expect(toggle).not.toBeChecked();

    // Immediate test run creates a scheduled (automatic) job.
    const runResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname ===
          `/api/admin/reports/schedules/${schedule.schedule.id}/run` &&
        response.request().method() === 'POST'
      );
    });
    await scheduleRow.getByRole('button', { name: '即時実行' }).click();
    const run = (await (await runResponse).json()) as { jobId: string };
    expect(run.jobId).toBeTruthy();
    const runJobRow = page.locator(`[data-job-id="${run.jobId}"]`);
    await expect(runJobRow).toBeVisible();
    await expect(runJobRow).toContainText('自動 (定期)');
    await expect(runJobRow.getByTestId('admin-report-job-status')).toHaveText(
      '完了',
      { timeout: 90_000 }
    );

    // Delete schedule.
    const deleteResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname ===
          `/api/admin/reports/schedules/${schedule.schedule.id}` &&
        response.request().method() === 'DELETE'
      );
    });
    await scheduleRow.getByRole('button', { name: /削除/ }).click();
    expect((await deleteResponse).status()).toBe(200);
    await expect(scheduleRow).toHaveCount(0);
  });

  test('member はレポート画面と API の両方で拒否される', async ({ as }) => {
    test.setTimeout(120_000);
    const member = await as('member');

    await member.page.goto('/admin/reports');
    await expect(
      member.page.getByText('アクセス権限がありません (403)')
    ).toBeVisible();
    await expect(
      member.page.getByTestId('admin-reports-section')
    ).toHaveCount(0);

    const apiRes = await member.api.get('/api/admin/reports/jobs');
    expect(apiRes.status()).toBe(403);
    const createRes = await member.api.post('/api/admin/reports/jobs', {
      data: { reportType: 'users_and_guests' },
    });
    expect(createRes.status()).toBe(403);
  });
});
