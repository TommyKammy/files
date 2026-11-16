import type { APIResponse } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  COLLABORA_ORIGIN,
  DOCX_MIME_TYPE,
  closeCollaboraEditor,
  collaboraSaveButton,
  createE2EWopiSession,
  dismissCollaboraOverlays,
  dismissCollaboraWelcome,
  fetchWopiCheckFileInfo,
  fetchWopiContents,
  postWopiContents,
  waitForCollaboraEditor,
} from './helpers/collabora';
import {
  acquireDriveLock,
  createFolder,
  downloadFileBytes,
  findRootFolder,
  getFileDetails,
  grantPermission,
  releaseDriveLock,
  uploadFile,
  waitForFileVersion,
  waitForLockStatus,
} from './helpers/api';
import { buildDocx } from './helpers/docx';
import { uniqueName, waitForRealtimeConnected } from './helpers/browser';

const collaboraOrigin = COLLABORA_ORIGIN;

test.describe('@collabora Collabora Online integration', () => {
  test('@collabora WOPI discovery が到達可能で docx edit アクションを公開する', async ({
    request,
  }) => {
    let response: APIResponse;
    try {
      response = await request.get(
        `${collaboraOrigin}/hosting/discovery`,
        { timeout: 10_000 }
      );
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error))
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ?? 'unknown connection error';
      throw new Error(
        `Collabora Online に接続できませんでした: ${collaboraOrigin}/hosting/discovery (${reason}). ` +
          'Collabora コンテナを起動してから再実行してください: ' +
          'docker compose -f docker-compose.collabora.yml up -d'
      );
    }

    expect(
      response.ok(),
      `GET ${collaboraOrigin}/hosting/discovery failed with HTTP ${response.status()}. ` +
        'Collabora コンテナが起動しているか確認してください: ' +
        'docker compose -f docker-compose.collabora.yml up -d'
    ).toBe(true);

    const xml = await response.text();
    expect(xml).toContain('<wopi-discovery');
    expect(xml).toContain('<net-zone');

    const actionTags = [...xml.matchAll(/<action\b[^>]*>/gi)].map(
      (match) => match[0]
    );
    expect(actionTags.length).toBeGreaterThan(0);
    expect(
      actionTags.some(
        (tag) => /name="edit"/i.test(tag) && /ext="docx"/i.test(tag)
      ),
      'Collabora discovery must advertise an editable docx action'
    ).toBe(true);
    expect(
      actionTags.some(
        (tag) => /name="view"/i.test(tag) && /ext="docx"/i.test(tag)
      ),
      'Collabora discovery must advertise a viewable docx action'
    ).toBe(true);
  });

  test('@collabora 2ブラウザ同時編集・TenantSyncHubロック反映・UNLOCK版確定まで実機検証する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(360_000);
    const admin = await as('sys_admin');
    const member = await as('member');

    const general = await findRootFolder(admin, '全社共有');
    const folder = await createFolder(admin, {
      parentId: general.id,
      name: uniqueName('e2e-collabora'),
      classification: 'internal',
    });
    cleanup.registerFolder(folder.id);
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: folder.id,
      granteeType: 'user',
      granteeId: member.user.id,
      role: 'editor',
    });

    const editToken = `collabora-${uniqueName('edit')}`;
    const initialDocx = buildDocx({
      paragraphs: [
        'Files E2E Collabora document',
        `Initial marker: ${editToken}`,
      ],
      title: editToken,
    });
    const fileName = `${uniqueName('collabora')}.docx`;
    const uploaded = await uploadFile(admin, {
      folderId: folder.id,
      name: fileName,
      content: initialDocx,
      mimeType: DOCX_MIME_TYPE,
    });
    expect(uploaded.current_version_num).toBe(1);
    const initialDetail = await getFileDetails(admin, uploaded.id);
    expect(initialDetail.file.current_version_num).toBe(1);
    expect(initialDetail.file.size_bytes).toBe(initialDocx.byteLength);

    // Browser 2 keeps the workspace open to observe TenantSyncHub lock updates.
    const folderUrl = `/workspace?folderId=${encodeURIComponent(folder.id)}`;
    await member.page.goto(folderUrl);
    await waitForRealtimeConnected(member.page);
    await expect(
      member.page
        .getByRole('main')
        .getByRole('button', { name: fileName, exact: true })
    ).toBeVisible({ timeout: 20_000 });

    // Browser 1 starts the real Collabora edit session.
    await admin.page.goto(
      `/workspace/file/${encodeURIComponent(uploaded.id)}`
    );
    const adminFrame = await waitForCollaboraEditor(admin.page);
    await expect(admin.page.getByText('Collabora Online 同時編集')).toBeVisible();
    await expect(admin.page.getByText('Editing', { exact: true })).toBeVisible();

    const lockStatus = await waitForLockStatus(
      admin,
      uploaded.id,
      (status) => status.lock?.mode === 'wopi_collab'
    );
    expect(lockStatus.lock?.ownerId).toBe(admin.user.id);
    expect(lockStatus.readOnly).toBe(false);

    // Browser 2 sees the FileLockHub -> TenantSyncHub `file.lock_changed` signal.
    const memberRow = member.page
      .getByRole('row')
      .filter({ hasText: fileName });
    await expect(memberRow.getByText('編集中')).toBeVisible({
      timeout: 20_000,
    });

    // While Web editing is active, Files Drive must not take desktop_exclusive.
    const driveAttempt = await member.api.post(
      `/api/files/${encodeURIComponent(uploaded.id)}/lock`,
      { data: { lockId: 'e2e-drive-while-wopi' } }
    );
    expect(driveAttempt.status()).toBe(409);
    const driveBody = (await driveAttempt.json()) as {
      code: string;
      readOnlyRecommended: boolean;
      webEditUrl: string;
      wopiSessionPath: string;
    };
    expect(driveBody.code).toBe('WOPI_LOCK_ACTIVE');
    expect(driveBody.readOnlyRecommended).toBe(true);
    expect(driveBody.webEditUrl).toContain(uploaded.id);
    expect(driveBody.wopiSessionPath).toContain(uploaded.id);

    // Browser 2 joins the same Collabora document concurrently.
    const memberEditor = await member.context.newPage();
    await memberEditor.goto(
      `/workspace/file/${encodeURIComponent(uploaded.id)}`
    );
    const memberFrame = await waitForCollaboraEditor(memberEditor);
    await expect(memberEditor.getByText('Editing', { exact: true })).toBeVisible();
    await expect(memberFrame.locator('#document-container')).toBeVisible();
    await expect(admin.page.getByText('接続済み')).toBeVisible();
    await expect(adminFrame.locator('#document-container')).toBeVisible();

    // Real Collabora UI edit + Save, which triggers a real WOPI PutFile.
    await dismissCollaboraOverlays(admin.page, adminFrame);
    await adminFrame
      .locator('#document-container')
      .click({ position: { x: 400, y: 300 } });
    await admin.page.keyboard.insertText(`EDITED-${editToken}`);
    await collaboraSaveButton(adminFrame).click();

    const adminWopi = await createE2EWopiSession(admin, uploaded.id);
    expect(adminWopi.canWrite).toBe(true);
    await expect
      .poll(
        async () => {
          const current = await fetchWopiContents(
            adminWopi.accessToken,
            uploaded.id
          );
          return current.equals(initialDocx);
        },
        {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'Collabora PutFile must replace the WOPI draft bytes',
        }
      )
      .toBe(false);

    const beforeUnlock = await getFileDetails(admin, uploaded.id);
    expect(beforeUnlock.file.current_version_num).toBe(1);
    expect(beforeUnlock.versions.map((version) => version.version_num)).toEqual([
      1,
    ]);

    await memberEditor.close();
    await closeCollaboraEditor(admin.page);
    await waitForLockStatus(
      admin,
      uploaded.id,
      (status) => status.lock === null,
      60_000
    );

    const finalized = await waitForFileVersion(admin, uploaded.id, 2, 60_000);
    expect(finalized.versions.map((version) => version.version_num)).toEqual([
      2, 1,
    ]);
    expect(finalized.file.current_version_num).toBeGreaterThanOrEqual(2);
    expect(finalized.file.size_bytes).toBeGreaterThan(initialDocx.byteLength);

    // The formal version must be backed by the real R2 object, not just D1 metadata.
    const finalizedBytes = await downloadFileBytes(admin, uploaded.id);
    expect(finalizedBytes.byteLength).toBe(finalized.file.size_bytes);
    expect(finalizedBytes.subarray(0, 2).toString('utf8')).toBe('PK');

    // Workspace list is updated from the `file.version_finalized` delta without reload.
    const versionBadge = member.page
      .getByRole('row')
      .filter({ hasText: fileName })
      .getByText(`v${finalized.file.current_version_num}`, { exact: true });
    await expect(versionBadge).toBeVisible({ timeout: 30_000 });
    await expect(memberRow.getByText('編集中')).toHaveCount(0);
  });

  test('@collabora previewer + confidential のDLP読み取り専用とPutFile遮断を実機検証する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const member = await as('member');

    // A root-level confidential folder avoids inheriting member's editor role
    // from 全社共有 and proves previewer DLP in the same session.
    const folder = await createFolder(admin, {
      parentId: null,
      name: uniqueName('e2e-dlp'),
      classification: 'confidential',
    });
    cleanup.registerFolder(folder.id);
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: folder.id,
      granteeType: 'user',
      granteeId: member.user.id,
      role: 'previewer',
    });

    const initialDocx = buildDocx({
      paragraphs: ['Confidential DLP document', `marker ${uniqueName('dlp')}`],
      title: 'Confidential DLP',
    });
    const fileName = `${uniqueName('confidential')}.docx`;
    const uploaded = await uploadFile(admin, {
      folderId: folder.id,
      name: fileName,
      content: initialDocx,
      mimeType: DOCX_MIME_TYPE,
    });
    expect(uploaded.classification).toBe('confidential');
    expect(uploaded.current_version_num).toBe(1);

    const session = await createE2EWopiSession(member, uploaded.id);
    expect(session.role).toBe('previewer');
    expect(session.classification).toBe('confidential');
    expect(session.canWrite).toBe(false);
    expect(session.readOnly).toBe(true);
    expect(session.readOnlyReason).toBe('dlp');

    const info = await fetchWopiCheckFileInfo(
      session.accessToken,
      uploaded.id
    );
    expect(info.UserCanWrite).toBe(false);
    expect(info.ReadOnly).toBe(true);
    expect(info.DisablePrint).toBe(true);
    expect(info.DisableExport).toBe(true);
    expect(info.DisableCopy).toBe(true);
    expect(info.HidePrintOption).toBe(true);
    expect(info.HideExportOption).toBe(true);
    expect(String(info.WatermarkText)).toContain(member.user.email);

    const initialBytes = await fetchWopiContents(
      session.accessToken,
      uploaded.id
    );
    expect(initialBytes.equals(initialDocx)).toBe(true);

    const putAttempt = await postWopiContents(
      session.accessToken,
      uploaded.id,
      { lock: 'dlp-e2e-lock', body: 'dlp-write-attempt' }
    );
    expect(putAttempt.status).toBe(403);
    expect(
      ((await putAttempt.json()) as { code: string }).code
    ).toBe('WOPI_READ_ONLY');

    await member.page.goto(
      `/workspace/file/${encodeURIComponent(uploaded.id)}`
    );
    await expect(
      member.page.getByText('閲覧専用（DLP保護）')
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      member.page.getByText('Read-only', { exact: true })
    ).toBeVisible();

    const frame = await waitForCollaboraEditor(member.page);
    await expect(frame.getByText('読み取り専用').first()).toBeVisible();
    await expect(collaboraSaveButton(frame)).toBeHidden();
    await dismissCollaboraWelcome(member.page);

    // A real Ctrl/Cmd+S in the viewer must not produce a WOPI draft.
    await frame
      .locator('#document-container')
      .click({ position: { x: 400, y: 300 } });
    await member.page.keyboard.press('ControlOrMeta+s');
    await member.page.waitForTimeout(3_000);

    const afterSaveAttempt = await fetchWopiContents(
      session.accessToken,
      uploaded.id
    );
    expect(afterSaveAttempt.equals(initialDocx)).toBe(true);

    await closeCollaboraEditor(member.page);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const detail = await getFileDetails(member, uploaded.id);
      expect(detail.file.current_version_num).toBe(1);
      expect(detail.file.size_bytes).toBe(initialDocx.byteLength);
      await member.page.waitForTimeout(1_000);
    }
  });

  test('@collabora desktop_exclusiveロック中はWeb WOPIが自動Read-onlyになり書込を拒否する', async ({
    as,
    cleanup,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const member = await as('member');

    const general = await findRootFolder(admin, '全社共有');
    const folder = await createFolder(admin, {
      parentId: general.id,
      name: uniqueName('e2e-desktop-lock'),
      classification: 'internal',
    });
    cleanup.registerFolder(folder.id);
    await grantPermission(admin, {
      targetType: 'folder',
      targetId: folder.id,
      granteeType: 'user',
      granteeId: member.user.id,
      role: 'editor',
    });

    const initialDocx = buildDocx({
      paragraphs: ['Files Drive desktop locked document'],
    });
    const fileName = `${uniqueName('desktop-lock')}.docx`;
    const uploaded = await uploadFile(admin, {
      folderId: folder.id,
      name: fileName,
      content: initialDocx,
      mimeType: DOCX_MIME_TYPE,
    });

    const lockId = `e2e-desktop-${Date.now()}`;
    await acquireDriveLock(admin, uploaded.id, {
      lockId,
      ttlSeconds: 300,
    });

    try {
      const lockStatus = await waitForLockStatus(
        member,
        uploaded.id,
        (status) => status.lock?.mode === 'desktop_exclusive'
      );
      expect(lockStatus.readOnly).toBe(true);

      const session = await createE2EWopiSession(member, uploaded.id);
      expect(session.canWrite).toBe(false);
      expect(session.readOnly).toBe(true);
      expect(session.readOnlyReason).toBe('desktop_lock');

      const info = await fetchWopiCheckFileInfo(
        session.accessToken,
        uploaded.id
      );
      expect(info.UserCanWrite).toBe(false);
      expect(info.ReadOnly).toBe(true);

      const putAttempt = await postWopiContents(
        session.accessToken,
        uploaded.id,
        { lock: lockId, body: 'desktop-lock-write-attempt' }
      );
      expect(putAttempt.status).toBe(403);
      expect(
        ((await putAttempt.json()) as { code: string }).code
      ).toBe('WOPI_READ_ONLY');

      await member.page.goto(
        `/workspace/file/${encodeURIComponent(uploaded.id)}`
      );
      await expect(
        member.page.getByText('閲覧専用（Files Drive 編集中）')
      ).toBeVisible({ timeout: 90_000 });
      await expect(
        member.page.getByText('Read-only', { exact: true })
      ).toBeVisible();

      const frame = await waitForCollaboraEditor(member.page);
      await expect(frame.getByText('読み取り専用').first()).toBeVisible();
      await expect(collaboraSaveButton(frame)).toBeHidden();

      const detail = await getFileDetails(member, uploaded.id);
      expect(detail.file.current_version_num).toBe(1);
      expect(detail.file.size_bytes).toBe(initialDocx.byteLength);

      await closeCollaboraEditor(member.page);
    } finally {
      await releaseDriveLock(admin, uploaded.id, lockId);
    }

    const released = await waitForLockStatus(
      admin,
      uploaded.id,
      (status) => status.lock === null
    );
    expect(released.readOnly).toBe(false);
    const finalDetail = await getFileDetails(admin, uploaded.id);
    expect(finalDetail.file.current_version_num).toBe(1);
  });
});
