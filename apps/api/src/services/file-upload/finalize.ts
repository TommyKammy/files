import type { AuthUser } from '../../types/api';
import { buildFinalizeActivationStatements } from './finalize-activate';
import { verifyFinalizeUpload } from './finalize-verify';
import { FileRow } from './shared';

export async function finalizeUploadedVersion(
  db: D1Database,
  bucket: R2Bucket,
  queue: Queue,
  user: AuthUser,
  input: {
    fileId: string;
    versionId: string;
    maxAllowedBytes?: number;
  }
): Promise<{ file: FileRow; aiClassificationQueued: boolean }> {
  const {
    file,
    version,
    headObj,
    wasActive,
    netDeltaBytes,
    countDelta,
    markFailedCleanup,
  } = await verifyFinalizeUpload(db, bucket, user, input);

  const nowIso = new Date().toISOString();
  const statements = buildFinalizeActivationStatements({
    db,
    user,
    file,
    version,
    headObj,
    nowIso,
    netDeltaBytes,
    countDelta,
  });

  try {
    await db.batch(statements);
  } catch (err) {
    if (((err as Error).message ?? '').includes('UNIQUE constraint failed')) {
      await markFailedCleanup(
        409,
        'FILE_ALREADY_EXISTS',
        `File "${file.name}" already exists in this folder`,
        'file.upload_blocked_conflict'
      );
    }
    throw err;
  }

  const aiClassificationQueued = file.classification === 'unset';
  if (aiClassificationQueued) {
    await queue.send({
      type: 'classify_file',
      tenantId: user.tenantId,
      fileId: file.id,
      versionId: version.id,
      r2ObjectKey: version.r2_object_key,
      mimeType: version.mime_type,
      fileName: file.name,
      extension: file.extension,
    });
  }

  const updatedFile = await db
    .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, file.id)
    .first<FileRow>();

  return {
    file: updatedFile!,
    aiClassificationQueued,
  };
}
