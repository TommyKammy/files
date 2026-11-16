import type { TenantSyncHub } from '../durable-objects/tenant-sync-hub';
import type { FileLockHub } from '../durable-objects/file-lock-hub';
import type { ScimContext } from './scim';

export type ClassificationLabel = 'unset' | 'confidential' | 'internal' | 'public';
export type UserRole = 'sys_admin' | 'sec_admin' | 'member';
export type ResourceRole = 'owner' | 'co_owner' | 'editor' | 'viewer' | 'previewer';
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
