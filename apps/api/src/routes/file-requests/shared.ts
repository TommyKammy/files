import type { ClassificationLabel } from '../../types/api';
import type { OidcEnv } from '../../types/oidc';

export const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB
export const DEFAULT_RATE_LIMIT_PER_MIN = 15;
export const SUBMISSION_TOKEN_TTL_MS = 30 * 60 * 1000;

export const DANGEROUS_EXTENSIONS = new Set([
  'exe',
  'bat',
  'cmd',
  'sh',
  'bash',
  'ps1',
  'vbs',
  'vbe',
  'msi',
  'scr',
  'jar',
  'dll',
  'com',
  'pif',
  'html',
  'htm',
  'svg',
  'xhtml',
  'hta',
  'cpl',
  'js',
  'mjs',
  'cjs',
  'php',
  'asp',
  'aspx',
  'jsp',
]);

export interface FileRequestRow {
  id: string;
  tenant_id: string;
  folder_id: string;
  token_hash: string;
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
}

export interface SubmissionGrantPayload {
  requestId: string;
  fileId: string;
  versionId: string;
  submitterEmail: string | null;
  exp: number;
}

export type FileRequestRuntimeEnv = OidcEnv & {
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  FILE_REQUEST_RATE_LIMIT_PER_MIN?: string;
};

export function getClientIp(req: { header: (name: string) => string | undefined }): string {
  return (
    req.header('CF-Connecting-IP') ??
    req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export function parseAllowedExtensionsJson(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.replace(/^\./, '').trim().toLowerCase())
      .filter(Boolean);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

export function formatUtcTimestampCompact(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

export function appendTimestampSuffix(fileName: string, now: Date, nonceSuffix?: string): string {
  const stamp = formatUtcTimestampCompact(now) + (nonceSuffix ? `_${nonceSuffix}` : '');
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < fileName.length - 1) {
    const base = fileName.slice(0, dotIdx);
    const ext = fileName.slice(dotIdx);
    const maxBaseLen = Math.max(1, 255 - stamp.length - ext.length - 1);
    return `${base.slice(0, maxBaseLen)}_${stamp}${ext}`;
  }
  const maxBaseLen = Math.max(1, 255 - stamp.length - 1);
  return `${fileName.slice(0, maxBaseLen)}_${stamp}`;
}

export async function verifyTurnstileToken(
  secretKey: string,
  token: string,
  remoteIp: string
): Promise<boolean> {
  const form = new URLSearchParams();
  form.set('secret', secretKey);
  form.set('response', token);
  if (remoteIp && remoteIp !== 'unknown') {
    form.set('remoteip', remoteIp);
  }
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) return false;
  const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
  return data?.success === true;
}

export async function resolveFolderRequestClassification(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<ClassificationLabel> {
  const row = await db
    .prepare(
      `SELECT 1 FROM folder_closures fc
       JOIN folders f ON f.id = fc.ancestor_id
       WHERE fc.tenant_id = ? AND fc.descendant_id = ? AND f.classification = 'confidential' AND f.deleted_at IS NULL
       LIMIT 1`
    )
    .bind(tenantId, folderId)
    .first();
  // Always default external dropbox submissions to at least 'internal'
  return row ? 'confidential' : 'internal';
}

export function formatInternalFileRequest(row: FileRequestRow) {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    description: row.description,
    requireSubmitterEmail: row.require_submitter_email === 1,
    maxFileSizeBytes: row.max_file_size_bytes,
    allowedExtensions: parseAllowedExtensionsJson(row.allowed_extensions),
    submissionCount: row.submission_count,
    expiresAt: row.expires_at,
    isActive: row.is_active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

