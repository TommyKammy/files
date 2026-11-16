import { expect, type Frame, type Page } from '@playwright/test';
import type { ApiActor } from './api';

export const COLLABORA_ORIGIN =
  process.env.E2E_COLLABORA_URL ?? 'http://localhost:9980';
export const E2E_API_ORIGIN = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 18787}`;
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface E2EWopiSession {
  sessionId: string;
  role: string;
  classification: 'unset' | 'confidential' | 'internal' | 'public';
  canWrite: boolean;
  readOnly: boolean;
  readOnlyReason: 'desktop_lock' | 'dlp' | 'permission' | null;
  accessToken: string;
  wopiActionUrl: string | null;
}

export async function createE2EWopiSession(
  actor: ApiActor,
  fileId: string
): Promise<E2EWopiSession> {
  const res = await actor.api.post(
    `/api/files/${encodeURIComponent(fileId)}/wopi-session`,
    { data: {} }
  );
  expect(res.status(), `POST /api/files/${fileId}/wopi-session`).toBe(201);
  return (await res.json()) as E2EWopiSession;
}

export async function fetchWopiCheckFileInfo(
  token: string,
  fileId: string
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${E2E_API_ORIGIN}/wopi/files/${encodeURIComponent(fileId)}?access_token=${encodeURIComponent(token)}`
  );
  expect(res.status, 'GET WOPI CheckFileInfo should return 200').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

export async function fetchWopiContents(
  token: string,
  fileId: string
): Promise<Buffer> {
  const res = await fetch(
    `${E2E_API_ORIGIN}/wopi/files/${encodeURIComponent(fileId)}/contents?access_token=${encodeURIComponent(token)}`
  );
  expect(res.status, 'GET WOPI GetFile should return 200').toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

export async function postWopiContents(
  token: string,
  fileId: string,
  input: { lock: string; body: string }
): Promise<Response> {
  return fetch(
    `${E2E_API_ORIGIN}/wopi/files/${encodeURIComponent(fileId)}/contents?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'X-WOPI-Lock': input.lock },
      body: input.body,
    }
  );
}

/**
 * Finds the Collabora `cool.html` child frame. The iframe is cross-origin but
 * Playwright can still inspect it through the browser's frame tree.
 */
export async function waitForCollaboraFrame(
  page: Page,
  timeout = 90_000
): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(
      () => {
        frame = page
          .frames()
          .find((candidate) => candidate.url().includes('/cool.html?'));
        return Boolean(frame);
      },
      { timeout, message: 'Collabora cool.html frame should attach' }
    )
    .toBe(true);
  return frame!;
}

/**
 * Waits for the WopiEditorFrame handshake plus a rendered Collabora document.
 * The `接続済み` status is set by the real postMessage handshake, not a timer.
 */
export async function waitForCollaboraEditor(
  page: Page
): Promise<Frame> {
  await expect(page.getByText('接続済み')).toBeVisible({ timeout: 90_000 });
  const frame = await waitForCollaboraFrame(page);
  await expect(frame.locator('#document-container')).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    frame.getByText(/Fatal error|The document could not be loaded|文書を読み込めません/)
  ).toHaveCount(0);
  return frame;
}

/**
 * Dismisses Collabora's first-run welcome slideshow and onboarding tour through
 * their real UI buttons. Both are per-origin state, so every fresh browser
 * context needs this before canvas interaction.
 */
export async function dismissCollaboraWelcome(
  page: Page,
  timeout = 10_000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const welcome = page.frame({ name: 'iframe-welcome-form' });
    if (welcome) {
      const close = welcome.getByRole('button', { name: /閉じる|Close/ });
      if ((await close.count()) > 0) {
        await close.first().click({ force: true });
        return;
      }
    }
    await page.waitForTimeout(250);
  }
}

export async function dismissCollaboraOverlays(
  page: Page,
  frame: Frame
): Promise<void> {
  await dismissCollaboraWelcome(page);

  // The onboarding jsdialog appears asynchronously after the welcome iframe
  // closes, so poll for its real Skip button instead of checking once.
  const skipDeadline = Date.now() + 15_000;
  while (Date.now() < skipDeadline) {
    const skip = frame.getByRole('button', { name: /Skip|スキップ/ });
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ timeout: 15_000 });
      break;
    }
    await page.waitForTimeout(250);
  }
  await expect(
    frame.locator('#modal-dialog-onboarding-tour-overlay')
  ).toHaveCount(0, { timeout: 10_000 });
}

export async function closeCollaboraEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'エディタを閉じる' }).click();
}

/** The Save toolbutton in Collabora's notebookbar (edit mode only). */
export function collaboraSaveButton(frame: Frame) {
  return frame.locator('[id^="save"][id$="-button"]').first();
}
