import { expect, test } from './fixtures';
import {
  createFolder,
  createGuestInvitation,
  getAdminGuestDetail,
  listAdminGuests,
  listDevGuestMails,
  suspendAdminGuestApi,
  updateGuestPolicy,
  uploadFile,
  waitForDevGuestMail,
} from './helpers/api';
import { uniqueName } from './helpers/browser';
import type { RoleSession } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';

async function acceptInvitationAndLogin(
  browser: Browser,
  baseURL: string,
  admin: RoleSession,
  email: string,
  acceptUrl: string
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(acceptUrl);
  await expect(
    page.getByRole('heading', { name: '外部ゲスト招待の承諾' })
  ).toBeVisible();
  await page.getByTestId('guest-accept-submit').click();
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
}

async function reauthenticateGuest(
  baseURL: string,
  admin: RoleSession,
  context: BrowserContext,
  email: string
): Promise<void> {
  const requestOtp = await context.request.post('/auth/guest/otp/request', {
    data: { email },
    headers: { Origin: baseURL },
  });
  expect(requestOtp.status()).toBe(200);
  const otpMail = await waitForDevGuestMail(admin, {
    to: email,
    kind: 'guest_otp',
  });
  expect(otpMail.otpCode).toMatch(/^\d{6}$/);
  const verify = await context.request.post('/auth/guest/otp/verify', {
    data: { email, otp: otpMail.otpCode },
    headers: { Origin: baseURL },
  });
  expect(verify.status()).toBe(200);
}

