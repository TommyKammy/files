import { Hono } from 'hono';
import { resolveTargetAccess } from '../../../services/authorization';
import { can } from '../../../services/capabilities';
import type { FileRow } from '../../../services/file-upload-common';
import { getFileLockState } from '../../../services/file-lock';
import {
  getShareLinkPolicyFlags,
  resolveEffectiveShareCapabilities,
  resolvePermissionLevel,
} from '../../../services/shared-link-permissions';
import { isFileConfidential } from '../../../services/shared-link-upload';
import { getActiveWopiDraft } from '../../../services/wopi-drafts';
import {
  buildWopiSrc,
  getWopiDiscovery,
  resolveWopiActionUrl,
} from '../../../services/wopi-discovery';
import { issueWopiSessionToken } from '../../../services/wopi-token';
import type { OidcHonoEnv } from '../../../types/oidc';
import { loadAndAuthorizeShareLink, verifyShareLinkUnlock } from './public-shared';

export function registerPublicShareWopiRoutes(routes: Hono<OidcHonoEnv>) {
  /** POST /api/s/:token/wopi-session — read/write Collabora session via a share link. */
  routes.post('/:token/wopi-session', async (c) => {
    const user = c.get('user');
    const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }
    const { link, tokenHash } = auth;

    const body = (await c.req.json().catch(() => null)) as {
      fileId?: unknown;
      unlockToken?: unknown;
    } | null;

    const unlocked = await verifyShareLinkUnlock(
      c,
      link,
      tokenHash,
      body?.unlockToken
    );
    if (!unlocked.ok) {
      return c.json(unlocked.body, unlocked.status);
    }

    let file: FileRow | null = null;
    if (link.target_type === 'file') {
      file = await c.env.DB.prepare(
        'SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
      )
        .bind(link.tenant_id, link.target_id)
        .first<FileRow>();
    } else {
      if (typeof body?.fileId !== 'string' || !body.fileId.trim()) {
        return c.json({ error: 'fileId is required for folder shared links' }, 400);
      }
      file = await c.env.DB.prepare(
        `SELECT f.*
           FROM files f
           JOIN folder_closures fc
             ON fc.tenant_id = f.tenant_id AND fc.descendant_id = f.folder_id
          WHERE f.tenant_id = ? AND f.id = ?
            AND fc.ancestor_id = ?
            AND f.deleted_at IS NULL AND f.upload_state = 'active'
          LIMIT 1`
      )
        .bind(link.tenant_id, body.fileId.trim(), link.target_id)
        .first<FileRow>();
    }

    if (!file || file.upload_state !== 'active') {
      return c.json({ error: 'Shared file not found or unavailable' }, 404);
    }

    const [policy, collaboratorAccess, confidential, creator, lock] =
      await Promise.all([
        getShareLinkPolicyFlags(c.env.DB, link.tenant_id),
        user
          ? resolveTargetAccess(
              c.env.DB,
              { id: user.id, tenantId: user.tenantId },
              'file',
              file.id
            )
          : null,
        isFileConfidential(c.env.DB, link.tenant_id, file.classification, file.folder_id),
        c.env.DB.prepare(
          "SELECT id, email, display_name, status FROM users WHERE tenant_id = ? AND id = ?"
        )
          .bind(link.tenant_id, link.created_by)
          .first<{
            id: string;
            email: string;
            display_name: string;
            status: string;
          }>(),
        getFileLockState(c.env, file.id),
      ]);

    if (!creator || creator.status !== 'active') {
      return c.json(
        { error: 'Shared link owner is not active', code: 'USER_NOT_ACTIVE' },
        403
      );
    }

    const effective = resolveEffectiveShareCapabilities({
      link,
      collaboratorCapabilities: collaboratorAccess?.capabilities ?? null,
      user,
      policy,
      isConfidential: confidential,
    });
    const desktopLocked = lock?.mode === 'desktop_exclusive';
    const linkAllowsEdit = resolvePermissionLevel(link) === 'edit';
    const canWrite =
      linkAllowsEdit &&
      effective.canEdit &&
      can(effective.composedCapabilities, 'item.edit_content') &&
      !desktopLocked &&
      !confidential;

    const [currentVersion, activeDraft] = await Promise.all([
      file.current_version_id
        ? c.env.DB.prepare(
            `SELECT id, r2_object_key FROM file_versions
              WHERE tenant_id = ? AND id = ? LIMIT 1`
          )
            .bind(link.tenant_id, file.current_version_id)
            .first<{ id: string; r2_object_key: string }>()
        : null,
      getActiveWopiDraft(c.env.DB, link.tenant_id, file.id),
    ]);
    if (!activeDraft) {
      if (!currentVersion) {
        return c.json(
          {
            error: 'このファイルには表示・編集できる実体がありません',
            code: 'WOPI_CONTENT_NOT_FOUND',
          },
          409
        );
      }
      const object = await c.env.BUCKET.head(currentVersion.r2_object_key);
      if (!object) {
        return c.json(
          {
            error: 'このファイルの実体がストレージに見つかりません',
            code: 'WOPI_CONTENT_NOT_FOUND',
          },
          409
        );
      }
    }

    const sessionId = crypto.randomUUID();
    const wopiSrc = buildWopiSrc(c.env, file.id);
    const discovery = await getWopiDiscovery(c.env).catch((err) => {
      console.warn('[wopi] Discovery resolution failed:', err);
      return null;
    });
    const wopiActionUrl = discovery
      ? resolveWopiActionUrl(discovery, {
          extension: file.extension ?? file.name.split('.').pop(),
          canWrite,
          wopiSrc,
        })
      : null;

    // The Collabora host re-resolves RBAC for the token subject. Attribute the
    // session to the link creator so a viewer collaborator can edit strictly
    // through this edit link, while can_write remains link-scoped.
    const issued = await issueWopiSessionToken(c.env, {
      sessionId,
      fileId: file.id,
      tenantId: link.tenant_id,
      userId: creator.id,
      role: effective.composedRole ?? 'viewer',
      canWrite,
    });

    await c.env.DB.prepare(
      `INSERT INTO wopi_sessions (
         id, tenant_id, file_id, user_id, role, can_write,
         access_token_hash, is_active, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
      .bind(
        sessionId,
        link.tenant_id,
        file.id,
        creator.id,
        effective.composedRole ?? 'viewer',
        canWrite ? 1 : 0,
        issued.tokenHash,
        issued.expiresAt
      )
      .run();

    const readOnlyReason = canWrite
      ? null
      : desktopLocked
        ? 'desktop_lock'
        : confidential
          ? 'dlp'
          : 'permission';

    return c.json(
      {
        sessionId,
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mime_type,
        classification: file.classification,
        role: effective.composedRole ?? 'viewer',
        capabilities: effective.composedCapabilities,
        permissionLevel: effective.permissionLevel,
        canEdit: effective.canEdit,
        canWrite,
        readOnly: !canWrite,
        readOnlyReason,
        lockMode: 'wopi_collab',
        accessToken: issued.token,
        accessTokenExpiresAt: issued.expiresAt,
        wopiFileUrl: `/wopi/files/${encodeURIComponent(file.id)}`,
        wopiSrc,
        wopiActionUrl,
        collaboraOrigin: c.env.COLLABORA_URL ?? null,
      },
      201
    );
  });
}
