import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  AdminDelegationError,
  adminDelegationErrorBody,
  createAdminDelegation,
  deleteAdminDelegation,
  listAdminDelegations,
  updateAdminDelegation,
} from '../../services/admin-delegations';
import { getAuthenticatedUser } from '../../services/authorization';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';

const MAX_BODY_BYTES = 32_768;

function delegationErrorResponse(
  c: Context<OidcHonoEnv>,
  err: unknown
): Response {
  if (err instanceof AdminDelegationError) {
    return c.json(adminDelegationErrorBody(err), err.status);
  }
  throw err;
}

async function readJsonBody(
  c: Context<OidcHonoEnv>
): Promise<Record<string, unknown> | null> {
  const raw = await c.req.text().catch(() => '');
  if (raw.length > MAX_BODY_BYTES) {
    throw new AdminDelegationError(
      400,
      'INVALID_BODY',
      'Delegation request body is too large'
    );
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AdminDelegationError(
        400,
        'INVALID_BODY',
        'JSON object body required'
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AdminDelegationError) throw err;
    throw new AdminDelegationError(400, 'INVALID_BODY', 'JSON body required');
  }
}

function notifyDelegationChange(
  c: Context<OidcHonoEnv>,
  targetUserId: string
): Promise<void> {
  return emitTenantSyncSignal(c, {
    tenantId: getAuthenticatedUser(c).tenantId,
    eventKind: 'admin.delegation_updated',
    targetUserId,
  });
}

/**
 * P13-1 / TOM-73 delegation CRUD.
 *
 * Every endpoint is `sys_admin` only. This is deliberately stronger than the
 * governance router capability gate: even a custom delegation containing
 * `admin.users.manage` or `admin.policies.edit` can never create, promote,
 * rewrite, or remove another Co-Admin.
 */
const requireDelegationAdmin = createMiddleware<OidcHonoEnv>(
  async (c, next) => {
    const user = getAuthenticatedUser(c);
    if (user.userType !== 'guest' && user.role === 'sys_admin') {
      await next();
      return;
    }
    if (user.role === 'member') {
      return c.json(
        {
          error: 'Co-Admins cannot create, rewrite, or delete delegations',
          code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
        },
        403
      );
    }
    return c.json(
      {
        error: 'Only sys_admin can manage Co-Admin delegations',
        code: 'SYS_ADMIN_REQUIRED',
      },
      403
    );
  }
);

export function registerAdminDelegationRoutes(routes: Hono<OidcHonoEnv>) {
  routes.use('/delegations', requireDelegationAdmin);
  routes.use('/delegations/*', requireDelegationAdmin);

  /** GET /api/admin/delegations — active delegations plus preset metadata. */
  routes.get('/delegations', async (c) => {
    const user = getAuthenticatedUser(c);
    return c.json(await listAdminDelegations(c.env.DB, user.tenantId));
  });

  /** POST /api/admin/delegations — grant one member a Co-Admin delegation. */
  routes.post('/delegations', async (c) => {
    const user = getAuthenticatedUser(c);
    try {
      const body = await readJsonBody(c);
      if (!body) {
        return c.json(
          { error: 'JSON body required', code: 'INVALID_BODY' },
          400
        );
      }
      const delegation = await createAdminDelegation({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        userId: body.userId ?? body.user_id,
        preset: body.preset,
        permissions: body.permissions,
        scopeGroupId: body.scopeGroupId ?? body.scope_group_id,
        scopeRootFolderId:
          body.scopeRootFolderId ?? body.scope_root_folder_id,
        note: body.note,
      });
      await notifyDelegationChange(c, delegation.userId);
      return c.json({ delegation }, 201);
    } catch (err) {
      return delegationErrorResponse(c, err);
    }
  });

  /** PATCH /api/admin/delegations/:id — update preset, scopes, or note. */
  routes.patch('/delegations/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    try {
      const body = await readJsonBody(c);
      if (!body) {
        return c.json(
          { error: 'JSON body required', code: 'INVALID_BODY' },
          400
        );
      }
      const delegation = await updateAdminDelegation({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        delegationId: c.req.param('id'),
        preset: body.preset,
        permissions: body.permissions,
        scopeGroupId: body.scopeGroupId ?? body.scope_group_id,
        scopeRootFolderId:
          body.scopeRootFolderId ?? body.scope_root_folder_id,
        note: body.note,
      });
      await notifyDelegationChange(c, delegation.userId);
      return c.json({ delegation });
    } catch (err) {
      return delegationErrorResponse(c, err);
    }
  });

  /** DELETE /api/admin/delegations/:id — immediately revoke the grant. */
  routes.delete('/delegations/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    try {
      const { delegation } = await deleteAdminDelegation({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        delegationId: c.req.param('id'),
      });
      await notifyDelegationChange(c, delegation.userId);
      return c.json({ ok: true, delegation });
    } catch (err) {
      return delegationErrorResponse(c, err);
    }
  });
}
