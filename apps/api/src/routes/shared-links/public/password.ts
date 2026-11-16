import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  sessionAuthMiddleware,
  shouldUseSecureHostCookie,
} from '../../../middleware/session-auth';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../../services/authorization';
import { generateRandomToken, sha256Hex } from '../../../services/crypto-utils';
import {
  getShareUnlockCookieName,
  getShareUnlockSecret,
  hashSharePassword,
  isActiveWebContent,
  issueShareUnlockToken,
  maskViewerIp,
  verifySharePassword,
  verifyShareUnlockToken,
} from '../../../services/shared-link-security';
import {
  issueSignedStorageUrl,
  resolveSafeDisposition,
} from '../../../services/storage-url-provider';
import { buildSyncChangeStmt } from '../../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../../services/sync-notifier';
import type {
  AuthUser,
  ClassificationLabel,
  ShareAccessScope,
} from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import {
  LOCKOUT_DURATION_MS,
  MAX_PASSWORD_FAILURES,
  PREVIEW_URL_TTL_SECONDS,
  ShareTargetFileRow,
  ShareTargetFolderRow,
  SharedLinkRow,
  getClientIp,
} from '../shared';

import {
  loadAndAuthorizeShareLink,
} from './public-shared';
export function registerPublicSharePasswordRoutes(routes: Hono<OidcHonoEnv>) {
  routes.post('/:token/verify-password', async (c) => {
    const user = c.get('user');
    const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }
    const { link, tokenHash } = auth;

    if (!link.password_hash) {
      return c.json({ ok: true, unlocked: true });
    }

    const clientIp = getClientIp(c.req, user);
    const nowIso = new Date().toISOString();

    if (link.locked_until && Date.parse(link.locked_until) > Date.now()) {
      await c.env.DB.batch([
        buildAuditLogStmt(c.env.DB, {
          tenantId: link.tenant_id,
          actorId: user?.id ?? null,
          actorEmail: user?.email ?? null,
          actorIp: clientIp,
          action: 'shared_link.password_locked',
          targetType: link.target_type,
          targetId: link.target_id,
          status: 'blocked',
          metadata: { linkId: link.id, lockedUntil: link.locked_until },
          nowIso,
        }),
      ]);
      return c.json(
        {
          error: 'Link is temporarily locked due to too many failed password attempts',
          code: 'LINK_LOCKED',
          lockedUntil: link.locked_until,
        },
        423
      );
    }

    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    if (!body || typeof body.password !== 'string') {
      return c.json({ error: 'password is required' }, 400);
    }

    const isMatch = await verifySharePassword(body.password, link.password_hash);
    if (!isMatch) {
      const candidateLockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
      const updated = await c.env.DB.prepare(
        `UPDATE shared_links
         SET failed_password_attempts = CASE
               WHEN locked_until IS NOT NULL AND julianday(locked_until) <= julianday(?) THEN 1
               ELSE failed_password_attempts + 1
             END,
             locked_until = CASE
               WHEN (
                 CASE
                   WHEN locked_until IS NOT NULL AND julianday(locked_until) <= julianday(?) THEN 1
                   ELSE failed_password_attempts + 1
                 END
               ) >= ? THEN ?
               ELSE NULL
             END
         WHERE id = ?
         RETURNING failed_password_attempts, locked_until`
      )
        .bind(nowIso, nowIso, MAX_PASSWORD_FAILURES, candidateLockedUntil, link.id)
        .first<{ failed_password_attempts: number; locked_until: string | null }>();

      const attempts = updated?.failed_password_attempts ?? MAX_PASSWORD_FAILURES;
      const lockedUntil = updated?.locked_until ?? null;

      await c.env.DB.batch([
        buildAuditLogStmt(c.env.DB, {
          tenantId: link.tenant_id,
          actorId: user?.id ?? null,
          actorEmail: user?.email ?? null,
          actorIp: clientIp,
          action: 'shared_link.password_failed',
          targetType: link.target_type,
          targetId: link.target_id,
          status: 'blocked',
          metadata: { linkId: link.id, attempts, lockedUntil },
          nowIso,
        }),
      ]);

      if (lockedUntil) {
        return c.json(
          {
            error: 'Too many failed password attempts. Link locked for 15 minutes.',
            code: 'LINK_LOCKED',
            lockedUntil,
            remainingAttempts: 0,
          },
          423
        );
      }

      return c.json(
        {
          error: 'Incorrect password',
          code: 'INVALID_PASSWORD',
          remainingAttempts: Math.max(0, MAX_PASSWORD_FAILURES - attempts),
        },
        401
      );
    }

    const unlockSecret = getShareUnlockSecret(c.env);
    const unlockToken = await issueShareUnlockToken(unlockSecret, link.id, tokenHash);

    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE shared_links SET failed_password_attempts = 0, locked_until = NULL WHERE id = ?'
      ).bind(link.id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: link.tenant_id,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        actorIp: clientIp,
        action: 'shared_link.password_verified',
        targetType: link.target_type,
        targetId: link.target_id,
        status: 'allowed',
        metadata: { linkId: link.id },
        nowIso,
      }),
    ]);

    setCookie(c, getShareUnlockCookieName(link.id), unlockToken, {
      httpOnly: true,
      secure: shouldUseSecureHostCookie(c.env, c.req.url),
      sameSite: 'Lax',
      path: '/api/s',
      maxAge: 1800,
    });

    return c.json({ ok: true, unlocked: true, unlockToken });
  });

}