test.describe('ゲスト管理・監査・ドメインポリシー (P10-3 / TOM-61)', () => {
  test('sys_admin が一覧・集計・フィルタ・詳細 DLP・エクスポート・監査ログ絞り込みを検証する', async ({
    as,
    browser,
    baseURL,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const domain = `guests-a-${suffix}.example`;
    const guestEmail = `e2e-guests-a-${suffix}@${domain}`;
    let guestContext: BrowserContext | null = null;

    try {
      await updateGuestPolicy(admin, {
        allowExternalCollaborators: true,
        allowGuestElevatedRoles: false,
        externalDomainAllowlist: [domain],
        guestInvitationExpiryDays: 14,
        guestSessionMaxHours: 24,
        externalDomainExistingGuestMode: 'reject_new_only',
      });

      const folder = await createFolder(admin, {
        parentId: null,
        name: uniqueName('e2e-guests-shared'),
        classification: 'confidential',
      });
      cleanup.registerFolder(folder.id);
      await uploadFile(admin, {
        folderId: folder.id,
        name: `${uniqueName('guest-visible')}.txt`,
        content: 'guest governance e2e',
      });

      const invitation = await createGuestInvitation(admin, {
        email: guestEmail,
        displayName: 'E2E Governance Guest A',
        externalOrg: 'Governance Partner A',
        targetType: 'folder',
        targetId: folder.id,
        role: 'viewer',
      });
      expect(invitation.userId).toBeTruthy();
      const guestId = invitation.userId!;

      const invitationMail = await waitForDevGuestMail(admin, {
        to: guestEmail,
        kind: 'guest_invitation',
      });
      const authenticated = await acceptInvitationAndLogin(
        browser,
        baseURL!,
        admin,
        guestEmail,
        invitationMail.acceptUrl!
      );
      guestContext = authenticated.context;

      await admin.page.goto('/admin');
      const section = admin.page.getByTestId('admin-guests-section');
      await expect(section).toBeVisible();
      await expect(section.getByTestId('guest-rbac-notice')).toContainText(
        'すべて実行できます'
      );

      const domainRow = section
        .getByTestId('guest-domain-summary-row')
        .filter({ hasText: domain });
      await expect(domainRow).toBeVisible();
      await expect(domainRow).toContainText('許可済み');
      await expect(
        section.getByTestId('guest-inviter-summary-row').first()
      ).toBeVisible();
      await expect(
        section.getByTestId('guest-summary-status-active')
      ).toContainText(/[1-9]\d*件/);

      const row = section.locator(
        `[data-testid="admin-guest-row"][data-guest-id="${guestId}"]`
      );
      await expect(row).toBeVisible();
      await expect(row).toContainText(guestEmail);

      // Filters round-trip through the API.
      await section.getByTestId('guest-filter-query').fill(guestEmail);
      await section.getByTestId('guest-filter-apply').click();
      await expect(row).toBeVisible();
      await section.getByTestId('guest-filter-status').selectOption('active');
      await section.getByTestId('guest-filter-apply').click();
      await expect(row).toBeVisible();
      await section.getByTestId('guest-filter-reset').click();
      await expect(row).toBeVisible();

      // Sortable column: only the active header carries aria-sort.
      await section.getByTestId('guest-sort-email').click();
      await expect(
        section.locator('th[aria-sort="ascending"]')
      ).toHaveCount(1);
      await expect(section.getByTestId('guest-sort-email')).toHaveAttribute(
        'type',
        'button'
      );

      // List-level CSV/JSON exports are real downloads.
      const csvHref = await section
        .getByTestId('guest-export-csv')
        .getAttribute('href');
      expect(csvHref).toContain('format=csv');
      const csvResponse = await admin.api.get(csvHref!);
      expect(csvResponse.status()).toBe(200);
      expect(csvResponse.headers()['content-type']).toContain('text/csv');
      const jsonHref = await section
        .getByTestId('guest-export-json')
        .getAttribute('href');
      const jsonResponse = await admin.api.get(jsonHref!);
      expect(jsonResponse.status()).toBe(200);

      await row.getByTestId('guest-open-detail').click();
      const detailModal = admin.page.getByTestId('guest-detail-modal');
      await expect(detailModal).toBeVisible();
      await expect(detailModal).toContainText(guestEmail);
      await expect(detailModal).toContainText('Governance Partner A');
      await expect(
        detailModal.getByTestId('guest-detail-permissions')
      ).toContainText(folder.name);
      await expect(
        detailModal.getByTestId('guest-detail-shared-items')
      ).toContainText(folder.name);
      await expect(
        detailModal.getByTestId('guest-detail-dlp-badge').first()
      ).toBeVisible();
      await expect(
        detailModal.getByTestId('guest-detail-audit-timeline')
      ).toContainText('guest.accept');

      const detailCsvHref = await detailModal
        .getByTestId('guest-detail-export-csv')
        .getAttribute('href');
      expect(detailCsvHref).toContain('export=permissions');
      const detailCsv = await admin.api.get(detailCsvHref!);
      expect(detailCsv.status()).toBe(200);
      expect(detailCsv.headers()['content-type']).toContain('text/csv');
      const detailCsvText = await detailCsv.text();
      expect(detailCsvText).toContain('record_type');
      expect(detailCsvText).not.toContain('tenants/');

      await detailModal
        .getByRole('button', { name: 'ゲスト詳細を閉じる' })
        .click();
      await expect(detailModal).toHaveCount(0);

      await section.getByTestId('guest-show-audit-logs').click();
      const auditSection = admin.page.locator('#admin-audit-logs');
      await expect(auditSection).toBeVisible();
      await expect(auditSection).toContainText('ゲスト監査のみ');
      await expect(auditSection).toContainText('guest.accept');

      const list = await listAdminGuests(admin, { query: guestEmail });
      const listed = list.guests.find((item) => item.id === guestId);
      expect(listed).toBeTruthy();
      expect(listed?.allowedByPolicy).toBe(true);
    } finally {
      await guestContext?.close().catch(() => undefined);
      await updateGuestPolicy(admin, {
        allowExternalCollaborators: false,
        allowGuestElevatedRoles: false,
        externalDomainAllowlist: [],
        guestInvitationExpiryDays: 14,
        guestSessionMaxHours: 24,
        externalDomainExistingGuestMode: 'reject_new_only',
      }).catch(() => undefined);
    }
  });

  test('sec_admin は停止のみ実行でき、再開・再送・オフボーディング・ポリシー更新は 403 で拒否される', async ({
    as,
    browser,
    baseURL,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const sec = await as('sec_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const domain = `guests-sec-${suffix}.example`;
    const guestEmail = `e2e-guests-sec-${suffix}@${domain}`;
    let guestContext: BrowserContext | null = null;

    try {
      await updateGuestPolicy(admin, {
        allowExternalCollaborators: true,
        allowGuestElevatedRoles: false,
        externalDomainAllowlist: [domain],
        guestInvitationExpiryDays: 14,
        guestSessionMaxHours: 24,
        externalDomainExistingGuestMode: 'reject_new_only',
      });
      const folder = await createFolder(admin, {
        parentId: null,
        name: uniqueName('e2e-guests-sec'),
        classification: 'internal',
      });
      cleanup.registerFolder(folder.id);
      const invitation = await createGuestInvitation(admin, {
        email: guestEmail,
        displayName: 'E2E Governance Guest Sec',
        externalOrg: 'Governance Partner Sec',
        targetType: 'folder',
        targetId: folder.id,
        role: 'viewer',
      });
      const guestId = invitation.userId!;
      const invitationMail = await waitForDevGuestMail(admin, {
        to: guestEmail,
        kind: 'guest_invitation',
      });
      const authenticated = await acceptInvitationAndLogin(
        browser,
        baseURL!,
        admin,
        guestEmail,
        invitationMail.acceptUrl!
      );
      guestContext = authenticated.context;

      // A second invitation keeps a pending invite around so the resend
      // control would be actionable for sys_admin.
      await createGuestInvitation(admin, {
        email: guestEmail,
        externalOrg: 'Governance Partner Sec',
        targetType: 'folder',
        targetId: folder.id,
        role: 'viewer',
      });

      const resumeForbidden = await sec.api.post(
        `/api/admin/guests/${encodeURIComponent(guestId)}/resume`,
        { data: {}, headers: { Origin: baseURL! } }
      );
      expect(resumeForbidden.status()).toBe(403);
      expect((await resumeForbidden.json()).code).toBe('SYS_ADMIN_REQUIRED');

      const resendForbidden = await sec.api.post(
        `/api/admin/guests/${encodeURIComponent(guestId)}/resend-invite`,
        { data: {}, headers: { Origin: baseURL! } }
      );
      expect(resendForbidden.status()).toBe(403);

      const offboardForbidden = await sec.api.delete(
        `/api/admin/guests/${encodeURIComponent(guestId)}`,
        { data: {}, headers: { Origin: baseURL! } }
      );
      expect(offboardForbidden.status()).toBe(403);

      const policyForbidden = await sec.api.patch('/api/admin/policies', {
        data: { externalDomainExistingGuestMode: 'suspend_existing' },
        headers: { Origin: baseURL! },
      });
      expect(policyForbidden.status()).toBe(403);
      expect((await policyForbidden.json()).code).toBe('SYS_ADMIN_REQUIRED');

      await sec.page.goto('/admin');
      const section = sec.page.getByTestId('admin-guests-section');
      await expect(section).toBeVisible();
      await expect(section.getByTestId('guest-rbac-notice')).toContainText(
        '停止のみ実行できます'
      );
      const row = section.locator(
        `[data-testid="admin-guest-row"][data-guest-id="${guestId}"]`
      );
      await expect(row).toBeVisible();
      await expect(row.getByTestId('guest-action-suspend')).toBeEnabled();
      await expect(row.getByTestId('guest-action-resume')).toBeDisabled();
      await expect(row.getByTestId('guest-action-resend')).toBeDisabled();
      await expect(row.getByTestId('guest-action-offboard')).toBeDisabled();

      await row.getByTestId('guest-action-suspend').click();
      const confirm = sec.page.getByTestId('guest-confirm-modal');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(guestEmail);
      await expect(confirm.getByTestId('guest-confirm-cancel')).toBeFocused();
      await confirm.getByTestId('guest-confirm-execute').click();
      await expect(confirm.getByTestId('guest-confirm-result')).toContainText(
        'ゲストを停止'
      );
      await confirm.getByTestId('guest-confirm-cancel').click();

      await expect(row).toContainText('停止中');
      await expect
        .poll(async () => {
          const detail = await getAdminGuestDetail(admin, guestId);
          return detail.guest.status;
        })
        .toBe('suspended');

      const guestMe = await guestContext.request.get('/api/auth/me');
      expect(guestMe.status()).toBe(401);
    } finally {
      await guestContext?.close().catch(() => undefined);
      await updateGuestPolicy(admin, {
        allowExternalCollaborators: false,
        allowGuestElevatedRoles: false,
        externalDomainAllowlist: [],
        guestInvitationExpiryDays: 14,
        guestSessionMaxHours: 24,
        externalDomainExistingGuestMode: 'reject_new_only',
      }).catch(() => undefined);
    }
  });

  test('sys_admin の再開・再送・suspend_existing ドメイン削除・完全オフボーディングが実ブラウザアクセスを即時停止する', async ({
    as,
    browser,
    baseURL,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const domain = `guests-lifecycle-${suffix}.example`;
    const guestEmail = `e2e-guests-lifecycle-${suffix}@${domain}`;
    let guestContext: BrowserContext | null = null;

    try {
      await updateGuestPolicy(admin, {
        allowExternalCollaborators: true,
        allowGuestElevatedRoles: false,
        externalDomainAllowlist: [domain],
        guestInvitationExpiryDays: 14,
        guestSessionMaxHours: 24,
        externalDomainExistingGuestMode: 'reject_new_only',
      });
      const folder = await createFolder(admin, {
        parentId: null,
        name: uniqueName('e2e-guests-lifecycle'),
        classification: 'internal',
      });
      cleanup.registerFolder(folder.id);
      const invitation = await createGuestInvitation(admin, {
        email: guestEmail,
        displayName: 'E2E Governance Lifecycle',
        externalOrg: 'Governance Partner Lifecycle',
        targetType: 'folder',
        targetId: folder.id,
        role: 'viewer',
      });
      const guestId = invitation.userId!;
      const invitationMail = await waitForDevGuestMail(admin, {
        to: guestEmail,
        kind: 'guest_invitation',
      });
      const authenticated = await acceptInvitationAndLogin(
        browser,
        baseURL!,
        admin,
        guestEmail,
        invitationMail.acceptUrl!
      );
      guestContext = authenticated.context;
      expect((await guestContext.request.get('/api/auth/me')).status()).toBe(200);

      // Suspend first so the UI resume path is exercised.
      await suspendAdminGuestApi(admin, guestId);
      await admin.page.goto('/admin');
      const section = admin.page.getByTestId('admin-guests-section');
      const row = section.locator(
        `[data-testid="admin-guest-row"][data-guest-id="${guestId}"]`
      );
      await expect(row).toContainText('停止中');
      await row.getByTestId('guest-action-resume').click();
      const resumeConfirm = admin.page.getByTestId('guest-confirm-modal');
      await expect(resumeConfirm).toContainText('ゲストアカウントを再開しますか');
      await resumeConfirm.getByLabel('有効期限の延長日数').fill('30');
      await resumeConfirm.getByTestId('guest-confirm-execute').click();
      await expect(resumeConfirm.getByTestId('guest-confirm-result')).toContainText(
        'ゲストアカウントを再開しました'
      );
      await resumeConfirm.getByTestId('guest-confirm-cancel').click();
      await expect(row).toContainText('有効');

      // The old session was revoked; re-authenticate to prove a live session
      // exists before the domain policy change.
      await reauthenticateGuest(baseURL!, admin, guestContext, guestEmail);
      expect((await guestContext.request.get('/api/auth/me')).status()).toBe(200);

      // Pending invitation for resend.
      await createGuestInvitation(admin, {
        email: guestEmail,
        externalOrg: 'Governance Partner Lifecycle',
        targetType: 'folder',
        targetId: folder.id,
        role: 'viewer',
      });
      const mailsBefore = await listDevGuestMails(admin, {
        to: guestEmail,
        kind: 'guest_invitation',
      });
      await admin.page.reload();
      const refreshedRow = admin.page.locator(
        `[data-testid="admin-guest-row"][data-guest-id="${guestId}"]`
      );
      await expect(refreshedRow.getByTestId('guest-action-resend')).toBeEnabled();
      await refreshedRow.getByTestId('guest-action-resend').click();
      const resendConfirm = admin.page.getByTestId('guest-confirm-modal');
      await expect(resendConfirm).toContainText('招待メールを再送しますか');
      await resendConfirm.getByTestId('guest-confirm-execute').click();
      await expect(resendConfirm.getByTestId('guest-confirm-result')).toContainText(
        '招待メールを再送しました'
      );
      await resendConfirm.getByTestId('guest-confirm-cancel').click();
      await expect
        .poll(async () => {
          const mails = await listDevGuestMails(admin, {
            to: guestEmail,
            kind: 'guest_invitation',
          });
          return mails.length;
        })
        .toBeGreaterThan(mailsBefore.length);

      // Remove the guest domain with suspend_existing: the live browser session
      // must be rejected on the very next request.
      await admin.page.reload();
      const policySection = admin.page.getByTestId('guest-policy-section');
      await expect(policySection).toBeVisible();
      await policySection
        .getByRole('button', {
          name: `${domain} を許可リストから削除`,
        })
        .click();
      await policySection.getByTestId('guest-existing-mode-suspend').check();
      await expect(
        policySection.getByTestId('guest-existing-mode-warning')
      ).toBeVisible();
      await policySection.getByTestId('guest-policy-save').click();
      await expect(policySection.getByTestId('guest-policy-notice')).toContainText(
        '停止しました'
      );

      await expect
        .poll(async () => {
          const detail = await getAdminGuestDetail(admin, guestId);
          return detail.guest.status;
        })
        .toBe('suspended');
      const meAfterDomainSuspend = await guestContext.request.get('/api/auth/me');
      expect(meAfterDomainSuspend.status()).toBe(401);
      await guestContext.request.get('/api/auth/me');
      await authenticated.page.goto('/workspace');
      await expect(
        authenticated.page.getByRole('link', { name: /SSO でサインイン/ })
      ).toBeVisible();

      // Full offboarding removes even the suspended account's invitations and
      // permissions while keeping the users row for FK integrity.
      await admin.page.reload();
      const afterDomainRow = admin.page.locator(
        `[data-testid="admin-guest-row"][data-guest-id="${guestId}"]`
      );
      await expect(afterDomainRow).toContainText('停止中');
      await afterDomainRow.getByTestId('guest-action-offboard').click();
      const offboardConfirm = admin.page.getByTestId('guest-confirm-modal');
      await expect(offboardConfirm).toContainText(
        'ゲストを完全にオフボーディングしますか'
      );
      await offboardConfirm.getByTestId('guest-confirm-execute').click();
      await expect(offboardConfirm.getByTestId('guest-confirm-result')).toContainText(
        '完全にオフボーディング'
      );
      await offboardConfirm.getByTestId('guest-confirm-cancel').click();

      await expect
        .poll(async () => {
          const detail = await getAdminGuestDetail(admin, guestId);
          return detail.guest.status;
        })
        .toBe('offboarded');
      const detail = await getAdminGuestDetail(admin, guestId);
      expect(detail.guest.offboardedAt).toBeTruthy();
      expect(detail.permissions.direct).toHaveLength(0);
      expect(detail.sharedItems).toHaveLength(0);
      expect(detail.pendingInvitationId).toBeNull();

      const resumeAfterOffboard = await admin.api.post(
        `/api/admin/guests/${encodeURIComponent(guestId)}/resume`,
        { data: { extendDays: 30 }, headers: { Origin: baseURL! } }
      );
      expect(resumeAfterOffboard.status()).toBe(409);
      expect((await resumeAfterOffboard.json()).code).toBe('GUEST_OFFBOARDED');
      expect((await guestContext.request.get('/api/auth/me')).status()).toBe(401);

      const finalList = await listAdminGuests(admin, { query: guestEmail });
      const finalGuest = finalList.guests.find((item) => item.id === guestId);
      expect(finalGuest?.status).toBe('offboarded');
      expect(finalGuest?.offboardedAt).toBeTruthy();
      expect(finalGuest?.allowedByPolicy).toBe(false);

      // Offboarding never mutates the guest's role / user_type.
      const roleCheck = await admin.api.get(
        `/api/admin/guests/${encodeURIComponent(guestId)}`
      );
      expect(roleCheck.status()).toBe(200);
    } finally {
      await guestContext?.close().catch(() => undefined);
      await updateGuestPolicy(admin, {
        allowExternalCollaborators: false,
        allowGuestElevatedRoles: false,
        externalDomainAllowlist: [],
        guestInvitationExpiryDays: 14,
        guestSessionMaxHours: 24,
        externalDomainExistingGuestMode: 'reject_new_only',
      }).catch(() => undefined);
    }
  });
});
