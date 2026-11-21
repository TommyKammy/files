import type { AuthUser, UserRole } from '../../types/api';
import { beginAdminBulkOperation } from '../admin-bulk-idempotency';
import { buildAuditLogStmt } from '../audit';
import { executeGroupedBatches } from '../d1-batch';
import { buildSyncChangeStmt } from '../sync-changes';
import { extractLastSyncSeq } from '../sync-notifier';
import {
  AdminUserError,
  MAX_ADMIN_USER_BULK_ROWS,
  normalizeDepartment,
  normalizeDisplayName,
  normalizeEmail,
  normalizeRole,
  normalizeStorageQuotaBytes,
} from './shared';
import type {
  AdminUserBulkAction,
  AdminUserBulkImportResult,
  AdminUserBulkRowResult,
  ParsedAdminUserCsv,
  TargetUserRow,
} from './types';

function parseCsvMatrix(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else if (char === '\r') {
      // `\r\n` is handled by the following `\n`.
    } else {
      cell += char;
    }
  }

  if (inQuotes) {
    throw new AdminUserError(
      400,
      'INVALID_CSV',
      'CSV contains an unterminated quoted field'
    );
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((record) => record.some((value) => value.trim() !== ''));
}

function normalizeCsvHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]/g, '');
}

const CSV_HEADER_MAP: Record<string, string> = {
  email: 'email',
  displayname: 'displayName',
  name: 'displayName',
  department: 'department',
  dept: 'department',
  role: 'role',
  storagequotabytes: 'storageQuotaBytes',
  storagequota: 'storageQuotaBytes',
  quotabytes: 'storageQuotaBytes',
  quota: 'storageQuotaBytes',
};

export function parseAdminUserCsv(text: string): ParsedAdminUserCsv {
  const cleaned = text.replace(/^\uFEFF/, '');
  const matrix = parseCsvMatrix(cleaned);
  if (matrix.length === 0) {
    throw new AdminUserError(
      400,
      'BULK_IMPORT_EMPTY',
      'CSV must contain a header and at least one data row'
    );
  }

  const rawHeaders = matrix[0] ?? [];
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const rawHeader of rawHeaders) {
    const normalized = normalizeCsvHeader(rawHeader);
    if (!normalized) continue;
    const mapped = CSV_HEADER_MAP[normalized];
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    headers.push(mapped);
  }
  if (!seen.has('email')) {
    throw new AdminUserError(
      400,
      'INVALID_CSV_HEADER',
      'CSV header must include an email column'
    );
  }

  const rows = matrix.slice(1).map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (record[index] ?? '').trim();
    });
    return row;
  });

  return { headers, rows };
}

interface BulkInputRow {
  rowNumber: number;
  emailRaw: unknown;
  displayNameRaw: unknown;
  departmentRaw: unknown;
  roleRaw: unknown;
  storageQuotaRaw: unknown;
}

function normalizeBulkInputRows(input: {
  csv?: unknown;
  rows?: unknown;
}): BulkInputRow[] {
  const hasCsv = typeof input.csv === 'string' && input.csv.trim().length > 0;
  const hasRows = Array.isArray(input.rows);

  if (hasCsv && hasRows) {
    throw new AdminUserError(
      400,
      'INVALID_BULK_IMPORT',
      'Provide either csv or rows, not both'
    );
  }
  if (!hasCsv && !hasRows) {
    throw new AdminUserError(
      400,
      'INVALID_BULK_IMPORT',
      'csv text or a rows array is required'
    );
  }

  let rows: BulkInputRow[];
  if (hasCsv) {
    const parsed = parseAdminUserCsv(input.csv as string);
    rows = parsed.rows.map((row, index) => ({
      rowNumber: index + 2,
      emailRaw: row.email,
      displayNameRaw: row.displayName,
      departmentRaw: row.department,
      roleRaw: row.role,
      storageQuotaRaw: row.storageQuotaBytes,
    }));
  } else {
    rows = (input.rows as unknown[]).map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {
          rowNumber: index + 1,
          emailRaw: undefined,
          displayNameRaw: undefined,
          departmentRaw: undefined,
          roleRaw: undefined,
          storageQuotaRaw: undefined,
        };
      }
      const record = raw as Record<string, unknown>;
      return {
        rowNumber: index + 1,
        emailRaw: record.email,
        displayNameRaw: record.displayName ?? record.display_name,
        departmentRaw: record.department,
        roleRaw: record.role,
        storageQuotaRaw:
          record.storageQuotaBytes ?? record.storage_quota_bytes,
      };
    });
  }

  if (rows.length === 0) {
    throw new AdminUserError(
      400,
      'BULK_IMPORT_EMPTY',
      'Bulk import requires at least one data row'
    );
  }
  if (rows.length > MAX_ADMIN_USER_BULK_ROWS) {
    throw new AdminUserError(
      400,
      'BULK_IMPORT_TOO_LARGE',
      `At most ${MAX_ADMIN_USER_BULK_ROWS} members can be imported at once`
    );
  }
  return rows;
}

