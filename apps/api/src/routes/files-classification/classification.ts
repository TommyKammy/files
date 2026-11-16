import { Hono } from 'hono';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../services/authorization';
import { can } from '../../services/capabilities';
import { buildClassificationChangeStatements, resolveFolderClassificationFloor } from '../../services/classification-updater';
import { type FileRow } from '../../services/file-upload-common';
import { parseExpectedVersionInput } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { ClassificationLabel } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import { isClassificationStricter } from '../../utils/classification';
import {
  ASSIGNABLE_CLASSIFICATIONS,
} from './shared';

export function registerFileClassificationRoute(routes: Hono<OidcHonoEnv>) {
  /** PATCH /api/files/:id/classification — approve AI suggestion or manually update label */
  routes.patch('/:id/classification', async (c) => {
    const user = getAuthenticatedUser(c);
    const fileId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      classification?: unknown;
      acceptSuggestion?: unknown;
      expectedVersion?: unknown;
    } | null;

    const [access, file] = await Promise.all([
      resolveTargetAccess(c.env.DB, user, 'file', fileId),
      c.env.DB.prepare(
        'SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
      )
        .bind(user.tenantId, fileId)
        .first<FileRow>(),
    ]);

    if (!access || !file || file.upload_state !== 'active') {
      return c.json({ error: 'File not found' }, 404);
    }

    const isPrivilegedAdmin = user.role === 'sec_admin' || user.role === 'sys_admin';
    if (!isPrivilegedAdmin && !can(access.capabilities, 'classification.edit')) {
      return c.json({ error: 'Forbidden: classification edit permission required' }, 403);
    }

    const expectedVersion = parseExpectedVersionInput(undefined, body);
    if (expectedVersion !== undefined && file.meta_version !== expectedVersion) {
      return c.json({ error: 'Version conflict', code: 'VERSION_CONFLICT', latest: file }, 409);
    }

    let targetLabel: ClassificationLabel;
    if (body?.acceptSuggestion === true) {
      if (!file.ai_suggested_label || !ASSIGNABLE_CLASSIFICATIONS.has(file.ai_suggested_label)) {
        return c.json({ error: 'File does not have an active AI suggestion to approve' }, 400);
      }
      targetLabel = file.ai_suggested_label;
    } else {
      if (
        typeof body?.classification !== 'string' ||
        !ASSIGNABLE_CLASSIFICATIONS.has(body.classification as ClassificationLabel)
      ) {
        return c.json(
          { error: 'classification must be one of confidential, internal, or public' },
          400
        );
      }
      targetLabel = body.classification as ClassificationLabel;
    }

    // Enforce ancestor folder classification floor (cannot weaken beneath confidential folder)
    if (file.folder_id) {
      const strictestAncestor = await resolveFolderClassificationFloor(
        c.env.DB,
        user.tenantId,
        file.folder_id
      );

      if (
        strictestAncestor === 'confidential' &&
        isClassificationStricter(strictestAncestor, targetLabel)
      ) {
        return c.json(
          {
            error: 'Cannot lower classification beneath a confidential parent folder',
            code: 'CLASSIFICATION_DOWNGRADE_FORBIDDEN',
          },
          403
        );
      }
    }

    const nowIso = new Date().toISOString();
    const stmts = buildClassificationChangeStatements(c.env.DB, {
      tenantId: user.tenantId,
      fileId: file.id,
      folderId: file.folder_id,
      fromClassification: file.classification,
      toClassification: targetLabel,
      sizeBytes: file.size_bytes,
      clearSuggestion: true,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      auditAction:
        body?.acceptSuggestion === true
          ? 'ai.classification_approved'
          : 'file.classification_updated',
      auditMetadata:
        body?.acceptSuggestion === true
          ? { acceptedAiConfidence: file.ai_confidence }
          : undefined,
      nowIso,
    });

    const batchResults = await c.env.DB.batch(stmts);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind:
        body?.acceptSuggestion === true
          ? 'ai.classification_approved'
          : 'file.classification_updated',
      scopeFolderIds: [file.folder_id],
    });

    const updated = await c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, file.id)
      .first<FileRow>();

    return c.json({ file: updated });
  });

}
