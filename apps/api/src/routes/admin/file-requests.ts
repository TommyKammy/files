import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import { getAuthenticatedUser } from '../../services/authorization';
import { queueSiemEvent } from '../../services/siem-webhook';
import type { OidcHonoEnv } from '../../types/oidc';
import { parseAllowedExtensionsJson } from '../file-requests/shared';

interface AdminFileRequestRow {
  id: string;
  tenant_id: string;
  folder_id: string;
  title: string;
  description: string | null;
  require_submitter_email: number;
  max_file_size_bytes: number;
  allowed_extensions: string | null;
  submission_count: number;
  expires_at: string | null;
  is_active: number;
  created_by: string;
  created_at: string;
  folder_name: string | null;
  owner_name: string | null;
  owner_email: string | null;
}

const STATUS_FILTERS = new Set(['active', 'inactive', 'all']);

function projectAdminFileRequest(row: AdminFileRequestRow) {
  return {
    id: row.id,
    folderId: row.folder_id,
    folderName: row.folder_name,
    title: row.title,
    description: row.description,
    requireSubmitterEmail: row.require_submitter_email === 1,
    maxFileSizeBytes: row.max_file_size_bytes,
    allowedExtensions: parseAllowedExtensionsJson(row.allowed_extensions),
    submissionCount: row.submission_count,
    expiresAt: row.expires_at,
    isActive: row.is_active === 1,
    createdBy: row.created_by,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    createdAt: row.created_at,
  };
}

export function registerAdminFileRequestRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/admin/file-requests — tenant-wide blind dropbox inventory.
   * sec_admin has read-only visibility; only the emergency disable below
   * mutates state.
   */
  routes.get('/file-requests', async (c) => {
    const user = getAuthenticatedUser(c);
    const rawStatus = (c.req.query('status') ?? 'all').toLowerCase();
    const status = STATUS_FILTERS.has(rawStatus) ? rawStatus : 'all';
    const search = (c.req.query('search') ?? '').trim().slice(0, 200);

    const conditions = ['fr.tenant_id = ?'];
    const binds: unknown[] = [user.tenantId];
    if (status === 'active') conditions.push('fr.is_active = 1');
    if (status === 'inactive') conditions.push('fr.is_active = 0');
    if (search) {
      const like = `%${search.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
      conditions.push(
        `(fr.title LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR f.name LIKE ? ESCAPE '\\')`
      );
      binds.push(like, like, like, like);
    }
    binds.push(150);

    const rows = await c.env.DB.prepare(
      `SELECT fr.*, f.name AS folder_name,
              u.display_name AS owner_name, u.email AS owner_email
         FROM file_requests fr
         LEFT JOIN folders f
           ON f.tenant_id = fr.tenant_id AND f.id = fr.folder_id
         LEFT JOIN users u
           ON u.tenant_id = fr.tenant_id AND u.id = fr.created_by
        WHERE ${conditions.join(' AND ')}
        ORDER BY fr.created_at DESC, fr.id ASC
        LIMIT ?`
    )
      .bind(...binds)
      .all<AdminFileRequestRow>();

    return c.json({
      fileRequests: rows.results.map(projectAdminFileRequest),
      status,
      search,
    });
  });

  /**
   * POST /api/admin/file-requests/:id/disable — emergency tenant-wide stop.
   * Available to both sys_admin and sec_admin (the admin route group already
   * enforces that pair).
   */
  routes.post('/file-requests/:id/disable', async (c) => {
    const user = getAuthenticatedUser(c);
    const requestId = c.req.param('id');
    const existing = await c.env.DB.prepare(
      `SELECT fr.*, f.name AS folder_name,
              u.display_name AS owner_name, u.email AS owner_email
         FROM file_requests fr
         LEFT JOIN folders f
           ON f.tenant_id = fr.tenant_id AND f.id = fr.folder_id
         LEFT JOIN users u
           ON u.tenant_id = fr.tenant_id AND u.id = fr.created_by
        WHERE fr.tenant_id = ? AND fr.id = ?`
    )
      .bind(user.tenantId, requestId)
      .first<AdminFileRequestRow>();

    if (!existing) {
      return c.json(
        { error: 'File request not found', code: 'FILE_REQUEST_NOT_FOUND' },
        404
      );
    }

    const nowIso = new Date().toISOString();
    const alreadyDisabled = existing.is_active !== 1;
    if (!alreadyDisabled) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE file_requests
              SET is_active = 0
            WHERE tenant_id = ? AND id = ?`
        ).bind(user.tenantId, requestId),
        buildAuditLogStmt(c.env.DB, {
          tenantId: user.tenantId,
          actorId: user.id,
          actorEmail: user.email,
          actorIp: user.ipAddress,
          action: 'admin.file_request.disabled',
          targetType: 'folder',
          targetId: existing.folder_id,
          metadata: {
            fileRequestId: requestId,
            submissionCount: existing.submission_count,
            ownerId: existing.created_by,
            title: existing.title,
          },
          nowIso,
        }),
      ]);
    }

    queueSiemEvent(c, c.env, c.env.DB, user.tenantId, {
      event: 'admin.file_request.disabled',
      category: 'admin_mutation',
      data: {
        fileRequestId: requestId,
        actorId: user.id,
        submissionCount: existing.submission_count,
      },
    });

    return c.json({
      ok: true,
      fileRequest: projectAdminFileRequest({
        ...existing,
        is_active: 0,
      }),
      alreadyDisabled,
    });
  });
}