interface PlannedBulkRow {
  rowNumber: number;
  email: string;
  displayName: string | null;
  department: string | null;
  role: UserRole | null;
  storageQuotaBytes: number | null;
  action: AdminUserBulkAction;
  userId: string;
  existing: TargetUserRow | null;
  code?: string;
  error?: string;
}

async function loadExistingUsersByEmail(
  db: D1Database,
  tenantId: string,
  emails: readonly string[]
): Promise<Map<string, TargetUserRow>> {
  const map = new Map<string, TargetUserRow>();
  const chunkSize = 40;
  for (let index = 0; index < emails.length; index += chunkSize) {
    const chunk = emails.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT id, email, display_name, department, role, status, user_type,
                storage_quota_bytes, last_login_at, created_at, updated_at
           FROM users
          WHERE tenant_id = ? AND lower(email) IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<TargetUserRow>();
    for (const row of res.results) {
      map.set(row.email.toLowerCase(), row);
    }
  }
  return map;
}

function toRowResult(row: PlannedBulkRow): AdminUserBulkRowResult {
  return {
    rowNumber: row.rowNumber,
    email: row.email,
    action: row.action,
    displayName: row.displayName,
    department: row.department,
    role: row.role,
    storageQuotaBytes: row.storageQuotaBytes,
    ...(row.action !== 'error' ? { userId: row.userId } : {}),
    ...(row.code ? { code: row.code } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function summarizeBulkRows(rows: readonly PlannedBulkRow[]) {
  return {
    createdCount: rows.filter((row) => row.action === 'create').length,
    updatedCount: rows.filter((row) => row.action === 'update').length,
    unchangedCount: rows.filter((row) => row.action === 'unchanged').length,
    errorCount: rows.filter((row) => row.action === 'error').length,
  };
}

export async function bulkImportAdminUsers(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  csv?: unknown;
  rows?: unknown;
  dryRun?: unknown;
  idempotencyKey?: string | null;
}): Promise<AdminUserBulkImportResult> {
  const { db, tenantId, actor } = input;
  const dryRun = input.dryRun === true;
  const inputRows = normalizeBulkInputRows({
    csv: input.csv,
    rows: input.rows,
  });

  const planned: PlannedBulkRow[] = [];
  const validEmails: string[] = [];

  for (const inputRow of inputRows) {
    let email: string;
    try {
      email = normalizeEmail(inputRow.emailRaw);
    } catch (err) {
      const e = err as AdminUserError;
      planned.push({
        rowNumber: inputRow.rowNumber,
        email:
          typeof inputRow.emailRaw === 'string'
            ? inputRow.emailRaw.trim().toLowerCase()
            : '',
        displayName: null,
        department: null,
        role: null,
        storageQuotaBytes: null,
        action: 'error',
        userId: '',
        existing: null,
        code: e.code,
        error: e.message,
      });
      continue;
    }
    planned.push({
      rowNumber: inputRow.rowNumber,
      email,
      displayName: null,
      department: null,
      role: null,
      storageQuotaBytes: null,
      action: 'unchanged',
      userId: crypto.randomUUID(),
      existing: null,
    });
    validEmails.push(email);
  }

  const existingByEmail = await loadExistingUsersByEmail(
    db,
    tenantId,
    [...new Set(validEmails)]
  );

  const seenEmails = new Set<string>();
  for (let index = 0; index < planned.length; index += 1) {
    const row = planned[index]!;
    if (row.action === 'error') continue;
    const inputRow = inputRows[index]!;

    if (seenEmails.has(row.email)) {
      row.action = 'error';
      row.code = 'DUPLICATE_EMAIL_IN_IMPORT';
      row.error = 'The same email appears more than once in this import';
      continue;
    }

    const existing = existingByEmail.get(row.email) ?? null;
    row.existing = existing;

    try {
      const displayName =
        inputRow.displayNameRaw === undefined ||
        (typeof inputRow.displayNameRaw === 'string' &&
          inputRow.displayNameRaw.trim() === '')
          ? undefined
          : normalizeDisplayName(inputRow.displayNameRaw);
      const department =
        inputRow.departmentRaw === undefined
          ? undefined
          : normalizeDepartment(inputRow.departmentRaw);
      const role =
        inputRow.roleRaw === undefined ||
        (typeof inputRow.roleRaw === 'string' &&
          inputRow.roleRaw.trim() === '')
          ? undefined
          : normalizeRole(inputRow.roleRaw);
      const storageQuotaBytes = normalizeStorageQuotaBytes(
        inputRow.storageQuotaRaw,
        { allowUndefined: true }
      );

      if (existing) {
        if (existing.user_type !== 'member') {
          row.action = 'error';
          row.code = 'NOT_INTERNAL_MEMBER';
          row.error = 'Guest accounts cannot be managed from this console';
          row.userId = '';
          continue;
        }
        const nextDisplayName = displayName ?? existing.display_name;
        const nextDepartment =
          department === undefined ? existing.department : department;
        const nextRole = role ?? existing.role;
        const nextQuota =
          storageQuotaBytes === undefined
            ? existing.storage_quota_bytes
            : storageQuotaBytes;

        if (existing.id === actor.id && nextRole !== existing.role) {
          row.action = 'error';
          row.code = 'CANNOT_SELF_MODIFY_PRIVILEGE';
          row.error = 'You cannot change your own administrative role';
          row.userId = '';
          continue;
        }

        row.displayName = nextDisplayName;
        row.department = nextDepartment;
        row.role = nextRole;
        row.storageQuotaBytes = nextQuota;
        row.userId = existing.id;
        row.action =
          nextDisplayName !== existing.display_name ||
          nextDepartment !== existing.department ||
          nextRole !== existing.role ||
          nextQuota !== existing.storage_quota_bytes
            ? 'update'
            : 'unchanged';
        seenEmails.add(row.email);
        continue;
      }

      if (!displayName) {
        row.action = 'error';
        row.code = 'DISPLAY_NAME_REQUIRED';
        row.error = 'displayName is required for a new member';
        row.userId = '';
        continue;
      }
      row.displayName = displayName;
      row.department = department ?? null;
      row.role = role ?? 'member';
      row.storageQuotaBytes = storageQuotaBytes ?? null;
      row.action = 'create';
      seenEmails.add(row.email);
    } catch (err) {
      const e = err as AdminUserError;
      row.action = 'error';
      row.code = e.code;
      row.error = e.message;
      row.userId = '';
    }
  }

  // Preserve at least one active sys_admin across the whole request.
  const activeSysAdmins = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM users
        WHERE tenant_id = ? AND user_type = 'member'
          AND role = 'sys_admin' AND status = 'active'`
    )
    .bind(tenantId)
    .first<{ count: number }>();
  const createdSysAdmins = planned.filter(
    (row) => row.action === 'create' && row.role === 'sys_admin'
  ).length;
  const promotedSysAdmins = planned.filter(
    (row) =>
      row.action === 'update' &&
      row.existing?.role !== 'sys_admin' &&
      row.role === 'sys_admin'
  ).length;
  const demotions = planned.filter(
    (row) =>
      row.action === 'update' &&
      row.existing?.role === 'sys_admin' &&
      row.existing.status === 'active' &&
      row.role !== 'sys_admin'
  );
  if (
    (activeSysAdmins?.count ?? 0) +
      createdSysAdmins +
      promotedSysAdmins -
      demotions.length <
    1
  ) {
    for (const row of demotions) {
      row.action = 'error';
      row.code = 'LAST_SYS_ADMIN_REQUIRED';
      row.error = 'At least one active sys_admin must remain';
      row.userId = '';
    }
  }

  const counts = summarizeBulkRows(planned);
  const payload = {
    csv: typeof input.csv === 'string' ? input.csv : null,
    rows: Array.isArray(input.rows) ? input.rows : null,
    dryRun: false,
  };

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      replayed: false,
      totalRows: planned.length,
      ...counts,
      results: planned.map(toRowResult),
      syncSeq: null,
      notice: `プレビュー: 作成 ${counts.createdCount} 件 / 更新 ${counts.updatedCount} 件 / 変更なし ${counts.unchangedCount} 件 / エラー ${counts.errorCount} 件。`,
    };
  }

  const session = await beginAdminBulkOperation<AdminUserBulkImportResult>({
    db,
    tenantId,
    operation: 'admin.user.bulk_import',
    idempotencyKey: input.idempotencyKey ?? null,
    payload,
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const groups: D1PreparedStatement[][] = [];
    for (const row of planned) {
      if (row.action === 'create') {
        groups.push([
          db
            .prepare(
              `INSERT INTO users (
                 id, tenant_id, email, display_name, department, role, status,
                 user_type, storage_quota_bytes, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'member', ?, ?, ?)`
            )
            .bind(
              row.userId,
              tenantId,
              row.email,
              row.displayName,
              row.department,
              row.role,
              row.storageQuotaBytes,
              nowIso,
              nowIso
            ),
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'user',
            entityId: row.userId,
            targetUserId: row.userId,
            action: 'admin.user.create',
            payload: {
              email: row.email,
              displayName: row.displayName,
              department: row.department,
              role: row.role,
              status: 'active',
              source: 'bulk_import',
            },
            nowIso,
          }),
        ]);
      } else if (row.action === 'update' && row.existing) {
        groups.push([
          db
            .prepare(
              `UPDATE users
                  SET display_name = ?, department = ?, role = ?,
                      storage_quota_bytes = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
            )
            .bind(
              row.displayName,
              row.department,
              row.role,
              row.storageQuotaBytes,
              nowIso,
              tenantId,
              row.existing.id
            ),
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'user',
            entityId: row.existing.id,
            targetUserId: row.existing.id,
            action: 'admin.user.update',
            payload: {
              email: row.email,
              displayName: row.displayName,
              department: row.department,
              role: row.role,
              storageQuotaBytes: row.storageQuotaBytes,
              source: 'bulk_import',
            },
            nowIso,
          }),
        ]);
      }
    }

    groups.push([
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.bulk_import',
        targetType: 'user',
        targetId: 'bulk-import',
        metadata: {
          totalRows: planned.length,
          ...counts,
          createdEmails: planned
            .filter((row) => row.action === 'create')
            .map((row) => row.email),
          updatedEmails: planned
            .filter((row) => row.action === 'update')
            .map((row) => row.email),
        },
        nowIso,
      }),
    ]);

    const results = await executeGroupedBatches(db, groups);
    const response: AdminUserBulkImportResult = {
      ok: true,
      dryRun: false,
      replayed: false,
      totalRows: planned.length,
      ...counts,
      results: planned.map(toRowResult),
      syncSeq: extractLastSyncSeq(results),
      notice: `メンバーを一括登録しました（作成 ${counts.createdCount} 件 / 更新 ${counts.updatedCount} 件 / 変更なし ${counts.unchangedCount} 件 / エラー ${counts.errorCount} 件）。`,
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}
