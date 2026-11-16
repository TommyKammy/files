import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  requireSecOrSysAdmin,
} from '../../services/authorization';
import { buildClassificationChangeStatements } from '../../services/classification-updater';
import { FileRow } from '../../services/file-upload-common';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { ClassificationLabel } from '../../types/api';
import type { AiClassificationMode } from '../../types/classification';
import type { OidcHonoEnv } from '../../types/oidc';
import { isClassificationStricter, pickStricterClassification } from '../../utils/classification';

import {
  VALID_AI_MODES,
} from './shared';
export function registerAdminPolicyRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET / PATCH /api/admin/policies — tenant governance policy settings */
  routes.get('/policies', async (c) => {
    const user = getAuthenticatedUser(c);
    const policy = await c.env.DB.prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?')
      .bind(user.tenantId)
      .first();
    return c.json({ policy });
  });

  routes.patch('/policies', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      enforceCompanyOnlyLinks?: boolean;
      requireWatermarkConfidential?: boolean;
      maxLinkExpirationDays?: number;
      sessionMaxHours?: number;
      trashRetentionDays?: number;
      aiClassificationMode?: AiClassificationMode;
      aiAutoApplyThreshold?: number | null;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required' }, 400);
    }

    const updates: string[] = [];
    const binds: unknown[] = [];

    if (body.enforceCompanyOnlyLinks !== undefined) {
      updates.push('enforce_company_only_links = ?');
      binds.push(body.enforceCompanyOnlyLinks ? 1 : 0);
    }
    if (body.requireWatermarkConfidential !== undefined) {
      updates.push('require_watermark_confidential = ?');
      binds.push(body.requireWatermarkConfidential ? 1 : 0);
    }
    if (body.maxLinkExpirationDays !== undefined) {
      if (!Number.isInteger(body.maxLinkExpirationDays) || body.maxLinkExpirationDays < 1 || body.maxLinkExpirationDays > 365) {
        return c.json({ error: 'maxLinkExpirationDays must be integer 1..365' }, 400);
      }
      updates.push('max_link_expiration_days = ?');
      binds.push(body.maxLinkExpirationDays);
    }
    if (body.sessionMaxHours !== undefined) {
      if (!Number.isInteger(body.sessionMaxHours) || body.sessionMaxHours < 1 || body.sessionMaxHours > 720) {
        return c.json({ error: 'sessionMaxHours must be integer 1..720' }, 400);
      }
      updates.push('session_max_hours = ?');
      binds.push(body.sessionMaxHours);
    }
    if (body.trashRetentionDays !== undefined) {
      if (!Number.isInteger(body.trashRetentionDays) || body.trashRetentionDays < 1 || body.trashRetentionDays > 3650) {
        return c.json({ error: 'trashRetentionDays must be integer 1..3650' }, 400);
      }
      updates.push('trash_retention_days = ?');
      binds.push(body.trashRetentionDays);
    }
    if (body.aiClassificationMode !== undefined) {
      if (!VALID_AI_MODES.has(body.aiClassificationMode)) {
        return c.json({ error: 'Invalid aiClassificationMode' }, 400);
      }
      updates.push('ai_classification_mode = ?');
      binds.push(body.aiClassificationMode);
    }
    if (body.aiAutoApplyThreshold !== undefined) {
      if (
        body.aiAutoApplyThreshold !== null &&
        (typeof body.aiAutoApplyThreshold !== 'number' ||
          body.aiAutoApplyThreshold < 0.7 ||
          body.aiAutoApplyThreshold > 1)
      ) {
        return c.json({ error: 'aiAutoApplyThreshold must be null or 0.70..1.00' }, 400);
      }
      updates.push('ai_auto_apply_threshold = ?');
      binds.push(body.aiAutoApplyThreshold);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No policy fields provided' }, 400);
    }

    const nowIso = new Date().toISOString();
    updates.push('updated_by = ?', 'updated_at = ?');
    binds.push(user.id, nowIso, user.tenantId);

    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tenant_policies SET ${updates.join(', ')} WHERE tenant_id = ?`
      ).bind(...binds),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'admin.policy_updated',
        targetType: 'tenant_policy',
        targetId: user.tenantId,
        metadata: body as Record<string, unknown>,
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'policy',
        entityId: user.tenantId,
        action: 'admin.policy_updated',
        payload: {
          updatedFields: Object.keys(body),
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'admin.policy_updated',
    });

    const updated = await c.env.DB.prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?')
      .bind(user.tenantId)
      .first();
    return c.json({ policy: updated });
  });

}
