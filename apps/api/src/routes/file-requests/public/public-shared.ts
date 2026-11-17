import { sha256Hex } from '../../../services/crypto-utils';
import { loadFileRequestPolicy } from '../../../services/file-request-policy';
import { FileRequestRow } from '../shared';

export async function loadActiveFileRequest(
  db: D1Database,
  rawToken: string
): Promise<
  | { ok: true; fileRequest: FileRequestRow }
  | { ok: false; status: 403 | 404 | 410; error: string; code: string }
> {
  if (!rawToken || rawToken.length < 16) {
    return { ok: false, status: 404, error: 'File request not found', code: 'REQUEST_NOT_FOUND' };
  }
  const tokenHash = await sha256Hex(rawToken);
  const reqRow = await db
    .prepare('SELECT * FROM file_requests WHERE token_hash = ?')
    .bind(tokenHash)
    .first<FileRequestRow>();

  if (!reqRow) {
    return { ok: false, status: 404, error: 'File request not found', code: 'REQUEST_NOT_FOUND' };
  }

  // TOM-72: tenant-wide emergency switch applies before any request-specific
  // state, so even an active link stops accepting metadata/uploads at once.
  const policy = await loadFileRequestPolicy(db, reqRow.tenant_id);
  if (!policy.allowFileRequests) {
    return {
      ok: false,
      status: 403,
      error: 'File requests are disabled for this tenant by policy',
      code: 'FILE_REQUESTS_DISABLED_BY_POLICY',
    };
  }

  if (reqRow.is_active !== 1) {
    return { ok: false, status: 410, error: 'File request is closed', code: 'REQUEST_CLOSED' };
  }
  if (reqRow.expires_at && Date.parse(reqRow.expires_at) <= Date.now()) {
    return { ok: false, status: 410, error: 'File request has expired', code: 'REQUEST_EXPIRED' };
  }

  const folder = await db
    .prepare('SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(reqRow.tenant_id, reqRow.folder_id)
    .first<{ deleted_at: string | null }>();
  if (!folder || folder.deleted_at !== null) {
    return { ok: false, status: 410, error: 'File request is no longer available', code: 'TARGET_UNAVAILABLE' };
  }

  // The per-request limit can never exceed the tenant ceiling. Public metadata
  // and upload-init both inherit the clamped value.
  return {
    ok: true,
    fileRequest: {
      ...reqRow,
      max_file_size_bytes: Math.min(
        reqRow.max_file_size_bytes,
        policy.maxFileSizeBytes
      ),
    },
  };
}

