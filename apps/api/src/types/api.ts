import type { TenantSyncHub } from '../durable-objects/tenant-sync-hub';
import type { FileLockHub } from '../durable-objects/file-lock-hub';
import type { ScimContext } from './scim';

export type ClassificationLabel = 'unset' | 'confidential' | 'internal' | 'public';
export type UserRole = 'sys_admin' | 'sec_admin' | 'member';
/**
 * Eight-role capability model (P9-1 / TOM-52).
 *
 * `owner`, `co_owner`, `editor`, `viewer` and `previewer` are the legacy roles.
 * `viewer_uploader`, `previewer_uploader` and `uploader` are folder-only
 * advanced roles gated by `tenant_policies.advanced_roles_enabled`.
 *
 * Capability definitions live in `services/capabilities.ts`.
 */
export type ResourceRole =
  | 'owner'
  | 'co_owner'
  | 'editor'
  | 'viewer_uploader'
  | 'previewer_uploader'
  | 'viewer'
  | 'previewer'
  | 'uploader';
export type ShareAccessScope = 'public' | 'company_only' | 'collaborators_only';
export type UserType = 'member' | 'guest';

/**
 * Fine-grained governance capabilities delegated by `sys_admin` (TOM-73).
 * The canonical runtime list lives in `services/admin-delegations.ts`; this
 * union keeps API/UI projections typed without importing server code.
 */
export type AdminCapability =
  | 'admin.insights.read'
  | 'admin.users.read'
  | 'admin.users.suspend'
  | 'admin.users.manage'
  | 'admin.guests.manage'
  | 'admin.groups.manage'
  | 'admin.content.unlock'
  | 'admin.root_folders.read'
  | 'admin.permissions.audit'
  | 'admin.trash.manage'
  | 'admin.links.revoke'
  | 'admin.reports.run'
  | 'admin.audit.read'
  | 'admin.policies.read'
  | 'admin.policies.edit';

/** Optional group / root-folder boundary for a Co-Admin delegation. */
export interface AdminScope {
  groupId: string | null;
  rootFolderId: string | null;
}

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  JOBS_QUEUE: Queue;
  SYNC_HUB?: DurableObjectNamespace<TenantSyncHub>;
  FILE_LOCK_HUB?: DurableObjectNamespace<FileLockHub>;
  AI?: Ai;
  ENVIRONMENT?: 'local' | 'staging' | 'production' | 'unconfigured';
  APP_ORIGIN?: string;
  ALLOW_DEV_AUTH?: string;
  DEFAULT_TENANT_ID?: string;
  STORAGE_MODE: 's3_presigned' | 'local_proxy';
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  LOCAL_PROXY_SECRET?: string;
  OIDC_STATE_COOKIE_KEY?: string;
  LLM_PROVIDER?: 'local_openai' | 'workers_ai';
  LOCAL_LLM_BASE_URL?: string;
  LOCAL_LLM_MODEL?: string;
  WORKERS_AI_MODEL?: string;
  MIN_SUGGESTION_CONFIDENCE?: string;
  WOPI_TOKEN_SECRET?: string;
  WOPI_ALLOWED_CLIENT_IPS?: string;
  WOPI_HOST_ORIGIN?: string;
  WOPI_DISCOVERY_URL?: string;
  COLLABORA_URL?: string;
  /** Production transactional mail webhook (guest invitations / OTP). */
  MAIL_WEBHOOK_URL?: string;
  MAIL_API_KEY?: string;
  MAIL_FROM?: string;
  /** AES-GCM key used to seal tenant SIEM webhook secrets at rest. */
  SIEM_WEBHOOK_SECRET_KEY?: string;
}

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: UserRole;
  ipAddress: string;
  /** `guest` users are isolated from every internal/member-only surface. */
  userType: UserType;
  externalOrg?: string | null;
  /** Guest account expiry (ISO). Members are `null`. */
  expiresAt?: string | null;
  /**
   * D1 `sessions.id` backing the request. `null` for dev-bypass requests
   * without `X-Dev-Session-Id`; never exposes `token_hash`.
   */
  sessionId?: string | null;
  /**
   * Effective fine-grained governance capabilities (TOM-73). Always projected
   * by the session middleware; `sys_admin` receives the full canonical set,
   * `sec_admin` its legacy security-operator subset, delegated members their
   * delegation, and guests an empty array.
   */
  adminCapabilities?: AdminCapability[];
  /** Delegation scope; `null` for sys_admin/sec_admin/guests/no delegation. */
  adminScope?: AdminScope | null;
}

export interface AppVariables {
  user: AuthUser | null;
  scim?: ScimContext;
}

export type HonoEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
