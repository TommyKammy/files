import { buildAuditLogStmt } from '../../services/audit';
import { buildClassificationChangeStatements } from '../../services/classification-updater';
import { extractClassificationContext } from '../../services/excerpt-extractor';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { extractLastSyncSeq, notifyTenantSyncHub } from '../../services/sync-notifier';
import { classifyWithLlm, LlmQuotaExceededError } from '../../services/llm-classifier';
import type { ClassificationLabel } from '../../types/api';
import type { AiSuggestibleLabel, ClassifyFileQueueMessage } from '../../types/classification';
import type { OidcEnv } from '../../types/oidc';
import { pickStricterClassification } from '../../utils/classification';

const DEFAULT_MIN_CONFIDENCE = 0.70;

function parseMinSuggestionConfidence(env: OidcEnv): number {
  const parsed = Number.parseFloat(env.MIN_SUGGESTION_CONFIDENCE ?? '');
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_MIN_CONFIDENCE;
  }
  return parsed;
}

export async function handleClassifyFile(
  msg: ClassifyFileQueueMessage,
  env: OidcEnv
): Promise<'ack' | 'retry'> {
  const file = await env.DB.prepare(
    `SELECT id, folder_id, size_bytes, classification, upload_state, deleted_at
     FROM files WHERE tenant_id = ? AND id = ?`
  )
    .bind(msg.tenantId, msg.fileId)
    .first<{
      id: string;
      folder_id: string | null;
      size_bytes: number;
      classification: ClassificationLabel;
      upload_state: string;
      deleted_at: string | null;
    }>();

  if (!file || file.deleted_at !== null || file.upload_state !== 'active') {
    return 'ack';
  }
  if (file.classification !== 'unset') {
    // User or folder inheritance already classified this file
    return 'ack';
  }

  const ctx = await extractClassificationContext(env.DB, env.BUCKET, msg);
  if (!ctx || ctx.mode === 'disabled') {
    return 'ack';
  }

  const nowIso = new Date().toISOString();

  // Safety: if file resides beneath a confidential folder, promote straight to confidential
  if (ctx.ancestorFloorClassification === 'confidential') {
    const stmts = buildClassificationChangeStatements(env.DB, {
      tenantId: msg.tenantId,
      fileId: msg.fileId,
      folderId: file.folder_id,
      fromClassification: 'unset',
      toClassification: 'confidential',
      sizeBytes: file.size_bytes,
      clearSuggestion: true,
      actorId: null,
      actorEmail: 'ai-classifier@system',
      actorIp: 'queue-worker',
      auditAction: 'ai.classification_auto_applied',
      auditMetadata: { reason: 'Inherited confidential parent folder floor', confidence: 1 },
      nowIso,
    });
    const batchResults = await env.DB.batch(stmts);
    await notifyTenantSyncHub(env, {
      tenantId: msg.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'ai.classification_auto_applied',
      scopeFolderIds: [file.folder_id],
    });
    return 'ack';
  }

  let llmResult;
  try {
    llmResult = await classifyWithLlm(env, ctx);
  } catch (err) {
    if (err instanceof LlmQuotaExceededError) {
      await env.DB.batch([
        buildAuditLogStmt(env.DB, {
          tenantId: msg.tenantId,
          actorId: null,
          actorEmail: 'ai-classifier@system',
          actorIp: 'queue-worker',
          action: 'ai.classification_quota_exceeded',
          targetType: 'file',
          targetId: msg.fileId,
          classificationSnapshot: file.classification,
          status: 'blocked',
          metadata: { error: err.message.slice(0, 300), mode: ctx.mode },
          nowIso,
        }),
      ]);
      // Gracefully ack instead of endlessly retrying into DLQ on daily Neurons ceiling
      return 'ack';
    }
    return 'retry';
  }

  const minConfidence = parseMinSuggestionConfidence(env);
  if (llmResult.confidence < minConfidence) {
    await env.DB.batch([
      buildAuditLogStmt(env.DB, {
        tenantId: msg.tenantId,
        actorId: null,
        actorEmail: 'ai-classifier@system',
        actorIp: 'queue-worker',
        action: 'ai.classification_low_confidence',
        targetType: 'file',
        targetId: msg.fileId,
        classificationSnapshot: file.classification,
        metadata: {
          suggestedLabel: llmResult.suggestedLabel,
          confidence: llmResult.confidence,
          threshold: minConfidence,
          excerptIncluded: ctx.excerptIncluded,
        },
        nowIso,
      }),
    ]);
    return 'ack';
  }

  const effectiveSuggested: AiSuggestibleLabel = pickStricterClassification(
    ctx.ancestorFloorClassification,
    llmResult.suggestedLabel
  ) as AiSuggestibleLabel;

  // Auto-apply is strictly permitted ONLY for upward/safe scopes ('confidential' / 'internal');
  // NEVER auto-apply 'public' — human review is mandatory before making anything public.
  const canAutoApply =
    ctx.autoApplyThreshold !== null &&
    llmResult.confidence >= ctx.autoApplyThreshold &&
    (effectiveSuggested === 'confidential' || effectiveSuggested === 'internal');

  if (canAutoApply) {
    const stmts = buildClassificationChangeStatements(env.DB, {
      tenantId: msg.tenantId,
      fileId: msg.fileId,
      folderId: file.folder_id,
      fromClassification: 'unset',
      toClassification: effectiveSuggested,
      sizeBytes: file.size_bytes,
      clearSuggestion: true,
      actorId: null,
      actorEmail: 'ai-classifier@system',
      actorIp: 'queue-worker',
      auditAction: 'ai.classification_auto_applied',
      auditMetadata: {
        confidence: llmResult.confidence,
        reason: llmResult.reason,
        mode: ctx.mode,
        excerptIncluded: ctx.excerptIncluded,
      },
      nowIso,
    });
    const batchResults = await env.DB.batch(stmts);
    await notifyTenantSyncHub(env, {
      tenantId: msg.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'ai.classification_auto_applied',
      scopeFolderIds: [file.folder_id],
    });
    return 'ack';
  }

  // Record suggestion for Human-in-the-Loop approval (workspace chip & admin queue)
  const batchResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE files
       SET ai_suggested_label = ?, ai_confidence = ?, ai_reason = ?,
           content_excerpt = COALESCE(content_excerpt, ?),
           meta_version = meta_version + 1, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND classification = 'unset' AND deleted_at IS NULL`
    ).bind(
      effectiveSuggested,
      llmResult.confidence,
      llmResult.reason,
      ctx.excerpt,
      nowIso,
      msg.tenantId,
      msg.fileId
    ),
    env.DB.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(msg.fileId),
    env.DB.prepare(
      `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason, content_excerpt)
       SELECT id, tenant_id, classification, name, COALESCE(extension, ''), COALESCE(ai_reason, ''), COALESCE(content_excerpt, '')
         FROM files
        WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND upload_state = 'active'`
    ).bind(msg.tenantId, msg.fileId),
    buildAuditLogStmt(env.DB, {
      tenantId: msg.tenantId,
      actorId: null,
      actorEmail: 'ai-classifier@system',
      actorIp: 'queue-worker',
      action: 'ai.classification_suggested',
      targetType: 'file',
      targetId: msg.fileId,
      classificationSnapshot: file.classification,
      metadata: {
        suggestedLabel: effectiveSuggested,
        confidence: llmResult.confidence,
        reason: llmResult.reason,
        mode: ctx.mode,
        excerptIncluded: ctx.excerptIncluded,
      },
      nowIso,
    }),
    buildSyncChangeStmt(env.DB, {
      tenantId: msg.tenantId,
      entityType: 'file',
      entityId: msg.fileId,
      folderId: file.folder_id,
      action: 'ai.suggestion_recorded',
      payload: {
        aiSuggestedLabel: effectiveSuggested,
        aiConfidence: llmResult.confidence,
        aiReason: llmResult.reason,
        updatedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  await notifyTenantSyncHub(env, {
    tenantId: msg.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: 'ai.suggestion_recorded',
    scopeFolderIds: [file.folder_id],  });

  return 'ack';
}
