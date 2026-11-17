import { Hono, type Context } from 'hono';
import {
  AdminGroupError,
  addAdminGroupMembers,
  createAdminGroup,
  deleteAdminGroup,
  isAdminGroupSourceFilter,
  listAdminGroups,
  loadAdminGroupDetail,
  removeAdminGroupMember,
  renameAdminGroup,
  type AdminGroupFilters,
  type AdminGroupMutationResult,
} from '../../services/admin-groups';
import {
  AdminDelegationError,
  assertAdminGroupInScope,
  getAdminScope,
  hasAdminCapability,
} from '../../services/admin-delegations';
import { getAuthenticatedUser } from '../../services/authorization';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';

const MAX_QUERY_LENGTH = 320;

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function parseOffset(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function adminGroupErrorResponse(
  c: Context<OidcHonoEnv>,
  err: unknown
): Response {
  if (err instanceof AdminGroupError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof AdminDelegationError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

async function readJsonBody(
  c: Context<OidcHonoEnv>
): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    throw new AdminGroupError(400, 'INVALID_BODY', 'JSON body required');
  }
  return body;
}

async function notifyGroupMutation(
  c: Context<OidcHonoEnv>,
  input: {
    tenantId: string;
    action: string;
    groupId: string;
    result: AdminGroupMutationResult;
  }
): Promise<void> {
  if (input.result.syncSeq === null) return;
  await emitTenantSyncSignal(c, {
    tenantId: input.tenantId,
    seq: input.result.syncSeq,
    eventKind: input.action,
    metadata: { groupId: input.groupId },
  });
}

function requireGroupManager(c: Context<OidcHonoEnv>): Response | null {
  const user = getAuthenticatedUser(c);
  if (user.role === 'sys_admin') return null;
  // TOM-73: only a delegated member with `admin.groups.manage` may mutate
  // groups. sec_admin keeps its legacy read-only group visibility.
  if (
    user.role === 'member' &&
    user.userType !== 'guest' &&
    hasAdminCapability(user, 'admin.groups.manage')
  ) {
    return null;
  }
  return c.json(
    {
      error: 'Only sys_admin or a delegated group manager can manage groups',
      code: 'SYS_ADMIN_REQUIRED',
    },
    403
  );
}


export function registerAdminGroupRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/groups — tenant group list with member/ACL counts. */
  routes.get('/groups', async (c) => {
    const user = getAuthenticatedUser(c);

    const sourceRaw = c.req.query('source')?.trim() || 'all';
    if (!isAdminGroupSourceFilter(sourceRaw)) {
      return c.json(
        {
          error: 'source must be all, scim, or manual',
          code: 'INVALID_GROUP_SOURCE_FILTER',
        },
        400
      );
    }

    const queryRaw = c.req.query('query')?.trim() || null;
    if (queryRaw && queryRaw.length > MAX_QUERY_LENGTH) {
      return c.json(
        {
          error: `Group filters must be at most ${MAX_QUERY_LENGTH} characters`,
          code: 'INVALID_GROUP_FILTER',
        },
        400
      );
    }

    const filters: AdminGroupFilters = {
      query: queryRaw,
      source: sourceRaw,
      limit: parseLimit(c.req.query('limit'), 200, 500),
      offset: parseOffset(c.req.query('offset')),
      scopeGroupId: getAdminScope(user)?.groupId ?? null,
    };
    return c.json(await listAdminGroups(c.env.DB, user.tenantId, filters));
  });

  /** GET /api/admin/groups/:id — members and direct group ACLs. */
  routes.get('/groups/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const detail = await loadAdminGroupDetail(
      c.env.DB,
      user.tenantId,
      c.req.param('id')
    );
    if (!detail) {
      return c.json(
        { error: 'Group not found', code: 'GROUP_NOT_FOUND' },
        404
      );
    }
    try {
      await assertAdminGroupInScope(
        getAdminScope(user)?.groupId ?? null,
        c.req.param('id')
      );
    } catch (err) {
      return adminGroupErrorResponse(c, err);
    }
    return c.json(detail);
  });

  /** POST /api/admin/groups — manual group creation (sys_admin). */
  routes.post('/groups', async (c) => {
    const forbidden = requireGroupManager(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    try {
      if (getAdminScope(user)?.groupId) {
        return c.json(
          {
            error: 'A group-scoped Co-Admin cannot create new groups',
            code: 'OUT_OF_DELEGATION_SCOPE',
          },
          403
        );
      }
      const body = await readJsonBody(c);
      const result = await createAdminGroup({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        name: body.name,
      });
      await notifyGroupMutation(c, {
        tenantId: user.tenantId,
        action: 'admin.group.create',
        groupId: result.groupId,
        result,
      });
      return c.json(result, 201);
    } catch (err) {
      return adminGroupErrorResponse(c, err);
    }
  });

  /** PATCH /api/admin/groups/:id — manual group rename (sys_admin). */
  routes.patch('/groups/:id', async (c) => {
    const forbidden = requireGroupManager(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    try {
      await assertAdminGroupInScope(
        getAdminScope(user)?.groupId ?? null,
        c.req.param('id')
      );
      const body = await readJsonBody(c);
      const result = await renameAdminGroup({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        groupId: c.req.param('id'),
        name: body.name,
      });
      await notifyGroupMutation(c, {
        tenantId: user.tenantId,
        action: 'admin.group.update',
        groupId: result.groupId,
        result,
      });
      return c.json(result);
    } catch (err) {
      return adminGroupErrorResponse(c, err);
    }
  });

  /** DELETE /api/admin/groups/:id — manual group delete (sys_admin). */
  routes.delete('/groups/:id', async (c) => {
    const forbidden = requireGroupManager(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    try {
      await assertAdminGroupInScope(
        getAdminScope(user)?.groupId ?? null,
        c.req.param('id')
      );
      const result = await deleteAdminGroup({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        groupId: c.req.param('id'),
      });
      await notifyGroupMutation(c, {
        tenantId: user.tenantId,
        action: 'admin.group.delete',
        groupId: result.groupId,
        result,
      });
      return c.json(result);
    } catch (err) {
      return adminGroupErrorResponse(c, err);
    }
  });

  /** POST /api/admin/groups/:id/members — add one or more members. */
  routes.post('/groups/:id/members', async (c) => {
    const forbidden = requireGroupManager(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    try {
      await assertAdminGroupInScope(
        getAdminScope(user)?.groupId ?? null,
        c.req.param('id')
      );
      const body = await readJsonBody(c);
      const result = await addAdminGroupMembers({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        groupId: c.req.param('id'),
        userId: body.userId,
        userIds: body.userIds,
      });
      await notifyGroupMutation(c, {
        tenantId: user.tenantId,
        action: 'admin.group.member_add',
        groupId: result.groupId,
        result,
      });
      return c.json(result);
    } catch (err) {
      return adminGroupErrorResponse(c, err);
    }
  });

  /** DELETE /api/admin/groups/:id/members/:userId — remove a member. */
  routes.delete('/groups/:id/members/:userId', async (c) => {
    const forbidden = requireGroupManager(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    try {
      await assertAdminGroupInScope(
        getAdminScope(user)?.groupId ?? null,
        c.req.param('id')
      );
      const result = await removeAdminGroupMember({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        groupId: c.req.param('id'),
        userId: c.req.param('userId'),
      });
      await notifyGroupMutation(c, {
        tenantId: user.tenantId,
        action: 'admin.group.member_remove',
        groupId: result.groupId,
        result,
      });
      return c.json(result);
    } catch (err) {
      return adminGroupErrorResponse(c, err);
    }
  });
}
