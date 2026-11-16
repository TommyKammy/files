/**
 * Durable idempotency for tenant-admin bulk operations (P9-7 / TOM-57).
 *
 * The database primary key is `(tenant_id, idempotency_key)`. A request first
 * inserts an `in_progress` row:
 * - a concurrent duplicate finds `in_progress` and receives
 *   `409 BULK_OPERATION_IN_PROGRESS`
 * - a completed duplicate with the same request hash replays the stored result
 *   with `replayed: true`
 * - reusing a key with a different operation/payload receives
 *   `409 IDEMPOTENCY_KEY_CONFLICT`
 *
 * `dryRun` previews never call this module, so they neither consume a key nor
 * block a later real execution.
 */

export class AdminBulkIdempotencyError extends Error {
  constructor(
    public readonly status: 409,
    public readonly code:
      | 'BULK_OPERATION_IN_PROGRESS'
      | 'IDEMPOTENCY_KEY_CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'AdminBulkIdempotencyError';
  }
}

interface IdempotencyRow {
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_json: string | null;
}

export interface IdempotencyReplay<T> {
  kind: 'replay';
  response: T;
}

export interface IdempotencyExecute<T> {
  kind: 'execute';
  complete: (response: T) => Promise<T>;
  fail: () => Promise<void>;
}

export type IdempotencySession<T> = IdempotencyReplay<T> | IdempotencyExecute<T>;

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Normalize the optional key from the JSON body or `Idempotency-Key` header. */
export function resolveIdempotencyKey(
  bodyValue: unknown,
  headerValue: string | null | undefined
): string | null {
  const candidate =
    typeof bodyValue === 'string' && bodyValue.trim().length > 0
      ? bodyValue.trim()
      : (headerValue ?? '').trim();
  if (!candidate) return null;
  return candidate.slice(0, 200);
}

/**
 * Claim the idempotency key (if supplied) and return either a replay or a
 * completion/failure handle. Passing `null` makes the call a no-op wrapper.
 */
export async function beginAdminBulkOperation<T>(input: {
  db: D1Database;
  tenantId: string;
  operation: string;
  idempotencyKey: string | null;
  payload: unknown;
}): Promise<IdempotencySession<T>> {
  if (!input.idempotencyKey) {
    return {
      kind: 'execute',
      complete: async (response) => response,
      fail: async () => undefined,
    };
  }

  const requestHash = await sha256Hex(
    canonicalJson({ operation: input.operation, payload: input.payload })
  );
  const nowIso = new Date().toISOString();

  try {
    await input.db
      .prepare(
        `INSERT INTO admin_bulk_idempotency (
           tenant_id, operation, idempotency_key, request_hash, status,
           response_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'in_progress', NULL, ?, ?)`
      )
      .bind(
        input.tenantId,
        input.operation,
        input.idempotencyKey,
        requestHash,
        nowIso,
        nowIso
      )
      .run();
  } catch (err) {
    const existing = await input.db
      .prepare(
        `SELECT request_hash, status, response_json
           FROM admin_bulk_idempotency
          WHERE tenant_id = ? AND idempotency_key = ?`
      )
      .bind(input.tenantId, input.idempotencyKey)
      .first<IdempotencyRow>();
    if (!existing) throw err;

    if (existing.request_hash !== requestHash) {
      throw new AdminBulkIdempotencyError(
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
        'Idempotency key was already used with a different operation or payload'
      );
    }
    if (existing.status === 'in_progress') {
      throw new AdminBulkIdempotencyError(
        409,
        'BULK_OPERATION_IN_PROGRESS',
        'A bulk operation with this idempotency key is still in progress'
      );
    }

    let response: T;
    try {
      response = JSON.parse(existing.response_json ?? 'null') as T;
    } catch {
      throw new AdminBulkIdempotencyError(
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
        'Stored idempotency response is unreadable'
      );
    }
    return { kind: 'replay', response };
  }

  return {
    kind: 'execute',
    complete: async (response) => {
      await input.db
        .prepare(
          `UPDATE admin_bulk_idempotency
              SET status = 'completed', response_json = ?, updated_at = ?
            WHERE tenant_id = ? AND idempotency_key = ?`
        )
        .bind(
          JSON.stringify(response),
          new Date().toISOString(),
          input.tenantId,
          input.idempotencyKey
        )
        .run();
      return response;
    },
    fail: async () => {
      await input.db
        .prepare(
          `DELETE FROM admin_bulk_idempotency
            WHERE tenant_id = ? AND idempotency_key = ? AND status = 'in_progress'`
        )
        .bind(input.tenantId, input.idempotencyKey)
        .run();
    },
  };
}
