import { expect, test } from './fixtures';
import {
  createFolder,
  createGuestInvitation,
  expectGuestInvitationStatus,
  revokeGuestInvitation,
  updateGuestPolicy,
  uploadFile,
  waitForDevGuestMail,
} from './helpers/api';
import { uniqueName } from './helpers/browser';

test.describe('外部ゲストアカウント基盤 (P10-1 / TOM-59)', () => {
  test('管理者ポリシー設定からゲスト招待・OTP ログイン・失効まで一気通貫で検証する', async ({
    as,
    browser,
    baseURL,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const suffix = crypto.randomUUID().slice(0, 8);
    const guestEmail = `e2e-guest-${suffix}@partner.example`;
    const deniedEmail = `e2e-denied-${suffix}@not-allowed.example`;
    let invitationId: string | null = null;

    try {
      await updateGuestPolicy(admin, {
        allowExternalCollaborators: false,
        externalDomainAllowlist: [],
      });

      await admin.page.goto('/admin');
      await expect(
        admin.page.getByRole('heading', {
          name: 'ガバナンス & セキュリティ統合ダッシュボード',
        })
      ).toBeVisible();
      await admin.page.getByTestId('admin-tab-settings').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-settings')
      ).toBeVisible();
      await admin.page.getByTestId('enterprise-topic-guest-policy').click();

      const section = admin.page.getByTestId('guest-policy-section');
      await expect(section).toBeVisible();
      await expect(
        section.getByRole('heading', { name: '外部ゲストコラボレーター' })
      ).toBeVisible();
      await expect(
        section.getByTestId('guest-policy-comparison-guide')
      ).toContainText('共有リンク');
      await expect(
        section.getByTestId('guest-policy-comparison-guide')
      ).toContainText('外部ゲストコラボレーター');
      await expect(
        section.getByTestId('guest-policy-comparison-guide')
      ).toContainText('管理画面・ルート作成・監査ログにはアクセス不可');

      const allowSwitch = section.getByTestId(
        'guest-allow-external-collaborators'
      );
      await expect(allowSwitch).not.toBeChecked();
      await allowSwitch.check({ force: true });
      await section.getByTestId('guest-allow-elevated-roles').check({
        force: true,
      });
      await section.getByTestId('guest-domain-input').fill('Partner.Example');
      await section.getByTestId('guest-domain-add').click();
      await expect(section.getByTestId('guest-domain-list')).toContainText(
        'partner.example'
      );
      await section
        .getByTestId('guest-invitation-expiry-days')
        .fill('14');
      await section.getByTestId('guest-session-max-hours').fill('24');
      await section.getByTestId('guest-policy-save').click();
      await expect(section.getByTestId('guest-policy-notice')).toContainText(
        '外部ゲストポリシーを保存しました'
      );

      await admin.page.reload();
      const reloaded = admin.page.getByTestId('guest-policy-section');
      await expect(
        reloaded.getByTestId('guest-allow-external-collaborators')
      ).toBeChecked();
      await expect(
        reloaded.getByTestId('guest-allow-elevated-roles')
      ).toBeChecked();
      await expect(reloaded.getByTestId('guest-domain-list')).toContainText(
        'partner.example'
      );
      await expect(
        reloaded.getByTestId('guest-invitation-expiry-days')
      ).toHaveValue('14');
      await expect(reloaded.getByTestId('guest-session-max-hours')).toHaveValue(
        '24'
      );

      const root = await createFolder(admin, {
        parentId: null,
        name: uniqueName('e2e-guest-root'),
        classification: 'internal',
      });
      cleanup.registerFolder(root.id);
      const sharedFolder = await createFolder(admin, {
        parentId: root.id,
        name: uniqueName('e2e-guest-shared'),
        classification: 'internal',
      });
      const fileName = `${uniqueName('guest-visible')}.txt`;
      await uploadFile(admin, {
        folderId: sharedFolder.id,
        name: fileName,
        content: 'external guest can read this file',
      });

      const denied = await expectGuestInvitationStatus(
        admin,
        {
          email: deniedEmail,
          targetType: 'folder',
          targetId: sharedFolder.id,
          role: 'viewer',
        },
        403
      );
      expect(denied.body.code).toBe('EXTERNAL_DOMAIN_NOT_ALLOWED');

      const invitation = await createGuestInvitation(admin, {
        email: guestEmail,
        displayName: 'E2E External Guest',
        externalOrg: 'Partner E2E',
        targetType: 'folder',
        targetId: sharedFolder.id,
        role: 'viewer',
      });
      invitationId = invitation.id;

      await admin.page.reload();
      const invitationRow = admin.page
        .getByTestId('guest-invitation-row')
        .filter({ hasText: guestEmail });
      await expect(invitationRow).toBeVisible();
      await expect(invitationRow).toContainText('招待中');

      const invitationMail = await waitForDevGuestMail(admin, {
        to: guestEmail,
        kind: 'guest_invitation',
      });
      expect(invitationMail.token).toBeTruthy();
      expect(invitationMail.acceptUrl).toContain('/guest/accept?token=');

      const guestContext = await browser.newContext({
        baseURL,
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        viewport: { width: 1440, height: 900 },
      });
      const guestPage = await guestContext.newPage();
      guestPage.setDefaultTimeout(15_000);
      try {
          await guestPage.goto(invitationMail.acceptUrl!);
          await expect(
            guestPage.getByRole('heading', { name: '外部ゲスト招待の承諾' })
          ).toBeVisible();
          await expect(
            guestPage.getByTestId('guest-accept-panel')
          ).toContainText('Partner E2E');
          await expect(
            guestPage.getByTestId('guest-accept-panel')
          ).toContainText('E2E External Guest');
          await expect(
            guestPage.getByTestId('guest-accept-panel')
          ).toContainText(sharedFolder.name);

          const acceptButton = guestPage.getByTestId('guest-accept-submit');
          await expect(acceptButton).toBeEnabled();
          await acceptButton.click();
          await expect(
            guestPage.getByTestId('guest-accept-notice')
          ).toContainText('6 桁の認証コードを送信しました');

          const otpMail = await waitForDevGuestMail(admin, {
            to: guestEmail,
            kind: 'guest_otp',
          });
          expect(otpMail.otpCode).toMatch(/^\d{6}$/);
          await guestPage.getByTestId('guest-otp-input').fill(otpMail.otpCode!);
          await guestPage.getByTestId('guest-otp-submit').click();
          await guestPage.waitForURL(/\/workspace(?:\?|$)/, {
            timeout: 30_000,
          });

          await guestPage.goto(
            `/workspace?folderId=${encodeURIComponent(sharedFolder.id)}`
          );
          await expect(guestPage.getByText(fileName).first()).toBeVisible();
          await expect(
            guestPage.getByRole('link', { name: 'ガバナンス' })
          ).toHaveCount(0);
          await expect(
            guestPage.getByRole('button', { name: '新規フォルダ' })
          ).toHaveCount(0);

          const guestMe = await guestContext.request.get('/api/auth/me');
          expect(guestMe.status()).toBe(200);
          const guestMeBody = (await guestMe.json()) as {
            user: { userType: string; externalOrg: string | null };
          };
          expect(guestMeBody.user).toMatchObject({
            userType: 'guest',
            externalOrg: 'Partner E2E',
          });

          for (const path of [
            '/api/admin/policies',
            '/api/audit-logs',
            '/api/file-requests',
          ]) {
            const response = await guestContext.request.get(path);
            expect(response.status(), `${path} must be guest-forbidden`).toBe(403);
            const body = (await response.json()) as { code?: string };
            expect(body.code).toBe('GUEST_FORBIDDEN');
          }

          const rootCreate = await guestContext.request.post('/api/folders', {
            data: { parentId: null, name: uniqueName('guest-root-denied') },
          });
          expect(rootCreate.status()).toBe(403);
          const rootCreateBody = (await rootCreate.json()) as { code?: string };
          expect(rootCreateBody.code).toBe('GUEST_FORBIDDEN');

          await guestPage.goto('/admin');
          await expect(
            guestPage.getByRole('heading', {
              name: 'アクセス権限がありません (403)',
            })
          ).toBeVisible();

          const reuse = await guestContext.request.post('/auth/guest/accept', {
            data: { token: invitationMail.token },
            headers: { Origin: baseURL! },
          });
          expect(reuse.status()).toBe(410);
          const reuseBody = (await reuse.json()) as { code?: string };
          expect(reuseBody.code).toBe('INVITATION_ALREADY_USED');

          const liveAdminRow = admin.page
            .getByTestId('guest-invitation-row')
            .filter({ hasText: guestEmail });
          await expect(
            liveAdminRow.getByRole('button', { name: '再送' })
          ).toBeVisible();
          await liveAdminRow.getByRole('button', { name: '取消' }).click();
          await expect(
            admin.page.getByRole('status').filter({
              hasText:
                '招待を取り消し、ゲストの有効セッションを失効させました。',
            })
          ).toBeVisible();

          const afterRevoke = await guestContext.request.get('/api/auth/me');
          expect(afterRevoke.status()).toBe(401);

          await guestPage.goto('/workspace');
          await expect(
            guestPage.getByRole('link', { name: /SSO でサインイン/ })
          ).toBeVisible();
      } finally {
        await guestContext.close();
      }

      await admin.page.reload();
      const revokedRow = admin.page
        .getByTestId('guest-invitation-row')
        .filter({ hasText: guestEmail });
      await expect(revokedRow).toContainText('取消済み');
    } finally {
      if (invitationId) {
        try {
          await revokeGuestInvitation(admin, invitationId);
        } catch {
          // The invitation may already be revoked, which is idempotent on the API.
        }
      }
      await updateGuestPolicy(admin, {
        allowExternalCollaborators: false,
        allowGuestElevatedRoles: false,
        externalDomainAllowlist: [],
        guestInvitationExpiryDays: 14,
        guestSessionMaxHours: 24,
      });
    }
  });
});
