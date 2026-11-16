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
  CONFIDENTIAL_MAX_EXPIRY_DAYS,
  DEFAULT_MAX_EXPIRY_DAYS,
  SharedLinkRow,
  TenantPolicyRow,
  VALID_SCOPES,
  formatLinkSummary,
  hasConfidentialAncestor,
  parseExpirationIso,
} from '../shared';
export function registerSharedLinkListRoute(routes: Hono<OidcHonoEnv>) {
  routes.get('/', async (c) => {
    const user = getAuthenticatedUser(c);
    const targetType = c.req.query('targetType');
    const targetId = c.req.query('targetId');

    if ((targetType !== 'file' && targetType !== 'folder') || !targetId) {
      return c.json({ error: 'targetType (file|folder) and targetId are required' }, 400);
    }

    const access = await resolveTargetAccess(c.env.DB, user, targetType, targetId);
    if (!access || access.deletedAt !== null) {
      return c.json({ error: 'Target not found' }, 404);
    }
    if (!hasAtLeastRole(access.effectiveRole, 'viewer') && user.role === 'member') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rows = await c.env.DB.prepare(
      `SELECT * FROM shared_links
       WHERE tenant_id = ? AND target_type = ? AND target_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`
    )
      .bind(user.tenantId, targetType, targetId)
      .all<SharedLinkRow>();

    return c.json({
      links: rows.results.map(formatLinkSummary),
    });
  });


}
