import { createMiddleware } from 'hono/factory';
import { sha256Hex } from '../services/crypto-utils';
import { scimError } from '../services/scim-helpers';
import type { ScimHonoEnv } from '../types/scim';

const LAST_USED_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

interface ScimTokenRow {
  id: string;
  tenant_id: string;
  idp_issuer: string;
  name: string;
  last_used_at: string | null;
}

/**
 * Resolve tenant strictly from the presented Bearer token's SHA-256 hash in `scim_tokens`.
 * X-Tenant-Id headers are never trusted for SCIM authentication.
 */
export const scimAuthMiddleware = createMiddleware<ScimHonoEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return scimError(c, 401, 'Missing or malformed SCIM Bearer token');
  }

  const rawToken = match[1].trim();
  if (!rawToken) {
    return scimError(c, 401, 'Empty SCIM Bearer token');
  }

  const tokenHash = await sha256Hex(rawToken);
  const row = await c.env.DB.prepare(
    `SELECT id, tenant_id, idp_issuer, name, last_used_at
       FROM scim_tokens
      WHERE token_hash = ? AND revoked_at IS NULL`
  )
    .bind(tokenHash)
    .first<ScimTokenRow>();

  if (!row) {
    return scimError(c, 401, 'Invalid or revoked SCIM Bearer token');
  }

  const nowMs = Date.now();
  const lastUsedMs = row.last_used_at ? Date.parse(row.last_used_at) : Number.NaN;
  const shouldTouchLastUsed =
    !row.last_used_at || Number.isNaN(lastUsedMs) || nowMs - lastUsedMs >= LAST_USED_THROTTLE_MS;

  if (shouldTouchLastUsed) {
    const updatePromise = c.env.DB.prepare(
      'UPDATE scim_tokens SET last_used_at = ? WHERE id = ?'
    )
      .bind(new Date(nowMs).toISOString(), row.id)
      .run()
      .catch(() => {
        // Non-critical telemetry timestamp update must not break provisioning
      });

    try {
      c.executionCtx.waitUntil(updatePromise);
    } catch {
      // Direct app.fetch() in tests has no ExecutionContext; run awaited fallback safely
      await updatePromise;
    }
  }

  c.set('scim', {
    scimTokenId: row.id,
    tenantId: row.tenant_id,
    idpIssuer: row.idp_issuer,
    tokenName: row.name,
  });

  await next();
});
