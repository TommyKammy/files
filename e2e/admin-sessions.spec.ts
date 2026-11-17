import { expect, test } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { DEV_USERS } from './fixtures';
import {
  installRealtimeProbe,
  waitForRealtimeConnected,
} from './helpers/browser';

interface MemberSession {
  context: BrowserContext;
  page: Page;
  sessionId: string;
}

async function openMemberSession(
  browser: Browser,
  baseURL: string,
  userId: string
): Promise<MemberSession> {
  const bootstrap = await browser.newContext({ baseURL });
  try {
    const login = await bootstrap.request.post('/auth/dev-login', {
      data: { userId },
      headers: { Origin: baseURL },
    });
    expect(login.status()).toBe(200);
    const storageState = await bootstrap.request.storageState();

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

    const me = await context.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const body = (await me.json()) as { user: { sessionId?: string | null } };
    expect(body.user.sessionId, 'dev-login must expose the D1 session id').toBeTruthy();

    return { context, page, sessionId: body.user.sessionId! };
  } finally {
    await bootstrap.close();
  }
}

async function openWorkspaceWithRealtime(member: MemberSession): Promise<void> {
  await member.page.goto('/workspace');
  await expect(
    member.page
      .getByRole('main')
      .getByRole('button', { name: '全社共有', exact: true })
  ).toBeVisible();
  await waitForRealtimeConnected(member.page);
}

async function searchMember(page: Page, email: string): Promise<void> {
  await page.getByTestId('member-filter-query').fill(email);
  await page.getByTestId('member-filter-apply').click();
}

test.describe('アクティブセッション監視 & 強制サインアウト (P12-2 / TOM-71)', () => {
  test('sys_admin がメンバー詳細ドロワーから対象端末だけを強制失効し、自分のセッションを維持する', async ({
    as,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    if (!baseURL) throw new Error('baseURL is required');
    const admin = await as('sys_admin');
    const member = await openMemberSession(
      browser,
      baseURL,
      DEV_USERS.member.id
    );

    try {
      await openWorkspaceWithRealtime(member);

      await admin.page.goto('/admin/users');
      const members = admin.page.getByTestId('admin-members-section');
      await expect(members).toBeVisible();
      await searchMember(admin.page, DEV_USERS.member.email);
      const row = admin.page
        .locator('[data-testid="admin-member-row"]')
        .filter({ hasText: DEV_USERS.member.email });
      await expect(row).toBeVisible();
      await row.getByTestId('member-action-edit').click();

      const detail = admin.page.getByTestId('member-edit-modal');
      await expect(detail).toBeVisible();
      const panel = detail.getByTestId('member-sessions-panel');
      await expect(panel).toBeVisible();
      await expect(detail.getByTestId('member-detail-sessions')).toContainText(
        '件'
      );

      const targetRow = panel.locator(
        `[data-testid="member-session-row"][data-session-id="${member.sessionId}"]`
      );
      await expect(targetRow).toBeVisible();
      await targetRow.getByTestId('member-session-revoke').click();
      const confirm = panel.getByTestId('member-session-confirm');
      await expect(confirm).toBeVisible();
      await confirm
        .getByTestId('member-session-reason')
        .fill('E2E: 端末紛失のため強制サインアウト');
      await confirm.getByTestId('member-session-confirm-execute').click();

      await expect(panel.getByTestId('member-sessions-notice')).toContainText(
        '強制失効'
      );

      // The target browser must swap to the re-authentication card without a
      // reload: the TenantSyncHub frame plus the 4001 close drive the purge.
      await expect(
        member.page.getByText('セッションが管理者によって失効されました')
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        member.page.getByTestId('member-sessions-panel')
      ).toHaveCount(0);

      const revokedMe = await member.context.request.get('/api/auth/me');
      expect(revokedMe.status()).toBe(401);

      // The acting admin's own session and console must remain usable.
      const adminMe = await admin.api.get('/api/auth/me');
      expect(adminMe.status()).toBe(200);
      const adminMeBody = (await adminMe.json()) as {
        user: { sessionId?: string | null };
      };
      expect(adminMeBody.user.sessionId).toBeTruthy();
      await expect(members).toBeVisible();
      await expect(
        admin.page.getByText('セッションが管理者によって失効されました')
      ).toHaveCount(0);
    } finally {
      await member.context.close();
    }
  });

  test('sys_admin が /admin/settings から現在セッション維持のまま緊急一括失効する', async ({
    as,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    if (!baseURL) throw new Error('baseURL is required');
    const admin = await as('sys_admin');
    const member = await openMemberSession(
      browser,
      baseURL,
      DEV_USERS.member.id
    );

    try {
      await openWorkspaceWithRealtime(member);

      await admin.page.goto('/admin/settings');
      const section = admin.page.getByTestId('admin-sessions-section');
      await expect(section).toBeVisible();

      await section.getByTestId('admin-sessions-revoke-all-open').click();
      const confirm = section.getByTestId(
        'admin-sessions-revoke-all-confirm'
      );
      await expect(confirm).toBeVisible();
      await expect(
        confirm.getByTestId('admin-sessions-revoke-all-keep-current')
      ).toBeChecked();
      await confirm
        .getByTestId('admin-sessions-revoke-all-confirm-reason')
        .fill('E2E: テナント全体インシデント初動');
      await confirm.getByTestId('admin-sessions-revoke-all-execute').click();

      await expect(
        section.getByTestId('admin-sessions-revoke-all-result')
      ).toContainText('維持されています');
      await expect(
        section.getByTestId('admin-sessions-revoke-all-result')
      ).toContainText('緊急失効しました');

      await expect(
        member.page.getByText('セッションが管理者によって失効されました')
      ).toBeVisible({ timeout: 20_000 });
      const revokedMe = await member.context.request.get('/api/auth/me');
      expect(revokedMe.status()).toBe(401);

      const adminMe = await admin.api.get('/api/auth/me');
      expect(adminMe.status()).toBe(200);
      await expect(section).toBeVisible();
      await expect(
        admin.page.getByText('セッションが管理者によって失効されました')
      ).toHaveCount(0);
    } finally {
      await member.context.close();
    }
  });
});
