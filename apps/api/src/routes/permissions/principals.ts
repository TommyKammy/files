import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import type { OidcHonoEnv } from '../../types/oidc';

type PrincipalKind = 'all' | 'member' | 'guest';

interface PrincipalUserRow {
  id: string;
  display_name: string;
  email: string;
  department: string | null;
  user_type: 'member' | 'guest';
  external_org: string | null;
  expires_at: string | null;
  last_login_at: string | null;
  invited_by: string | null;
  invitation_status: 'pending' | 'accepted' | 'revoked' | 'expired' | null;
}

const VALID_KINDS = new Set<PrincipalKind>(['all', 'member', 'guest']);

export function registerPrincipalSearchRoute(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/principals/search?q=...&kind=all|member|guest
   *
   * Member + SCIM group directory search. Guests are labelled with their
   * account metadata so the permissions modal can show the external badge,
   * organisation and expiry before granting. `requireMemberUser` is applied by
   * the route registry: an external guest must never enumerate the directory.
   */
  routes.get('/principals/search', async (c) => {
    const user = getAuthenticatedUser(c);
    const rawQuery = (c.req.query('q') ?? '').trim();
    const rawKind = (c.req.query('kind') ?? 'all').trim();
    if (!VALID_KINDS.has(rawKind as PrincipalKind)) {
      return c.json(
        { error: 'kind must be one of all, member, guest' },
        400
      );
    }
    const kind = rawKind as PrincipalKind;
    const includeMembers = kind === 'all' || kind === 'member';
    const includeGuests = kind === 'all' || kind === 'guest';
    const pattern = `%${rawQuery.replace(/[%_\\]/g, '\\$&')}%`;

    const userTypeFilter =
      kind === 'member'
        ? "AND u.user_type = 'member'"
        : kind === 'guest'
          ? "AND u.user_type = 'guest'"
          : '';

    const [usersRes, groupsRes] = await Promise.all([
      c.env.DB.prepare(
        `SELECT u.id,
                u.display_name,
                u.email,
                u.department,
                u.user_type,
                u.external_org,
                u.expires_at,
                u.last_login_at,
                u.invited_by,
                (
                  SELECT gi.status
                    FROM guest_invitations gi
                   WHERE gi.tenant_id = u.tenant_id
                     AND gi.user_id = u.id
                   ORDER BY gi.created_at DESC, gi.rowid DESC
                   LIMIT 1
                ) AS invitation_status
           FROM users u
          WHERE u.tenant_id = ?
            AND u.status = 'active'
            ${userTypeFilter}
            AND (u.display_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
          ORDER BY u.user_type ASC, u.display_name ASC
          LIMIT 15`
      )
        .bind(user.tenantId, pattern, pattern)
        .all<PrincipalUserRow>(),
      includeMembers
        ? c.env.DB.prepare(
            `SELECT id, name
               FROM groups
              WHERE tenant_id = ? AND name LIKE ? ESCAPE '\\'
              ORDER BY name ASC
              LIMIT 10`
          )
            .bind(user.tenantId, pattern)
            .all<{ id: string; name: string }>()
        : Promise.resolve({ results: [] as Array<{ id: string; name: string }> }),
    ]);

    return c.json({
      principals: [
        ...usersRes.results
          .filter(
            (u) =>
              (u.user_type === 'member' && includeMembers) ||
              (u.user_type === 'guest' && includeGuests)
          )
          .map((u) => ({
            type: 'user' as const,
            id: u.id,
            displayName: u.display_name,
            email: u.email,
            department: u.department,
            userType: u.user_type,
            externalOrg: u.external_org,
            expiresAt: u.expires_at,
            lastLoginAt: u.last_login_at,
            invitedBy: u.invited_by,
            invitationStatus: u.invitation_status,
          })),
        ...(includeMembers
          ? groupsRes.results.map((g) => ({
              type: 'group' as const,
              id: g.id,
              displayName: g.name,
              email: null,
              department: null,
              userType: 'member' as const,
              externalOrg: null,
              expiresAt: null,
              lastLoginAt: null,
              invitedBy: null,
              invitationStatus: null,
            }))
          : []),
      ],
    });
  });
}
