import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  SCIM_CORE_GROUP_SCHEMA,
  SCIM_CORE_USER_SCHEMA,
  SCIM_ENTERPRISE_USER_SCHEMA,
  SCIM_ERROR_SCHEMA,
  type ScimContext,
  type ScimErrorResponse,
  type ScimGroupMemberRef,
  type ScimGroupResource,
  type ScimHonoEnv,
  type ScimUserResource,
} from '../types/scim';
import { chunkArray } from '../utils/batch';

export { chunkArray };

export interface ScimUserDbRow {
  id: string;
  tenant_id: string;
  idp_issuer: string | null;
  external_idp_id: string | null;
  email: string;
  display_name: string;
  department: string | null;
  status: 'active' | 'suspended';
  created_at?: string;
  updated_at?: string;
}

export interface ScimGroupDbRow {
  id: string;
  tenant_id: string;
  external_idp_id: string | null;
  name: string;
  created_at?: string;
}

/** Return JSON formatted with SCIM 2.0 media type. */
export function scimJson<T>(
  c: Context<ScimHonoEnv>,
  payload: T,
  status: ContentfulStatusCode = 200
): Response {
  return c.json(payload, status, {
    'Content-Type': 'application/scim+json; charset=utf-8',
  });
}

/** Return RFC 7644 error payload with SCIM content-type. */
export function scimError(
  c: Context<ScimHonoEnv>,
  status: ContentfulStatusCode,
  detail: string,
  scimType?: string
): Response {
  const body: ScimErrorResponse = {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
  return scimJson(c, body, status);
}

/** Extract authenticated SCIM tenant context populated by scimAuthMiddleware. */
export function getScimContext(c: Context<ScimHonoEnv>): ScimContext {
  const ctx = c.get('scim');
  if (!ctx) {
    throw new Error('SCIM context missing on authenticated SCIM route');
  }
  return ctx;
}

export function getClientIp(c: Context<ScimHonoEnv>): string {
  return c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
}

export function toScimUserResource(row: ScimUserDbRow): ScimUserResource {
  const schemas = row.department
    ? [SCIM_CORE_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA]
    : [SCIM_CORE_USER_SCHEMA];

  const resource: ScimUserResource = {
    schemas,
    id: row.id,
    ...(row.external_idp_id ? { externalId: row.external_idp_id } : {}),
    userName: row.email,
    displayName: row.display_name,
    emails: [{ value: row.email, type: 'work', primary: true }],
    active: row.status === 'active',
    meta: {
      resourceType: 'User',
      ...(row.created_at ? { created: row.created_at } : {}),
      ...(row.updated_at ? { lastModified: row.updated_at } : {}),
    },
  };

  if (row.department) {
    resource[SCIM_ENTERPRISE_USER_SCHEMA] = { department: row.department };
  }
  return resource;
}

export function toScimGroupResource(
  row: ScimGroupDbRow,
  members: ScimGroupMemberRef[]
): ScimGroupResource {
  return {
    schemas: [SCIM_CORE_GROUP_SCHEMA],
    id: row.id,
    ...(row.external_idp_id ? { externalId: row.external_idp_id } : {}),
    displayName: row.name,
    members,
    meta: {
      resourceType: 'Group',
      ...(row.created_at ? { created: row.created_at } : {}),
    },
  };
}

export function insertScimAuditStmt(
  db: D1Database,
  params: {
    scim: ScimContext;
    actorIp: string;
    action: string;
    targetType: 'user' | 'group';
    targetId: string;
    status?: 'allowed' | 'blocked';
    metadata?: Record<string, unknown>;
    nowIso: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action,
         target_type, target_id, status, metadata_json, created_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      params.scim.tenantId,
      `scim:${params.scim.tokenName}`,
      params.actorIp,
      params.action,
      params.targetType,
      params.targetId,
      params.status ?? 'allowed',
      JSON.stringify({
        scimTokenId: params.scim.scimTokenId,
        idpIssuer: params.scim.idpIssuer,
        ...(params.metadata ?? {}),
      }),
      params.nowIso
    );
}

/** Parse SCIM 1-based startIndex and bounded count parameters. */
export function parseScimPagination(
  startIndexParam: string | undefined,
  countParam: string | undefined
): { startIndex: number; limit: number; offset: number } {
  const parsedStart = Number.parseInt(startIndexParam ?? '1', 10);
  const startIndex = Number.isFinite(parsedStart) && parsedStart >= 1 ? parsedStart : 1;
  const parsedCount = Number.parseInt(countParam ?? '100', 10);
  const limit = Number.isFinite(parsedCount)
    ? Math.min(Math.max(parsedCount, 0), 200)
    : 100;
  return {
    startIndex,
    limit,
    offset: startIndex - 1,
  };
}
