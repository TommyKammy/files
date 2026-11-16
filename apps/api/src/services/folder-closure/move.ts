import type { AuthUser } from '../../types/api';
import { type FolderRow } from './shared';
import { buildMoveStatements } from './move-statements';
import { resolveMovePlan } from './move-plan';

export async function moveFolderSubtree(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  folderId: string,
  input: {
    targetParentId: string | null;
    expectedVersion?: number;
    targetName?: string;
  }
): Promise<{ folder: FolderRow; classificationJobQueued: boolean }> {
  const plan = await resolveMovePlan(db, user, folderId, input);
  if (plan.noOp) {
    return { folder: plan.source, classificationJobQueued: false };
  }

  const { statements, classificationJobQueued, destClassification } =
    await buildMoveStatements(db, user, folderId, plan);

  await db.batch(statements);

  if (classificationJobQueued) {
    await queue.send({
      type: 'propagate_folder_classification',
      tenantId: user.tenantId,
      folderId,
      targetClassification: destClassification,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
    });
  }

  const updated = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();

  return {
    folder: updated!,
    classificationJobQueued,
  };
}
