import { expect, test } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  bulkImportAdminMembersApi,
  createAdminMemberApi,
} from './helpers/api';
import {
  installRealtimeProbe,
  uniqueName,
  waitForRealtimeConnected,
} from './helpers/browser';

async function openMemberSession(
  browser: Browser,
  baseURL: string,
  userId: string
): Promise<{
  context: BrowserContext;
  page: Page;
  reLogin: () => Promise<void>;
}> {
  const request = await browser.newContext({ baseURL }).then((context) => context);
  // Use the browser context's request API so the dev-login cookie set is then
  // copied into the same context via storageState below.
  const api = await request.request.post('/auth/dev-login', {
    data: { userId },
    headers: { Origin: baseURL },
  });
  expect(api.status()).toBe(200);
  const storageState = await request.request.storageState();
  await request.close();

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

  return {
    context,
    page,
    reLogin: async () => {
      const res = await context.request.post('/auth/dev-login', {
        data: { userId },
        headers: { Origin: baseURL },
      });
      expect(res.status()).toBe(200);
    },
  };
}

async function searchMember(page: Page, email: string): Promise<void> {
  await page.getByTestId('member-filter-query').fill(email);
  await page.getByTestId('member-filter-apply').click();
}

test.describe('社内メンバー管理 (P11-2 / TOM-64)', () => {
  test('sys_admin が検索・追加・ロール/クォータ変更・停止/再開・CSV 一括登録・エクスポート・監査連携を検証する', async ({
    as,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const email = `e2e-member-${suffix}@example.com`;
    const bulkEmail = `e2e-bulk-${suffix}@example.com`;

    await admin.page.goto('/admin/users');
    const members = admin.page.getByTestId('admin-members-section');
    await expect(members).toBeVisible();
    // `/admin/users` defaults to the members tab and mounts only that panel:
    // other sections are not stacked below it anymore.
    await expect(admin.page.getByTestId('admin-tab-members')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(admin.page.getByTestId('admin-tabpanel-members')).toBeVisible();
    await expect(admin.page.getByTestId('admin-guests-section')).toHaveCount(0);
    await expect(members.getByTestId('member-rbac-notice')).toContainText(
      'すべて実行できます'
    );

    // The guest console lives behind its own tab and preserves its selectors.
    await admin.page.getByTestId('admin-tab-guests').click();
    await expect(admin.page.getByTestId('admin-tabpanel-guests')).toBeVisible();
    await expect(admin.page.getByTestId('admin-guests-section')).toBeVisible();
    await expect(members).toHaveCount(0);
    await admin.page.getByTestId('admin-tab-members').click();
    await expect(members).toBeVisible();

    // Registration modal.
    await members.getByTestId('member-open-create').click();
    const create = admin.page.getByTestId('member-create-modal');
    await expect(create).toBeVisible();
    await create.getByTestId('member-create-email').fill(email);
    await create.getByTestId('member-create-display-name').fill('E2E メンバー');
    await create.getByTestId('member-create-department').fill('E2E 部署');
    await create.getByTestId('member-create-role').selectOption('member');
    await create.getByTestId('member-create-quota').fill('1048576');
    await create.getByTestId('member-create-submit').click();
    await expect(create.getByTestId('member-create-result')).toContainText(
      '登録しました'
    );
    await create.getByTestId('member-create-close').click();

    // Search + usage render.
    await searchMember(admin.page, email);
    const row = admin.page
      .locator('[data-testid="admin-member-row"]')
      .filter({ hasText: email });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('member-usage')).toContainText('/ 1.00 MiB');
    await expect(row).toContainText('E2E 部署');
    await expect(row).toContainText('メンバー');

    // Detail drawer: role + personal quota update.
    await row.getByTestId('member-action-edit').click();
    const edit = admin.page.getByTestId('member-edit-modal');
    await expect(edit).toBeVisible();
    await expect(edit.getByTestId('member-edit-display-name')).toHaveValue(
      'E2E メンバー'
    );
    await expect(edit.getByTestId('member-detail-sessions')).toContainText('件');
    await expect(edit.getByTestId('member-detail-root-folders')).toBeVisible();
    await expect(edit.getByTestId('member-detail-groups')).toBeVisible();
    await edit.getByTestId('member-edit-role').selectOption('sec_admin');
    await edit.getByTestId('member-edit-quota').fill('2097152');
    await edit.getByTestId('member-edit-submit').click();
    await expect(edit.getByTestId('member-edit-result')).toContainText(
      '更新しました'
    );
    await expect(edit.getByTestId('member-detail-usage')).toContainText(
      '/ 2.00 MiB'
    );
    await edit.getByTestId('member-edit-close').click();
    await expect(row).toContainText('セキュリティ管理者');

    // Suspend -> session revocation copy -> resume.
    await row.getByTestId('member-action-suspend').click();
    const confirm = admin.page.getByTestId('member-confirm-modal');
    await expect(confirm.getByTestId('member-confirm-title')).toContainText(
      '停止しますか'
    );
    await expect(confirm).toContainText('すべての有効セッションを即時失効');
    await confirm.getByTestId('member-confirm-execute').click();
    await expect(confirm.getByTestId('member-confirm-result')).toContainText(
      '停止'
    );
    await confirm.getByTestId('member-confirm-cancel').click();
    await expect(row).toContainText('停止中');

    await expect(row.getByTestId('member-action-resume')).toBeEnabled();
    await row.getByTestId('member-action-resume').click();
    const resumeConfirm = admin.page.getByTestId('member-confirm-modal');
    await expect(
      resumeConfirm.getByTestId('member-confirm-title')
    ).toContainText('再開しますか');
    await resumeConfirm.getByTestId('member-confirm-execute').click();
    await expect(
      resumeConfirm.getByTestId('member-confirm-result')
    ).toContainText('再開');
    await resumeConfirm.getByTestId('member-confirm-cancel').click();
    await expect(row).toContainText('有効');

    // Server-side CSV export reflects the current filter.
    const csvHref = await members
      .getByTestId('member-export-csv')
      .getAttribute('href');
    expect(csvHref).toContain('/api/admin/users?');
    expect(csvHref).toContain('format=csv');
    const csvResponse = await admin.api.get(csvHref!);
    expect(csvResponse.status()).toBe(200);
    expect(csvResponse.headers()['content-type']).toContain('text/csv');
    const csvText = await csvResponse.text();
    expect(csvText).toContain(email);
    expect(csvText.split('\n')[0]).toContain('storage_quota_bytes');

    // CSV bulk import: dryRun preview then idempotent execution.
    await members.getByTestId('member-open-bulk-import').click();
    const bulk = admin.page.getByTestId('member-bulk-modal');
    await expect(bulk).toBeVisible();
    await expect(bulk.getByTestId('member-bulk-idempotency-key')).toContainText(
      'Idempotency-Key:'
    );
    await bulk
      .getByTestId('member-bulk-csv')
      .fill(
        [
          'email,displayName,department,role,storageQuotaBytes',
          `${bulkEmail},一括 メンバー,E2E 部署,member,1048576`,
          `${email},E2E メンバー更新,E2E 部署,member,2097152`,
        ].join('\n')
      );
    await bulk.getByTestId('member-bulk-dry-run').click();
    await expect(bulk.getByTestId('member-bulk-summary')).toContainText(
      '作成 1 件'
    );
    await expect(bulk.getByTestId('member-bulk-summary')).toContainText(
      '更新 1 件'
    );
    await expect(bulk.getByTestId('member-bulk-result')).toContainText(
      'プレビューのためデータは変更されていません'
    );
    await bulk.getByTestId('member-bulk-execute').click();
    await expect(bulk.getByTestId('member-bulk-result')).toContainText(
      '実行結果'
    );
    await expect(bulk.getByTestId('member-bulk-row').first()).toBeVisible();
    await bulk.getByTestId('member-bulk-close').click();

    // Reset filters and confirm the bulk-created member.
    await admin.page.getByTestId('member-filter-reset').click();
    await searchMember(admin.page, bulkEmail);
    await expect(
      admin.page
        .locator('[data-testid="admin-member-row"]')
        .filter({ hasText: bulkEmail })
    ).toBeVisible();

    // Audit-log preset deep link.
    await members.getByTestId('member-show-audit-logs').click();
    await expect(admin.page).toHaveURL(/\/admin\/reports\?auditPreset=user$/);
    await expect(admin.page.getByText('メンバー監査のみ')).toBeVisible();
    await expect(
      admin.page.getByText('社内メンバー登録').first()
    ).toBeVisible();
  });

  test('停止時に接続中のメンバーがリアルタイムで追い出され、再開後に再ログインできる', async ({
    as,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const email = `e2e-realtime-${suffix}@example.com`;
    const member = await createAdminMemberApi(admin, {
      email,
      displayName: 'Realtime Member',
      department: 'Realtime',
    });

    const session = await openMemberSession(browser, baseURL!, member.id);
    try {
      await session.page.goto('/workspace');
      await waitForRealtimeConnected(session.page);
      const meBefore = await session.context.request.get('/api/auth/me');
      expect(meBefore.status()).toBe(200);

      await admin.page.goto('/admin/users');
      await searchMember(admin.page, email);
      const row = admin.page
        .locator('[data-testid="admin-member-row"]')
        .filter({ hasText: email });
      await expect(row).toBeVisible();
      await row.getByTestId('member-action-suspend').click();
      const confirm = admin.page.getByTestId('member-confirm-modal');
      await confirm.getByTestId('member-confirm-execute').click();
      await expect(confirm.getByTestId('member-confirm-result')).toContainText(
        '停止'
      );
      await confirm.getByTestId('member-confirm-cancel').click();

      // The target browser receives `user.suspended` over its live WebSocket
      // and drops straight to the sign-in surface (no navigation/reload) as the
      // sync store purges its authenticated scope.
      await expect(
        session.page.getByRole('heading', {
          name: 'Files ワークスペースへサインイン',
        })
      ).toBeVisible({ timeout: 20_000 });

      await expect
        .poll(async () => {
          const res = await session.context.request.get('/api/auth/me');
          return res.status();
        })
        .toBe(401);

      await expect
        .poll(async () =>
          session.page.evaluate(() => {
            const probe = (
              window as Window & {
                __e2eRealtimeProbe?: Array<{ url: string; state: number }>;
              }
            ).__e2eRealtimeProbe;
            return Boolean(
              probe
                ?.filter((entry) => entry.url.includes('/api/sync/ws'))
                .some((entry) => entry.state === 3)
            );
          })
        )
        .toBe(true);

      // Resume from the admin UI, then prove the member can sign in again.
      await row.getByTestId('member-action-resume').click();
      const resumeConfirm = admin.page.getByTestId('member-confirm-modal');
      await resumeConfirm.getByTestId('member-confirm-execute').click();
      await expect(
        resumeConfirm.getByTestId('member-confirm-result')
      ).toContainText('再開');
      await resumeConfirm.getByTestId('member-confirm-cancel').click();

      await session.reLogin();
      const meAfter = await session.context.request.get('/api/auth/me');
      expect(meAfter.status()).toBe(200);
    } finally {
      await session.context.close();
    }
  });

  test('sec_admin は一般メンバーの停止/再開のみ実行でき、ロール/クォータ更新と一括登録は 403 になる', async ({
    as,
  }) => {
    test.setTimeout(180_000);
    const admin = await as('sys_admin');
    const sec = await as('sec_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const email = `e2e-sec-${suffix}@example.com`;
    const elevatedEmail = `e2e-sec-elevated-${suffix}@example.com`;
    const member = await createAdminMemberApi(admin, {
      email,
      displayName: 'Sec Managed Member',
      department: 'Security Test',
    });
    const elevated = await createAdminMemberApi(admin, {
      email: elevatedEmail,
      displayName: 'Another Sec Admin',
      role: 'sec_admin',
    });

    await sec.page.goto('/admin/users');
    const members = sec.page.getByTestId('admin-members-section');
    await expect(members).toBeVisible();
    await expect(sec.page.getByTestId('admin-tab-members')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(sec.page.getByTestId('admin-guests-section')).toHaveCount(0);
    await expect(members.getByTestId('member-rbac-notice')).toContainText(
      '一般メンバーの停止・再開'
    );
    await expect(members.getByTestId('member-open-create')).toBeDisabled();
    await expect(members.getByTestId('member-open-bulk-import')).toBeDisabled();

    await searchMember(sec.page, email);
    const row = sec.page
      .locator('[data-testid="admin-member-row"]')
      .filter({ hasText: email });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('member-action-edit')).toBeDisabled();

    await row.getByTestId('member-action-suspend').click();
    const confirm = sec.page.getByTestId('member-confirm-modal');
    await confirm.getByTestId('member-confirm-execute').click();
    await expect(confirm.getByTestId('member-confirm-result')).toContainText(
      '停止'
    );
    await confirm.getByTestId('member-confirm-cancel').click();
    await expect(row).toContainText('停止中');

    await row.getByTestId('member-action-resume').click();
    const resumeConfirm = sec.page.getByTestId('member-confirm-modal');
    await resumeConfirm.getByTestId('member-confirm-execute').click();
    await expect(
      resumeConfirm.getByTestId('member-confirm-result')
    ).toContainText('再開');
    await resumeConfirm.getByTestId('member-confirm-cancel').click();
    await expect(row).toContainText('有効');

    // Elevated targets are hidden from sec_admin's suspend control.
    await searchMember(sec.page, 'dev-admin@example.com');
    const sysRow = sec.page
      .locator('[data-testid="admin-member-row"]')
      .filter({ hasText: 'dev-admin@example.com' });
    await expect(sysRow).toBeVisible();
    await expect(sysRow.getByTestId('member-action-suspend')).toBeDisabled();

    // Direct API escalation is rejected with the documented codes.
    const patchRes = await sec.api.patch(
      `/api/admin/users/${member.id}`,
      { data: { role: 'sec_admin' } }
    );
    expect(patchRes.status()).toBe(403);
    expect((await patchRes.json()).code).toBe('SYS_ADMIN_REQUIRED');

    const createRes = await sec.api.post('/api/admin/users', {
      data: {
        email: `e2e-sec-forbidden-${suffix}@example.com`,
        displayName: 'Forbidden',
      },
    });
    expect(createRes.status()).toBe(403);
    expect((await createRes.json()).code).toBe('SYS_ADMIN_REQUIRED');

    const bulkRes = await sec.api.post('/api/admin/users/bulk-import', {
      data: {
        csv: 'email,displayName\nforbidden@example.com,Forbidden',
        dryRun: true,
      },
    });
    expect(bulkRes.status()).toBe(403);
    expect((await bulkRes.json()).code).toBe('SYS_ADMIN_REQUIRED');

    const elevatedSuspend = await sec.api.post(
      `/api/admin/users/${elevated.id}/suspend`,
      { data: {} }
    );
    expect(elevatedSuspend.status()).toBe(403);
    expect((await elevatedSuspend.json()).code).toBe('SYS_ADMIN_REQUIRED');

    // Self-modifying privilege is rejected even for sys_admin.
    const selfDemote = await admin.api.patch(
      `/api/admin/users/${admin.user.id}`,
      { data: { role: 'member' } }
    );
    expect(selfDemote.status()).toBe(409);
    expect((await selfDemote.json()).code).toBe(
      'CANNOT_SELF_MODIFY_PRIVILEGE'
    );

    const selfSuspend = await admin.api.post(
      `/api/admin/users/${admin.user.id}/suspend`,
      { data: {} }
    );
    expect(selfSuspend.status()).toBe(409);
    expect((await selfSuspend.json()).code).toBe(
      'CANNOT_SELF_MODIFY_PRIVILEGE'
    );

    // Idempotent bulk replay is visible through the API contract.
    const csv = [
      'email,displayName,department,role',
      `${uniqueName('e2e-bulk-replay')}@example.com,Replay,QA,member`,
    ].join('\n');
    const key = `e2e-member-bulk-${suffix}-${crypto.randomUUID()}`;
    const first = await bulkImportAdminMembersApi(admin, {
      csv,
      idempotencyKey: key,
    });
    expect(first.replayed).toBe(false);
    const replay = await bulkImportAdminMembersApi(admin, {
      csv,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.createdCount).toBe(1);
  });
});
