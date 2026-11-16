import type { UserRole } from '../types/api';
import type { NormalizedOidcClaims } from '../types/oidc';

export interface DbUserRow {
  id: string;
  tenant_id: string;
  idp_issuer: string | null;
  external_idp_id: string | null;
  email: string;
  display_name: string;
  department: string | null;
  role: UserRole;
  status: 'active' | 'suspended';
}

export class AccountLinkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountLinkConflictError';
  }
}

const USER_COLUMNS =
  'id, tenant_id, idp_issuer, external_idp_id, email, display_name, department, role, status';

export async function syncUserWithD1(
  db: D1Database,
  tenantId: string,
  claims: NormalizedOidcClaims,
  ipAddress: string
): Promise<DbUserRow> {
  // 1. (issuer, subject) の組で一意に識別する。メールアドレスは識別子として使わない。
  //    外部ゲスト行は IdP 主体の検索対象外とし、OIDC ログインで昇格しない。
  let existing = await db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE tenant_id = ? AND idp_issuer = ? AND external_idp_id = ?
          AND user_type = 'member'`
    )
    .bind(tenantId, claims.issuer, claims.externalIdpId)
    .first<DbUserRow>();

  // 2. IdP 識別子が未紐付けの事前登録メンバーに限り、IdP が検証済みと明示したメールで初回紐付け。
  //    ゲスト行はメール一致でも絶対に紐付けない。
  if (!existing && claims.emailVerified) {
    existing = await db
      .prepare(
        `SELECT ${USER_COLUMNS} FROM users
          WHERE tenant_id = ? AND email = ? AND external_idp_id IS NULL
            AND user_type = 'member'`
      )
      .bind(tenantId, claims.email)
      .first<DbUserRow>();
  }

  const nowIso = new Date().toISOString();

  if (existing) {
    // IdP がグループ情報を確定的に返した場合のみロールを同期（降格を含む）
    const nextRole: UserRole = claims.resolvedRole ?? existing.role;
    const nextDepartment = claims.department ?? existing.department;

    const hasDiff =
      existing.idp_issuer !== claims.issuer ||
      existing.external_idp_id !== claims.externalIdpId ||
      existing.email !== claims.email ||
      existing.display_name !== claims.displayName ||
      existing.department !== nextDepartment ||
      existing.role !== nextRole;

    if (hasDiff) {
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `UPDATE users
              SET idp_issuer = ?, external_idp_id = ?, email = ?, display_name = ?,
                  department = ?, role = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?`
        ).bind(
          claims.issuer,
          claims.externalIdpId,
          claims.email,
          claims.displayName,
          nextDepartment,
          nextRole,
          nowIso,
          tenantId,
          existing.id
        ),
      ];

      if (existing.role !== nextRole) {
        statements.push(
          db.prepare(
            `INSERT INTO audit_logs (
               id, tenant_id, actor_id, actor_email, actor_ip, action,
               target_type, target_id, status, metadata_json, created_at
             ) VALUES (?, ?, ?, ?, ?, 'user.role_sync', 'user', ?, 'allowed', ?, ?)`
          ).bind(
            crypto.randomUUID(),
            tenantId,
            existing.id,
            claims.email,
            ipAddress,
            existing.id,
            JSON.stringify({ from: existing.role, to: nextRole, provider: claims.provider }),
            nowIso
          )
        );
      }

      await db.batch(statements);
    }

    return {
      ...existing,
      idp_issuer: claims.issuer,
      external_idp_id: claims.externalIdpId,
      email: claims.email,
      display_name: claims.displayName,
      department: nextDepartment,
      role: nextRole,
    };
  }

  // 3. 同一メールの別ユーザー（別 IdP 由来、未検証メール経由、または外部ゲスト）が
  //    存在する場合は自動統合しない。ゲストはメンバーへ昇格できない。
  const conflict = await db
    .prepare('SELECT id, user_type FROM users WHERE tenant_id = ? AND email = ?')
    .bind(tenantId, claims.email)
    .first<{ id: string; user_type: 'member' | 'guest' }>();
  if (conflict) {
    throw new AccountLinkConflictError(
      conflict.user_type === 'guest'
        ? '同一メールアドレスの外部ゲストアカウントは OIDC メンバーへ自動昇格できません。管理者による紐付け確認が必要です。'
        : '同一メールアドレスの既存アカウントとの自動統合は禁止されています。管理者による紐付け確認が必要です。'
    );
  }

  const newUserId = crypto.randomUUID();
  const initialRole: UserRole = claims.resolvedRole ?? 'member';

  await db.batch([
    db.prepare(
      `INSERT INTO users (
         id, tenant_id, idp_issuer, external_idp_id, email, display_name, department,
         role, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(
      newUserId,
      tenantId,
      claims.issuer,
      claims.externalIdpId,
      claims.email,
      claims.displayName,
      claims.department,
      initialRole,
      nowIso,
      nowIso
    ),
    db.prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action,
         target_type, target_id, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, 'user.jit_provision', 'user', ?, 'allowed', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      tenantId,
      newUserId,
      claims.email,
      ipAddress,
      newUserId,
      JSON.stringify({ provider: claims.provider, issuer: claims.issuer }),
      nowIso
    ),
  ]);

  return {
    id: newUserId,
    tenant_id: tenantId,
    idp_issuer: claims.issuer,
    external_idp_id: claims.externalIdpId,
    email: claims.email,
    display_name: claims.displayName,
    department: claims.department,
    role: initialRole,
    status: 'active',
  };
}
