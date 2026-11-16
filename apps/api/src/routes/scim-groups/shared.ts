import { Hono } from 'hono';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import {
  getClientIp,
  getScimContext,
  insertScimAuditStmt,
  parseScimPagination,
  scimError,
  scimJson,
  type ScimGroupDbRow,
  toScimGroupResource,
} from '../../services/scim-helpers';
import {
  extractGroupMemberIds,
  isRecord,
  parseScimFilterEq,
  parseScimGroupPatch,
} from '../../services/scim-parser';
import {
  SCIM_LIST_RESPONSE_SCHEMA,
  type ScimGroupMemberRef,
  type ScimGroupResource,
  type ScimHonoEnv,
  type ScimListResponse,
} from '../../types/scim';

const D1_CHUNK_SIZE = 30;

export const scimGroupsRoutes = new Hono<ScimHonoEnv>();

export async function loadGroupMembers(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<ScimGroupMemberRef[]> {
  const rows = await db
    .prepare(
      `SELECT gm.user_id AS value, u.display_name AS display
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND u.tenant_id = ?
        ORDER BY gm.user_id ASC`
    )
    .bind(groupId, tenantId)
    .all<{ value: string; display: string }>();

  return rows.results.map((r) => ({ value: r.value, display: r.display }));
}

export async function validateTenantUserIds(
  db: D1Database,
  tenantId: string,
  userIds: string[]
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const validIds = new Set<string>();
  for (const chunk of chunkArray(userIds, D1_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(`SELECT id FROM users WHERE tenant_id = ? AND id IN (${placeholders})`)
      .bind(tenantId, ...chunk)
      .all<{ id: string }>();
    for (const row of rows.results) {
      validIds.add(row.id);
    }
  }
  return userIds.filter((id) => !validIds.has(id));
}

export function buildInsertMembersStmts(
  db: D1Database,
  groupId: string,
  userIds: string[],
  nowIso: string
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const chunk of chunkArray(userIds, D1_CHUNK_SIZE)) {
    for (const userId of chunk) {
      stmts.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO group_members (group_id, user_id, created_at) VALUES (?, ?, ?)'
          )
          .bind(groupId, userId, nowIso)
      );
    }
  }
  return stmts;
}

export function buildDeleteMembersStmts(
  db: D1Database,
  groupId: string,
  userIds: string[]
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const chunk of chunkArray(userIds, D1_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    stmts.push(
      db
        .prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id IN (${placeholders})`)
        .bind(groupId, ...chunk)
    );
  }
  return stmts;
}

export const executeStatementsInChunks = (db: D1Database, statements: D1PreparedStatement[]) =>
  executeBatchChunks(db, statements, D1_CHUNK_SIZE);

