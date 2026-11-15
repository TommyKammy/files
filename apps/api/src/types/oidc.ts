import type { AppVariables, Env, UserRole } from './api';

export interface OidcEnv extends Env {
  ENVIRONMENT?: 'local' | 'staging' | 'production' | 'unconfigured';
  /** ローカル開発専用のヘッダ認証バイパス。'true' かつ ENVIRONMENT=local かつ localhost アクセス時のみ有効 */
  ALLOW_DEV_AUTH?: string;
  /** CSRF 対策の Origin 検証に使用（例: https://files.example.com） */
  APP_ORIGIN?: string;
  DEFAULT_TENANT_ID?: string;
  OKTA_ISSUER?: string;
  OKTA_CLIENT_ID?: string;
  OKTA_CLIENT_SECRET?: string; // wrangler secret
  ENTRA_TENANT_ID?: string;
  ENTRA_CLIENT_ID?: string;
  ENTRA_CLIENT_SECRET?: string; // wrangler secret
  /** 管理者ロールに対応付ける値（カンマ区切り）。Okta: グループ名 / Entra ID: グループ Object ID または App Role 値 */
  ADMIN_GROUPS?: string;
  SEC_ADMIN_GROUPS?: string;
}

export type OidcHonoEnv = {
  Bindings: OidcEnv;
  Variables: AppVariables;
};

export interface IdpProviderConfig {
  provider: 'okta' | 'entra_id';
  issuer: string;
  audience: string;
  jwksUri?: string;
  expectedEntraTenantId?: string;
}

export interface NormalizedOidcClaims {
  provider: 'okta' | 'entra_id';
  issuer: string;
  externalIdpId: string;
  email: string;
  /** IdP がメール所有を検証済みと明示した場合のみ true（Entra ID は常に false 扱い） */
  emailVerified: boolean;
  displayName: string;
  department: string | null;
  groups: string[];
  /** IdP がグループ/ロール情報を確定的に返した場合のみ定義。未定義なら D1 上の既存ロールを維持 */
  resolvedRole?: UserRole;
}
