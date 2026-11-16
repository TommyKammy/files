import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { RoleSession } from './fixtures';
import {
  createFolder,
  createGuestInvitation,
  revokeGuestInvitation,
  updateGuestPolicy,
  uploadFile,
  waitForDevGuestMail,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

const GUEST_DOMAIN = 'partner.example';

async function enableGuestPolicy(admin: RoleSession): Promise<void> {
  await updateGuestPolicy(admin, {
    allowExternalCollaborators: true,
    allowGuestElevatedRoles: false,
    externalDomainAllowlist: [GUEST_DOMAIN],
    guestInvitationExpiryDays: 14,
    guestSessionMaxHours: 24,
  });
  const advanced = await admin.api.patch('/api/admin/policies', {
    data: { advancedRolesEnabled: true },
  });
  expect(advanced.status()).toBe(200);
}

async function resetGuestPolicy(admin: RoleSession): Promise<void> {
  await updateGuestPolicy(admin, {
    allowExternalCollaborators: false,
    allowGuestElevatedRoles: false,
    externalDomainAllowlist: [],
    guestInvitationExpiryDays: 14,
    guestSessionMaxHours: 24,
  });
}

async function acceptAndLoginGuest(
  admin: RoleSession,
  browser: Browser,
  baseURL: string,
  email: string
): Promise<{ context: BrowserContext; page: Page }> {
  const invitationMail = await waitForDevGuestMail(admin, {
    to: email,
    kind: 'guest_invitation',
  });
  expect(invitationMail.acceptUrl).toContain('/guest/accept?token=');

  const context = await browser.newContext({
    baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    await page.goto(invitationMail.acceptUrl!);
    await expect(
      page.getByRole('heading', { name: '外部ゲスト招待の承諾' })
    ).toBeVisible();
    const accept = page.getByTestId('guest-accept-submit');
    await expect(accept).toBeEnabled();
    await accept.click();
    await expect(page.getByTestId('guest-accept-notice')).toContainText(
      '6 桁の認証コードを送信しました'
    );

    const otpMail = await waitForDevGuestMail(admin, {
      to: email,
      kind: 'guest_otp',
    });
    expect(otpMail.otpCode).toMatch(/^\d{6}$/);
    await page.getByTestId('guest-otp-input').fill(otpMail.otpCode!);
    await page.getByTestId('guest-otp-submit').click();
    await page.waitForURL(/\/workspace(?:\?|$)/, { timeout: 30_000 });
    return { context, page };
  } catch (err) {
    await context.close();
    throw err;
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    metrics.scrollWidth,
    `page must not overflow horizontally: scrollWidth=${metrics.scrollWidth}, innerWidth=${metrics.innerWidth}`
  ).toBeLessThanOrEqual(metrics.innerWidth);
}

test.describe('外部ゲスト権限制御・コラボレーション UI (P10-2 / TOM-60)', () => {
  test('招待 UI・ゲストワークスペース・詳細カード・監査・取消・モバイルを一気通貫で検証する', async ({
    as,
    browser,
    baseURL,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const guestEmail = `e2e-collab-uploader-${suffix}@${GUEST_DOMAIN}`;
    const previewerEmail = `e2e-collab-previewer-${suffix}@${GUEST_DOMAIN}`;
    let guestContext: BrowserContext | null = null;
    let previewerContext: BrowserContext | null = null;
    let previewerInvitationId: string | null = null;

    try {
      await enableGuestPolicy(admin);

      const root = await createFolder(admin, {
        parentId: null,
        name: uniqueName('e2e-collab-root'),
        classification: 'internal',
      });
      cleanup.registerFolder(root.id);
      const sharedFolder = await createFolder(admin, {
        parentId: root.id,
        name: uniqueName('e2e-collab-shared'),
        classification: 'internal',
      });
      const sharedFileName = `${uniqueName('collab-visible')}.txt`;
      await uploadFile(admin, {
        folderId: sharedFolder.id,
        name: sharedFileName,
        content: 'external guest collaboration content',
      });

      await admin.page.goto(
        `/workspace?folderId=${encodeURIComponent(sharedFolder.id)}`
      );
      const openPermissions = admin.page.getByTestId(
        'workspace-permissions-button'
      );
      await expect(openPermissions).toBeVisible();
      await openPermissions.click();

      const dialog = admin.page.getByRole('dialog', {
        name: `アクセス権限: ${sharedFolder.name}`,
      });
      await expect(dialog).toBeVisible();
      const guestSection = dialog.getByTestId('guest-collaboration-section');
      await expect(guestSection).toBeVisible();
      await expect(
        guestSection.getByTestId('guest-collaboration-enabled-badge')
      ).toBeVisible();

      // Guest role guardrails: owner/co_owner always hidden; editor hidden
      // while allowGuestElevatedRoles=false; folder-only advanced roles remain.
      const guestRoleSelect = guestSection.getByTestId('guest-invite-role');
      const guestRoleValues = await guestRoleSelect
        .locator('option')
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value)
        );
      expect(guestRoleValues).not.toContain('owner');
      expect(guestRoleValues).not.toContain('co_owner');
      expect(guestRoleValues).not.toContain('editor');
      expect(guestRoleValues).toEqual(
        expect.arrayContaining([
          'viewer',
          'previewer',
          'uploader',
          'viewer_uploader',
          'previewer_uploader',
        ])
      );

      await guestSection
        .getByTestId('guest-invite-email')
        .fill(guestEmail);
      await guestSection
        .getByTestId('guest-invite-display-name')
        .fill('E2E Collab Uploader');
      await guestSection
        .getByTestId('guest-invite-org')
        .fill('Partner E2E');
      await guestSection.getByTestId('guest-invite-role').selectOption(
        'viewer_uploader'
      );

      await guestSection.getByTestId('guest-mail-preview-toggle').click();
      const mailPreview = guestSection.getByTestId('guest-mail-preview-panel');
      await expect(mailPreview).toBeVisible();
      await expect(mailPreview).toContainText(sharedFolder.name);
      await expect(mailPreview).toContainText('E2E Collab Uploader');
      await expect(mailPreview).not.toContainText('token=');

      await guestSection.getByTestId('guest-invite-submit').click();
      await expect(
        guestSection.getByTestId('guest-collaboration-notice')
      ).toContainText('招待メールを送信しました');

      const invitationRow = guestSection
        .getByTestId('guest-invitation-row')
        .filter({ hasText: guestEmail });
      await expect(invitationRow).toBeVisible();
      await expect(invitationRow).toContainText('招待中');
      await expect(invitationRow).toContainText('Viewer + Uploader');

      // Resend requires an explicit confirmation and announces via role=status.
      await invitationRow.getByRole('button', { name: '再送' }).click();
      const confirm = invitationRow.getByTestId('guest-invitation-confirm');
      await expect(confirm).toContainText('新しいトークンで招待メールを再送します');
      await confirm.getByRole('button', { name: '実行' }).click();
      await expect(
        guestSection.getByTestId('guest-collaboration-notice')
      ).toContainText('再送');
      await expect(invitationRow).toContainText('再送回数: 1 回');

      const guest = await acceptAndLoginGuest(
        admin,
        browser,
        baseURL!,
        guestEmail
      );
      guestContext = guest.context;

      // Guest /workspace defaults to the shared-items view with guest guidance.
      await guest.page.goto('/workspace');
      await expect(
        guest.page.getByRole('heading', { name: '共有アイテム' })
      ).toBeVisible();
      await expect(
        guest.page.getByTestId('guest-shared-guidance')
      ).toContainText('Partner E2E');
      await expect(
        guest.page.getByRole('link', { name: 'ガバナンス' })
      ).toHaveCount(0);
      await expect(
        guest.page.getByRole('link', { name: 'マイファイル' })
      ).toHaveCount(0);
      await expect(
        guest.page.getByRole('button', { name: '新規フォルダ' })
      ).toHaveCount(0);

      const sharedRow = guest.page
        .getByTestId('shared-item-row')
        .filter({ hasText: sharedFolder.name });
      await expect(sharedRow).toBeVisible();
      await sharedRow.getByRole('button').first().click();
      await guest.page.waitForURL(
        new RegExp(`folderId=${encodeURIComponent(sharedFolder.id)}`),
        { timeout: 15_000 }
      );

      const guestBanner = guest.page.getByTestId('workspace-permission-banner');
      await expect(guestBanner).toBeVisible();
      await expect(guestBanner).toHaveAttribute('data-guest-banner', 'true');
      await expect(guest.page.getByTestId('guest-banner-org')).toContainText(
        'Partner E2E'
      );
      await expect(guest.page.getByTestId('guest-banner-expiry')).toContainText(
        'アカウント有効期限'
      );
      await expect(guest.page.getByTestId('guest-banner-allowed')).toContainText(
        'アップロード'
      );
      await expect(guest.page.getByTestId('guest-banner-allowed')).toContainText(
        'プレビュー'
      );
      await expect(guest.page.getByTestId('guest-banner-allowed')).toContainText(
        'ダウンロード'
      );
      await expect(guest.page.getByTestId('guest-banner-denied')).toContainText(
        '権限管理'
      );
      await expect(guest.page.getByTestId('guest-banner-denied')).toContainText(
        '削除'
      );
      await expect(guest.page.getByTestId('guest-banner-denied')).toContainText(
        'ルートフォルダ作成'
      );

      const toolbar = guest.page.getByRole('toolbar', {
        name: 'ワークスペース操作',
      });
      await expect(toolbar).toBeVisible();
      await expect(
        guest.page.getByTestId('workspace-permissions-button')
      ).toHaveCount(0);
      await expect(
        guest.page.getByRole('button', { name: 'ファイルを選択' })
      ).toBeVisible();
      await expect(
        guest.page.getByTitle('ダウンロード').first()
      ).toBeVisible();

      // Guest access and login are audited for the tenant.
      const auditResponse = await admin.api.get(
        `/api/audit-logs?actions=guest.login,guest.access&actorEmail=${encodeURIComponent(
          guestEmail
        )}&limit=100`
      );
      expect(auditResponse.status()).toBe(200);
      const auditBody = (await auditResponse.json()) as {
        logs: Array<{ action: string; metadata: Record<string, unknown> | null }>;
      };
      const actions = new Set(auditBody.logs.map((log) => log.action));
      expect(actions.has('guest.login')).toBe(true);
      expect(actions.has('guest.access')).toBe(true);
      const operations = new Set(
        auditBody.logs
          .filter((log) => log.action === 'guest.access')
          .map((log) => String(log.metadata?.operation ?? ''))
      );
      expect(operations.has('list_shared_items')).toBe(true);
      expect(operations.has('list_folder')).toBe(true);
      const accessLog = auditBody.logs.find(
        (log) => log.action === 'guest.access'
      );
      expect(accessLog?.metadata?.externalOrg).toBe('Partner E2E');

      // The owner can open the guest detail card from the invitation list.
      await dialog.getByRole('button', { name: 'ゲスト詳細' }).first().click();
      const detail = dialog.getByTestId('guest-detail-card');
      await expect(detail).toBeVisible();
      await expect(detail).toContainText('実効権限と継承元');
      await expect(detail).toContainText(sharedFolder.name);
      await expect(detail.getByTestId('guest-detail-external-org')).toContainText(
        'Partner E2E'
      );
      await expect(detail.getByTestId('guest-detail-last-login')).toContainText(
        /202\d/
      );
      await expect(detail.getByTestId('guest-detail-inviter')).toContainText(
        'Dev Admin'
      );
      await expect(detail.getByTestId('guest-detail-expiry')).toContainText(
        /202\d/
      );
      await expect(
        detail.getByTestId('guest-detail-effective-permissions')
      ).toContainText('Viewer + Uploader');
      await expect(
        detail.getByTestId('guest-detail-shared-items')
      ).toContainText(sharedFolder.name);

      // Mobile permissions modal: no horizontal overflow, Tab stays inside,
      // Escape dismisses the native dialog.
      await admin.page.setViewportSize({ width: 390, height: 844 });
      await expectNoHorizontalOverflow(admin.page);
      await admin.page.keyboard.press('Tab');
      const focusInsideDialog = await admin.page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(active && active.closest('dialog'));
      });
      expect(focusInsideDialog).toBe(true);
      await admin.page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      // Mobile guest workspace: no horizontal overflow either.
      await guest.page.setViewportSize({ width: 390, height: 844 });
      await guest.page.goto(
        `/workspace?folderId=${encodeURIComponent(sharedFolder.id)}`
      );
      await expect(guest.page.getByTestId('workspace-permission-banner')).toBeVisible();
      await expectNoHorizontalOverflow(guest.page);
      await guest.page.setViewportSize({ width: 1440, height: 900 });

      // Re-open the modal at desktop size and revoke the invitation.
      await admin.page.setViewportSize({ width: 1440, height: 900 });
      await openPermissions.click();
      const revokeDialog = admin.page.getByRole('dialog', {
        name: `アクセス権限: ${sharedFolder.name}`,
      });
      await expect(revokeDialog).toBeVisible();
      const revokeRow = revokeDialog
        .getByTestId('guest-invitation-row')
        .filter({ hasText: guestEmail });
      await revokeRow.getByRole('button', { name: '取消' }).click();
      const revokeConfirm = revokeRow.getByTestId('guest-invitation-confirm');
      await expect(revokeConfirm).toContainText('有効セッションも失効');
      await revokeConfirm.getByRole('button', { name: '実行' }).click();
      await expect(
        revokeDialog.getByTestId('guest-collaboration-notice')
      ).toContainText('招待を取り消し、ゲストの有効セッションを失効させました。');
      await expect(revokeRow).toContainText('停止/取消済み');

      // Revoked guest gets a cause-specific recovery screen + /guest/login.
      await guest.page.goto(
        `/workspace?folderId=${encodeURIComponent(sharedFolder.id)}`
      );
      const sessionIssue = guest.page.getByTestId('guest-session-issue');
      await expect(sessionIssue).toBeVisible();
      await expect(sessionIssue).toHaveAttribute(
        'data-code',
        /GUEST_ACCOUNT_SUSPENDED|SESSION_EXPIRED_OR_REVOKED|GUEST_ACCOUNT_EXPIRED/
      );
      await expect(sessionIssue).toContainText(/停止|セッション|有効期限/);
      const relogin = guest.page.getByTestId('guest-relogin-link');
      await expect(relogin).toBeVisible();
      await expect(relogin).toContainText('外部ゲストサインイン');
      await expect(relogin).toHaveAttribute('href', '/guest/login');

      // A previewer guest sees preview but no upload/download controls.
      const previewerInvitation = await createGuestInvitation(admin, {
        email: previewerEmail,
        displayName: 'E2E Collab Previewer',
        externalOrg: 'Partner Preview',
        targetType: 'folder',
        targetId: sharedFolder.id,
        role: 'previewer',
      });
      previewerInvitationId = previewerInvitation.id;
      const previewer = await acceptAndLoginGuest(
        admin,
        browser,
        baseURL!,
        previewerEmail
      );
      previewerContext = previewer.context;
      await previewer.page.goto(
        `/workspace?folderId=${encodeURIComponent(sharedFolder.id)}`
      );
      const previewerBanner = previewer.page.getByTestId(
        'workspace-permission-banner'
      );
      await expect(previewerBanner).toBeVisible();
      await expect(
        previewer.page.getByTestId('guest-banner-allowed')
      ).toContainText('プレビュー');
      await expect(
        previewer.page.getByTestId('guest-banner-allowed')
      ).not.toContainText('アップロード');
      await expect(
        previewer.page.getByTestId('guest-banner-allowed')
      ).not.toContainText('ダウンロード');
      await expect(
        previewer.page.getByRole('button', { name: 'ファイルを選択' })
      ).toHaveCount(0);
      await expect(
        previewer.page.getByRole('button', { name: '新規フォルダ' })
      ).toHaveCount(0);
      await expect(previewer.page.getByTitle('ダウンロード')).toHaveCount(0);
      await expect(
        previewer.page.getByRole('link', { name: 'ガバナンス' })
      ).toHaveCount(0);
    } finally {
      if (previewerContext) await previewerContext.close();
      if (guestContext) await guestContext.close();
      if (previewerInvitationId) {
        try {
          await revokeGuestInvitation(admin, previewerInvitationId);
        } catch {
          // already revoked by the UI or cleanup
        }
      }
      // Revoke any invitation that is still active for this test run.
      try {
        const list = await admin.api.get('/api/guests/invitations?limit=100');
        if (list.ok()) {
          const body = (await list.json()) as {
            invitations: Array<{ id: string; email: string; status: string }>;
          };
          for (const invitation of body.invitations) {
            if (
              invitation.email === guestEmail ||
              invitation.email === previewerEmail
            ) {
              if (invitation.status !== 'revoked') {
                await revokeGuestInvitation(admin, invitation.id).catch(
                  () => undefined
                );
              }
            }
          }
        }
      } catch {
        // teardown must not mask the primary assertion failure
      }
      await resetGuestPolicy(admin);
    }
  });
});
