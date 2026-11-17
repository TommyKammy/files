import { Hono } from 'hono';
import {
  AdminDelegationError,
  assertAdminContentTargetInScope,
  getAdminScope,
} from '../../services/admin-delegations';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  AdminContentError,
  forceUnlockAdminContentFile,
  getAdminContentDetail,
  inspectAdminContentFile,
  parseAdminContentSearchFilters,
  searchAdminContent,
  validateAdminContentReason,
} from '../../services/admin-content';
import type { OidcHonoEnv } from '../../types/oidc';

function handleAdminContentError(
  c: {
    json: (
      body: unknown,
      status: 400 | 403 | 404 | 409 | 503
    ) => Response;
  },
  err: unknown
): Response {
  if (err instanceof AdminContentError) {
    return c.json(
      { error: err.message, code: err.code },
      err.status
    );
  }
  if (err instanceof AdminDelegationError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

export function registerAdminContentRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/content/search — tenant-wide ACL-independent search. */
  routes.get('/content/search', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const filters = parseAdminContentSearchFilters((name) =>
        c.req.query(name)
      );
      const scopeRootFolderId = getAdminScope(user)?.rootFolderId ?? null;
      if (scopeRootFolderId) {
        if (
          filters.rootFolderId &&
          filters.rootFolderId !== scopeRootFolderId
        ) {
          throw new AdminDelegationError(
            403,
            'OUT_OF_DELEGATION_SCOPE',
            'rootFolderId is outside the delegated root-folder scope'
          );
        }
        // Force the scope even when the caller omitted (or guessed) a root.
        filters.rootFolderId = scopeRootFolderId;
      }
      const result = await searchAdminContent(
        c.env,
        user.tenantId,
        filters
      );
      return c.json({
        ...result,
        filters: {
          targetType: filters.targetType,
          query: filters.query,
          createdBy: filters.createdBy,
          rootFolderId: filters.rootFolderId,
          classification: filters.classification,
          extension: filters.extension,
          lockedOnly: filters.lockedOnly,
          hasSharedLink: filters.hasSharedLink,
        },
      });
    } catch (err) {
      return handleAdminContentError(c, err);
    }
  });

  /** GET /api/admin/content/:targetType/:targetId — full inspection detail. */
  routes.get('/content/:targetType/:targetId', async (c) => {
    const targetType = c.req.param('targetType');
    if (targetType !== 'file' && targetType !== 'folder') {
      return c.json(
        {
          error: "targetType must be 'file' or 'folder'",
          code: 'INVALID_TARGET_TYPE',
        },
        400
      );
    }
    try {
      const user = getAuthenticatedUser(c);
      await assertAdminContentTargetInScope(
        c.env.DB,
        user.tenantId,
        getAdminScope(user)?.rootFolderId ?? null,
        targetType,
        c.req.param('targetId')
      );
      const detail = await getAdminContentDetail(
        c.env,
        user.tenantId,
        targetType,
        c.req.param('targetId')
      );
      if (!detail) {
        return c.json(
          { error: 'Content not found', code: 'CONTENT_NOT_FOUND' },
          404
        );
      }
      return c.json(detail);
    } catch (err) {
      return handleAdminContentError(c, err);
    }
  });

  /** POST /api/admin/content/files/:id/force-unlock — admin lock override. */
  routes.post('/content/files/:id/force-unlock', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const body = (await c.req.json().catch(() => null)) as {
        reason?: unknown;
      } | null;
      const reason = validateAdminContentReason(body?.reason);
      await assertAdminContentTargetInScope(
        c.env.DB,
        user.tenantId,
        getAdminScope(user)?.rootFolderId ?? null,
        'file',
        c.req.param('id')
      );
      const result = await forceUnlockAdminContentFile(
        c.env,
        user,
        c.req.param('id'),
        reason
      );
      return c.json(result);
    } catch (err) {
      return handleAdminContentError(c, err);
    }
  });

  /** POST /api/admin/content/files/:id/inspect-preview — audited preview. */
  routes.post('/content/files/:id/inspect-preview', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const body = (await c.req.json().catch(() => null)) as {
        reason?: unknown;
      } | null;
      const reason = validateAdminContentReason(body?.reason);
      await assertAdminContentTargetInScope(
        c.env.DB,
        user.tenantId,
        getAdminScope(user)?.rootFolderId ?? null,
        'file',
        c.req.param('id')
      );
      const result = await inspectAdminContentFile(
        c.env,
        user,
        c.req.param('id'),
        reason
      );
      return c.json(result);
    } catch (err) {
      return handleAdminContentError(c, err);
    }
  });
}
