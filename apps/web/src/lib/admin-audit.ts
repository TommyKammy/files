export const ROOT_FOLDER_AUDIT_ACTIONS = [
  'admin.root_folder.create',
  'admin.root_folder.owner_transfer',
  'admin.root_folder.co_owner_grant',
  'admin.root_folder.archive',
  'admin.root_folder.restore',
] as const;

/** Prefix preset used by the permission-audit "show audit logs" action. */
export const PERMISSION_AUDIT_ACTION_PREFIXES = [
  'permission.',
  'admin.root_folder.',
  'admin.permission.',
] as const;

/** Prefix preset used by the guest governance "show audit logs" action. */
export const GUEST_AUDIT_ACTION_PREFIXES = [
  'guest.',
  'admin.guest.',
] as const;

/** Prefix preset used by the internal member administration action. */
export const USER_AUDIT_ACTION_PREFIXES = ['admin.user.'] as const;

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'admin.root_folder.create': 'ルートフォルダ作成',
  'admin.root_folder.owner_transfer': '所有者移管',
  'admin.root_folder.co_owner_grant': '共同所有者付与',
  'admin.root_folder.archive': 'ルートフォルダのアーカイブ',
  'admin.root_folder.restore': 'ルートフォルダの復元',
  'admin.permission.bulk_grant': '権限の一括付与',
  'admin.root_folder.bulk_transfer': '所有者の一括移管',
  'admin.root_folder.bulk_archive': 'ルートフォルダの一括アーカイブ',
  'admin.root_folder.bulk_restore': 'ルートフォルダの一括復元',
  'admin.policy_updated': 'テナントポリシー更新',
  'guest.invite': '外部ゲスト招待',
  'guest.resend': '外部ゲスト招待の再送',
  'guest.accept': '外部ゲスト招待の承諾',
  'guest.login': '外部ゲストのサインイン',
  'guest.access': '外部ゲストの共有アイテムアクセス',
  'guest.revoke': '外部ゲスト招待の取消',
  'admin.guest.suspend': 'ゲストの停止',
  'admin.guest.resume': 'ゲストの再開',
  'admin.guest.offboard': 'ゲストの完全オフボーディング',
  'admin.guest.resend_invite': 'ゲスト招待の再送',
  'admin.user.create': '社内メンバー登録',
  'admin.user.update': '社内メンバー更新',
  'admin.user.suspend': '社内メンバー停止',
  'admin.user.resume': '社内メンバー再開',
  'admin.user.bulk_import': '社内メンバー一括登録',
  'guest.auto_suspended_expired': 'ゲストの期限切れ自動停止',
  'guest.expiry_reminder': 'ゲスト有効期限リマインド',
  'shared_link.create': '共有リンク作成',
  'shared_link.update': '共有リンク権限変更',
  'shared_link.revoke': '共有リンク失効',
  'shared_link.file_upload': '共有リンク経由のファイルアップロード',
  'shared_link.version_upload': '共有リンク経由の新バージョンアップロード',
  'folder.create': 'フォルダ作成',
  'folder.update': 'フォルダ更新',
  'folder.invite_policy_updated': 'フォルダ招待ポリシー変更',
  'folder.move': 'フォルダ移動',
  'folder.soft_delete': 'フォルダをゴミ箱へ移動',
  'folder.restore': 'フォルダ復元',
  'file.move': 'ファイル移動',
  'file.rename': 'ファイル名変更',
  'file.soft_delete': 'ファイルをゴミ箱へ移動',
  'file.restore': 'ファイル復元',
  'admin.folder.restore': '管理者によるフォルダ復元',
  'admin.file.restore': '管理者によるファイル復元',
  'workspace.copy_denied': 'コピー拒否 (DLP)',
};

export function formatAuditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function isRootFolderAuditAction(action: string): boolean {
  return (ROOT_FOLDER_AUDIT_ACTIONS as readonly string[]).includes(action);
}

export function isPermissionAuditAction(action: string): boolean {
  return PERMISSION_AUDIT_ACTION_PREFIXES.some((prefix) =>
    action.startsWith(prefix)
  );
}

export function isGuestAuditAction(action: string): boolean {
  return GUEST_AUDIT_ACTION_PREFIXES.some((prefix) =>
    action.startsWith(prefix)
  );
}

export function isUserAuditAction(action: string): boolean {
  return USER_AUDIT_ACTION_PREFIXES.some((prefix) =>
    action.startsWith(prefix)
  );
}
