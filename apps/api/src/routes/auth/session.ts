import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  getOidcStateCookieName,
  getSessionCookieName,
  isLocalDevBypassAllowed,
  LOCAL_DEV_OIDC_STATE_COOKIE,
  LOCAL_DEV_SESSION_COOKIE,
  OIDC_STATE_COOKIE,
  readSessionTokenFromRequest,
  SESSION_COOKIE,
  sessionAuthMiddleware,
  shouldUseSecureHostCookie,
  verifyRequestOriginForCsrf,
} from '../../middleware/session-auth';
import {
  decryptCookiePayload,
  encryptCookiePayload,
  generateRandomToken,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqual,
} from '../../services/crypto-utils';
import {
  buildConfiguredIdpProviders,
  fetchOidcDiscovery,
  OidcVerificationError,
  verifyOidcIdToken,
} from '../../services/oidc-verifier';
import { AccountLinkConflictError, syncUserWithD1 } from '../../services/user-sync';
import type { UserRole } from '../../types/api';
import type { IdpProviderConfig, OidcEnv, OidcHonoEnv } from '../../types/oidc';

import {
  clearHostOrLocalCookies,
  recordAuthAudit,
} from './shared';
export function registerSessionRoutes(routes: Hono<OidcHonoEnv>) {
  routes.post('/auth/logout', async (c) => {
    const csrfError = verifyRequestOriginForCsrf(c);
    if (csrfError) return csrfError;

    const ipAddress = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
    const token = readSessionTokenFromRequest(c);

    if (token) {
      const nowIso = new Date().toISOString();
      const revoked = await c.env.DB.prepare(
        `UPDATE sessions
            SET revoked_at = ?
          WHERE token_hash = ? AND revoked_at IS NULL
        RETURNING id, tenant_id, user_id`
      )
        .bind(nowIso, await sha256Hex(token))
        .first<{ id: string; tenant_id: string; user_id: string }>();

      if (revoked) {
        await recordAuthAudit(c.env.DB, {
          tenantId: revoked.tenant_id,
          actorId: revoked.user_id,
          actorEmail: null,
          actorIp: ipAddress,
          action: 'auth.logout',
          targetId: revoked.id,
          status: 'allowed',
          metadata: {},
        });
      }
    }

    clearHostOrLocalCookies(c, SESSION_COOKIE, LOCAL_DEV_SESSION_COOKIE);

    return c.json({ ok: true });
  });

  routes.get('/api/auth/me', sessionAuthMiddleware(), (c) => {
    return c.json({ user: c.get('user') });
  });


}
