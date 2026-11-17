export interface FileRequestGovernancePolicy {
  allowFileRequests: boolean;
  maxFileSizeBytes: number;
  enforceAllowedExtensions: boolean;
}

export const DEFAULT_FILE_REQUEST_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB
const MIN_FILE_REQUEST_MAX_SIZE_BYTES = 1;
const MAX_FILE_REQUEST_MAX_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB

export const FILE_REQUEST_POLICY_MAX_SIZE_BYTES =
  MAX_FILE_REQUEST_MAX_SIZE_BYTES;

export interface FileRequestPolicyRow {
  allow_file_requests: number | null;
  file_request_max_size_bytes: number | null;
  file_request_enforce_allowed_extensions: number | null;
}

export function readFileRequestPolicy(
  row: FileRequestPolicyRow | null | undefined
): FileRequestGovernancePolicy {
  const rawMax = Number(row?.file_request_max_size_bytes ?? DEFAULT_FILE_REQUEST_MAX_SIZE_BYTES);
  return {
    allowFileRequests: row ? row.allow_file_requests !== 0 : true,
    maxFileSizeBytes:
      Number.isFinite(rawMax) && rawMax >= MIN_FILE_REQUEST_MAX_SIZE_BYTES
        ? Math.floor(rawMax)
        : DEFAULT_FILE_REQUEST_MAX_SIZE_BYTES,
    enforceAllowedExtensions: row
      ? row.file_request_enforce_allowed_extensions === 1
      : false,
  };
}

export async function loadFileRequestPolicy(
  db: D1Database,
  tenantId: string
): Promise<FileRequestGovernancePolicy> {
  const row = await db
    .prepare(
      `SELECT allow_file_requests, file_request_max_size_bytes,
              file_request_enforce_allowed_extensions
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<FileRequestPolicyRow>();
  return readFileRequestPolicy(row);
}

export function isValidFileRequestMaxSizeBytes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_FILE_REQUEST_MAX_SIZE_BYTES &&
    value <= MAX_FILE_REQUEST_MAX_SIZE_BYTES
  );
}

/**
 * Per-request limits can never exceed the tenant-wide limit and a request
 * without an explicit limit inherits the smaller of the default (100 MiB) and
 * the tenant ceiling.
 */
export function resolveRequestMaxSizeBytes(
  requested: number | undefined,
  policyMax: number
): number {
  if (requested !== undefined) return Math.min(requested, policyMax);
  return Math.min(DEFAULT_FILE_REQUEST_MAX_SIZE_BYTES, policyMax);
}
