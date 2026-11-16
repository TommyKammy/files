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
}

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: UserRole;
  ipAddress: string;
}

export interface AppVariables {
  user: AuthUser | null;
  scim?: ScimContext;
}

export type HonoEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
