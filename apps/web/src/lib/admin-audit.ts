export const ROOT_FOLDER_AUDIT_ACTIONS = [
  'admin.root_folder.create',
  'admin.root_folder.owner_transfer',
  'admin.root_folder.co_owner_grant',
  'admin.root_folder.archive',
  'admin.root_folder.restore',
] as const;

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'admin.root_folder.create': 'ルートフォルダ作成',
  'admin.root_folder.owner_transfer': '所有者移管',
  'admin.root_folder.co_owner_grant': '共同所有者付与',
  'admin.root_folder.archive': 'ルートフォルダのアーカイブ',
  'admin.root_folder.restore': 'ルートフォルダの復元',
  'admin.policy_updated': 'テナントポリシー更新',
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
