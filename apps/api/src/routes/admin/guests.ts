import { Hono, type Context } from 'hono';
import {
  AdminBulkIdempotencyError,
  AdminGuestError,
  buildAdminGuestCsv,
  buildAdminGuestPermissionCsv,
  isAdminGuestSortBy,
  isAdminGuestStatusFilter,
  listAdminGuests,
  loadAdminGuestDetail,
  offboardAdminGuest,
  resendAdminGuestInvite,
  resolveIdempotencyKey,
  resumeAdminGuest,
  suspendAdminGuest,
  type AdminGuestFilters,
} from '../../services/admin-guests';
import { getAuthenticatedUser } from '../../services/authorization';
import { getGuestPolicy } from '../../services/external-guests';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';
import { getCallbackBaseOrigin } from '../auth/shared';

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

function guestErrorResponse(
  c: Context<OidcHonoEnv>,
  err: unknown
): Response {
  if (err instanceof AdminGuestError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof AdminBulkIdempotencyError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

function hasReplayed(response: Record<string, unknown>): boolean {
  return response.replayed === true;
}

export function registerAdminGuestRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/guests — lifecycle list, domain/inviter/status summary. */
  routes.get('/guests', async (c) => {
    const user = getAuthenticatedUser(c);

    const statusRaw = c.req.query('status')?.trim() || 'all';
    if (!isAdminGuestStatusFilter(statusRaw)) {
      return c.json(
        {
          error:
            'status must be all, active, suspended, expired, pending_invite, or offboarded',
          code: 'INVALID_GUEST_STATUS_FILTER',
        },
        400
      );
    }

    const sortByRaw = c.req.query('sortBy')?.trim() || 'createdAt';
    if (!isAdminGuestSortBy(sortByRaw)) {
      return c.json(
        {
          error:
            'sortBy must be createdAt, lastLoginAt, expiresAt, email, or externalOrg',
          code: 'INVALID_GUEST_SORT',
        },
        400
      );
    }
    const sortDirRaw = c.req.query('sortDir')?.trim() || 'desc';
    if (sortDirRaw !== 'asc' && sortDirRaw !== 'desc') {
      return c.json(
        { error: 'sortDir must be asc or desc', code: 'INVALID_GUEST_SORT_DIRECTION' },
        400
      );
    }

    const formatRaw = c.req.query('format')?.trim() || 'json';
    if (formatRaw !== 'json' && formatRaw !== 'csv') {
      return c.json(
        { error: 'format must be json or csv', code: 'INVALID_FORMAT' },
        400
      );
    }

    const expiresBeforeRaw = c.req.query('expiresBefore')?.trim() || null;
    if (expiresBeforeRaw && Number.isNaN(Date.parse(expiresBeforeRaw))) {
      return c.json(
        {
          error: 'expiresBefore must be a valid ISO 8601 timestamp',
          code: 'INVALID_GUEST_EXPIRY_FILTER',
        },
        400
      );
    }

    const queryRaw = c.req.query('query')?.trim() || null;
    const domainRaw = c.req.query('domain')?.trim().toLowerCase() || null;
    const invitedByRaw = c.req.query('invitedBy')?.trim() || null;
    for (const value of [queryRaw, domainRaw, invitedByRaw]) {
      if (value && value.length > MAX_QUERY_LENGTH) {
        return c.json(
          {
            error: `Guest filters must be at most ${MAX_QUERY_LENGTH} characters`,
            code: 'INVALID_GUEST_FILTER',
          },
          400
        );
      }
    }

    const filters: AdminGuestFilters = {
      query: queryRaw,
      status: statusRaw,
      domain: domainRaw,
      invitedBy: invitedByRaw,
      expiresBefore: expiresBeforeRaw,
      sortBy: sortByRaw,
      sortDir: sortDirRaw,
      limit: parseLimit(c.req.query('limit'), 50, 200),
      offset: parseOffset(c.req.query('offset')),
    };

    const result = await listAdminGuests(c.env.DB, user.tenantId, filters);

    if (formatRaw === 'csv') {
      return c.body(buildAdminGuestCsv(result.guests), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="admin-guests.csv"',
      });
    }
    return c.json(result);
  });

  /** GET /api/admin/guests/:id — full guest lifecycle detail + export. */
  routes.get('/guests/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const guestId = c.req.param('id');
    const detail = await loadAdminGuestDetail(c.env.DB, user.tenantId, guestId);
    if (!detail) {
      return c.json(
        { error: 'Guest account not found', code: 'GUEST_NOT_FOUND' },
        404
      );
    }

    const format = c.req.query('format')?.trim();
    const exportMode = c.req.query('export')?.trim();
    const download = c.req.query('download');
    if (format && format !== 'csv' && format !== 'json') {
      return c.json(
        { error: 'format must be csv or json', code: 'INVALID_FORMAT' },
        400
      );
    }

    const wantsCsv =
      format === 'csv' ||
      (exportMode === 'permissions' && format !== 'json');
    if (wantsCsv) {
      return c.body(buildAdminGuestPermissionCsv(detail), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="admin-guest-${guestId}-permissions.csv"`,
      });
    }

    const policy = await getGuestPolicy(c.env.DB, user.tenantId);
    const payload = {
      guest: detail.guest,
      invitations: detail.invitations,
      permissions: detail.permissions,
      effectivePermissions: detail.effectivePermissions,
      sharedItems: detail.sharedItems,
      recentAuditLogs: detail.recentAuditLogs,
      accessSummary: detail.accessSummary,
      pendingInvitationId: detail.pendingInvitationId,
      guestPolicy: {
        ...detail.guestPolicy,
        externalDomainExistingGuestMode:
          policy.externalDomainExistingGuestMode,
      },
      dlp: {
        confidentialMetadataOnly: true,
        notice:
          '機密 (confidential) アイテムはメタデータのみ表示します。R2 キー・署名 URL・ファイル本文・AI 理由文は返しません。',
      },
    };

    if (format === 'json' || download === '1' || download === 'true') {
      return c.body(JSON.stringify(payload), 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="admin-guest-${guestId}.json"`,
      });
    }
    return c.json(payload);
  });

  /** POST /api/admin/guests/:id/suspend — sys_admin & sec_admin. */
  routes.post('/guests/:id/suspend', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin' && user.role !== 'sec_admin') {
      return c.json(
        { error: 'sys_admin or sec_admin role required', code: 'ADMIN_REQUIRED' },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    try {
      const result = await suspendAdminGuest({
        db: c.env.DB,
        tenantId: user.tenantId,
        guestId: c.req.param('id'),
        actor: user,
        idempotencyKey: resolveIdempotencyKey(
          body?.idempotencyKey,
          c.req.header('Idempotency-Key')
        ),
      });
      if (!hasReplayed(result)) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: typeof result.syncSeq === 'number' ? result.syncSeq : null,
          eventKind: 'admin.guest.suspend',
          targetUserId: c.req.param('id'),
          revoked: true,
        });
      }
      return c.json(result);
    } catch (err) {
      return guestErrorResponse(c, err);
    }
  });

  /** POST /api/admin/guests/:id/resume — sys_admin only. */
  routes.post('/guests/:id/resume', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can resume a guest account',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    try {
      const result = await resumeAdminGuest({
        db: c.env.DB,
        tenantId: user.tenantId,
        guestId: c.req.param('id'),
        actor: user,
        expiresAt: body?.expiresAt,
        extendDays: body?.extendDays,
        idempotencyKey: resolveIdempotencyKey(
          body?.idempotencyKey,
          c.req.header('Idempotency-Key')
        ),
      });
      if (!hasReplayed(result)) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: typeof result.syncSeq === 'number' ? result.syncSeq : null,
          eventKind: 'admin.guest.resume',
          targetUserId: c.req.param('id'),
        });
      }
      return c.json(result);
    } catch (err) {
      return guestErrorResponse(c, err);
    }
  });

  /** POST /api/admin/guests/:id/resend-invite — sys_admin only. */
  routes.post('/guests/:id/resend-invite', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can resend a guest invitation',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    try {
      const result = await resendAdminGuestInvite({
        db: c.env.DB,
        tenantId: user.tenantId,
        guestId: c.req.param('id'),
        actor: user,
        invitationId:
          typeof body?.invitationId === 'string' ? body.invitationId : null,
        acceptOrigin: getCallbackBaseOrigin(c.env, c.req.url),
        mailEnv: c.env,
        idempotencyKey: resolveIdempotencyKey(
          body?.idempotencyKey,
          c.req.header('Idempotency-Key')
        ),
      });
      if (!hasReplayed(result)) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: typeof result.syncSeq === 'number' ? result.syncSeq : null,
          eventKind: 'admin.guest.resend_invite',
          targetUserId: c.req.param('id'),
        });
      }
      return c.json(result);
    } catch (err) {
      return guestErrorResponse(c, err);
    }
  });

  /** DELETE /api/admin/guests/:id — atomic offboarding (sys_admin only). */
  routes.delete('/guests/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can offboard a guest account',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    try {
      const result = await offboardAdminGuest({
        db: c.env.DB,
        tenantId: user.tenantId,
        guestId: c.req.param('id'),
        actor: user,
        idempotencyKey: resolveIdempotencyKey(
          body?.idempotencyKey,
          c.req.header('Idempotency-Key')
        ),
      });
      if (!hasReplayed(result)) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: typeof result.syncSeq === 'number' ? result.syncSeq : null,
          eventKind: 'admin.guest.offboard',
          targetUserId: c.req.param('id'),
          revoked: true,
        });
      }
      return c.json(result);
    } catch (err) {
      return guestErrorResponse(c, err);
    }
  });
}
