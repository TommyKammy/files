import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import { getAuthenticatedUser } from '../../services/authorization';
import { queueSiemEvent } from '../../services/siem-webhook';
import {
  DEFAULT_TOS_BODY,
  DEFAULT_TOS_TITLE,
  isTosTargetAudience,
  type TenantTosPolicyRow,
} from '../../services/tos';
import type { OidcHonoEnv } from '../../types/oidc';

const TOS_TITLE_MAX_LENGTH = 160;
const TOS_BODY_MAX_LENGTH = 100_000;

interface TosPolicyProjection {
  enabled: boolean;
  version: number;
  targetAudience: TenantTosPolicyRow['target_audience'];
  title: string;
  bodyMarkdown: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

function projectTosPolicy(row: TenantTosPolicyRow | null): TosPolicyProjection {
  return {
    enabled: row?.enabled === 1,
    version: row?.version ?? 1,
    targetAudience: isTosTargetAudience(row?.target_audience)
      ? row.target_audience
      : 'all_users',
    title: row?.title ?? DEFAULT_TOS_TITLE,
    bodyMarkdown: row?.body_markdown ?? DEFAULT_TOS_BODY,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function loadAdminTosPayload(
  db: D1Database,
  tenantId: string
): Promise<{ tos: TosPolicyProjection }> {
  const row = await db
    .prepare('SELECT * FROM tenant_tos_policies WHERE tenant_id = ?')
    .bind(tenantId)
    .first<TenantTosPolicyRow>();
  return { tos: projectTosPolicy(row) };
}

export function registerAdminTosRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/tos — sys_admin and sec_admin can review the policy. */
  routes.get('/tos', async (c) => {
    const user = getAuthenticatedUser(c);
    return c.json(await loadAdminTosPayload(c.env.DB, user.tenantId));
  });

  /** PUT /api/admin/tos — sys_admin only; content changes bump the version. */
  routes.put('/tos', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can update the tenant terms of service',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }

    const body = (await c.req.json().catch(() => null)) as {
      enabled?: unknown;
      targetAudience?: unknown;
      title?: unknown;
      bodyMarkdown?: unknown;
      bumpVersion?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required', code: 'INVALID_TOS_POLICY' }, 400);
    }

    const existing = await c.env.DB.prepare(
      'SELECT * FROM tenant_tos_policies WHERE tenant_id = ?'
    )
      .bind(user.tenantId)
      .first<TenantTosPolicyRow>();

    let enabled = existing?.enabled === 1;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json(
          { error: 'enabled must be a boolean', code: 'INVALID_TOS_POLICY' },
          400
        );
      }
      enabled = body.enabled;
    }

    let targetAudience = isTosTargetAudience(existing?.target_audience)
      ? existing!.target_audience
      : 'all_users';
    if (body.targetAudience !== undefined) {
      if (!isTosTargetAudience(body.targetAudience)) {
        return c.json(
          {
            error:
              "targetAudience must be 'all_users', 'guests_only' or 'members_only'",
            code: 'INVALID_TOS_AUDIENCE',
          },
          400
        );
      }
      targetAudience = body.targetAudience;
    }

    let title = existing?.title ?? DEFAULT_TOS_TITLE;
    const titleProvided = body.title !== undefined;
    if (titleProvided) {
      if (
        typeof body.title !== 'string' ||
        !body.title.trim() ||
        body.title.trim().length > TOS_TITLE_MAX_LENGTH
      ) {
        return c.json(
          {
            error: `title must be a non-empty string (<= ${TOS_TITLE_MAX_LENGTH} chars)`,
            code: 'INVALID_TOS_POLICY',
          },
          400
        );
      }
      title = body.title.trim();
    }

    let bodyMarkdown = existing?.body_markdown ?? DEFAULT_TOS_BODY;
    const bodyProvided = body.bodyMarkdown !== undefined;
    if (bodyProvided) {
      if (
        typeof body.bodyMarkdown !== 'string' ||
        body.bodyMarkdown.length > TOS_BODY_MAX_LENGTH
      ) {
        return c.json(
          {
            error: `bodyMarkdown must be a string (<= ${TOS_BODY_MAX_LENGTH} chars)`,
            code: 'INVALID_TOS_POLICY',
          },
          400
        );
      }
      bodyMarkdown = body.bodyMarkdown;
    }

    if (body.bumpVersion !== undefined && typeof body.bumpVersion !== 'boolean') {
      return c.json(
        { error: 'bumpVersion must be a boolean', code: 'INVALID_TOS_POLICY' },
        400
      );
    }

    const contentChanged =
      (titleProvided && title !== (existing?.title ?? DEFAULT_TOS_TITLE)) ||
      (bodyProvided && bodyMarkdown !== (existing?.body_markdown ?? DEFAULT_TOS_BODY));
    const bumpVersion =
      body.bumpVersion === true ||
      (enabled && existing?.enabled === 1 && contentChanged);
    const nextVersion = Math.max(1, (existing?.version ?? 1) + (bumpVersion ? 1 : 0));
    const nowIso = new Date().toISOString();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO tenant_tos_policies (
           tenant_id, enabled, version, target_audience, title, body_markdown,
           updated_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           enabled = excluded.enabled,
           version = excluded.version,
           target_audience = excluded.target_audience,
           title = excluded.title,
           body_markdown = excluded.body_markdown,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      ).bind(
        user.tenantId,
        enabled ? 1 : 0,
        nextVersion,
        targetAudience,
        title,
        bodyMarkdown,
        user.id,
        nowIso
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'admin.tos.updated',
        targetType: 'tenant_tos_policy',
        targetId: user.tenantId,
        metadata: {
          enabled,
          targetAudience,
          version: nextVersion,
          bumpVersion,
          contentChanged,
        },
        nowIso,
      }),
    ]);

    queueSiemEvent(c, c.env, c.env.DB, user.tenantId, {
      event: 'admin.tos.updated',
      category: 'admin_mutation',
      data: {
        actorId: user.id,
        enabled,
        targetAudience,
        version: nextVersion,
      },
    });

    const updated = await c.env.DB.prepare(
      'SELECT * FROM tenant_tos_policies WHERE tenant_id = ?'
    )
      .bind(user.tenantId)
      .first<TenantTosPolicyRow>();
    return c.json({ tos: projectTosPolicy(updated) });
  });
}
