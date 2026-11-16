import { type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { resolveTargetAccess } from '../../../services/authorization';
import { can } from '../../../services/capabilities';
import { sha256Hex } from '../../../services/crypto-utils';
import {
  getShareUnlockCookieName,
  getShareUnlockSecret,
  verifyShareUnlockToken,
} from '../../../services/shared-link-security';
import type { AuthUser } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import { SharedLinkRow } from '../shared';

export async function loadAndAuthorizeShareLink(
  db: D1Database,
  rawToken: string,
  user: AuthUser | null
): Promise<
  | { ok: true; link: SharedLinkRow; tokenHash: string }
  | { ok: false; status: 401 | 403 | 404 | 410; error: string; code: string; link?: SharedLinkRow }
> {
  if (!rawToken || rawToken.length < 16) {
    return { ok: false, status: 404, error: 'Shared link not found', code: 'LINK_NOT_FOUND' };
  }
  const tokenHash = await sha256Hex(rawToken);
  const link = await db
    .prepare('SELECT * FROM shared_links WHERE token_hash = ?')
    .bind(tokenHash)
    .first<SharedLinkRow>();

  if (!link) {
    return { ok: false, status: 404, error: 'Shared link not found', code: 'LINK_NOT_FOUND' };
  }
  if (link.revoked_at !== null) {
    return { ok: false, status: 410, error: 'Shared link has been revoked', code: 'LINK_REVOKED' };
  }
  if (link.expires_at && Date.parse(link.expires_at) <= Date.now()) {
    return { ok: false, status: 410, error: 'Shared link has expired', code: 'LINK_EXPIRED' };
  }

  if (link.access_scope !== 'public') {
    if (!user) {
      return {
        ok: false,
        status: 401,
        error: 'Authentication is required to access this shared link',
        code: 'AUTH_REQUIRED',
      };
    }
    if (user.tenantId !== link.tenant_id) {
      return {
        ok: false,
        status: 403,
        error: 'Forbidden: cross-tenant access denied',
        code: 'TENANT_MISMATCH',
        link,
      };
    }
    const userRow = await db
      .prepare('SELECT status FROM users WHERE id = ? AND tenant_id = ?')
      .bind(user.id, user.tenantId)
      .first<{ status: string }>();
    if (!userRow || userRow.status !== 'active') {
      return {
        ok: false,
        status: 403,
        error: 'Forbidden: active user account required',
        code: 'USER_NOT_ACTIVE',
        link,
      };
    }

    if (link.access_scope === 'collaborators_only') {
      const targetAccess = await resolveTargetAccess(
        db,
        user,
        link.target_type,
        link.target_id
      );
      if (
        !can(targetAccess?.capabilities, 'item.preview') ||
        !can(targetAccess?.capabilities, 'folder.list')
      ) {
        return {
          ok: false,
          status: 403,
          error: 'Forbidden: collaborator permission required',
          code: 'COLLABORATOR_REQUIRED',
          link,
        };
      }
    }
  }

  return { ok: true, link, tokenHash };
}

/**
 * Shared-link edit endpoints require the same password unlock as preview /
 * download. Returns a ready-to-send error payload on failure.
 */
export async function verifyShareLinkUnlock(
  c: Context<OidcHonoEnv>,
  link: SharedLinkRow,
  tokenHash: string,
  bodyUnlockToken?: unknown
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: 401 | 423;
      body: { error: string; code: string; lockedUntil?: string | null };
    }
> {
  if (!link.password_hash) return { ok: true };
  if (link.locked_until && Date.parse(link.locked_until) > Date.now()) {
    return {
      ok: false,
      status: 423,
      body: {
        error: 'Shared link is temporarily locked',
        code: 'LINK_LOCKED',
        lockedUntil: link.locked_until,
      },
    };
  }
  const unlocked = await verifyShareUnlockToken(
    getShareUnlockSecret(c.env),
    readUnlockToken(c, link.id, bodyUnlockToken),
    link.id,
    tokenHash
  );
  if (!unlocked) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'Password verification required',
        code: 'PASSWORD_REQUIRED',
      },
    };
  }
  return { ok: true };
}

export function readUnlockToken(
  c: Context<OidcHonoEnv>,
  linkId: string,
  bodyUnlockToken?: unknown
): string | undefined {
  const headerToken = c.req.header('X-Share-Unlock');
  if (headerToken) return headerToken;
  if (typeof bodyUnlockToken === 'string' && bodyUnlockToken) return bodyUnlockToken;
  return getCookie(c, getShareUnlockCookieName(linkId));
}

