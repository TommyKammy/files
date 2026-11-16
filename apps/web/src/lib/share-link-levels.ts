import type {
  PublicShareMeta,
  ShareAccessScope,
  SharePermissionLevel,
} from '@/types/files';

export interface SharePermissionLevelOption {
  value: SharePermissionLevel;
  label: string;
  description: string;
}

/** Copy shared by the SharePopover radios and the landing badge. */
export const SHARE_PERMISSION_LEVEL_OPTIONS: readonly SharePermissionLevelOption[] = [
  {
    value: 'view',
    label: '表示のみ (view)',
    description: 'プレビュー可・ダウンロード不可（単一使用ストリーム）',
  },
  {
    value: 'download',
    label: '表示 + ダウンロード (download)',
    description: 'プレビュー・ダウンロード可',
  },
  {
    value: 'edit',
    label: '表示 + DL + 編集 (edit)',
    description:
      'アップロード / 上書き保存 / WOPI 編集可（削除・権限・共有管理は不可）',
  },
] as const;

export function permissionLevelLabel(level: SharePermissionLevel): string {
  switch (level) {
    case 'view':
      return '表示のみ';
    case 'download':
      return 'DL可';
    case 'edit':
      return '編集可';
    default:
      return level;
  }
}

export function permissionLevelLandingLabel(
  level: SharePermissionLevel
): string {
  switch (level) {
    case 'view':
      return '表示のみ';
    case 'download':
      return '表示 + DL';
    case 'edit':
      return '表示 + DL + 編集';
    default:
      return level;
  }
}

export function permissionLevelCanDownload(level: SharePermissionLevel): boolean {
  return level !== 'view';
}

export function defaultSharePermissionLevel(input: {
  canManageLinks: boolean;
  classification?: string | null;
}): SharePermissionLevel {
  if (!input.canManageLinks) return 'view';
  if (input.classification === 'confidential' || input.classification === 'unset') {
    return 'view';
  }
  return 'download';
}

export interface ShareLinkFormValidationInput {
  permissionLevel: SharePermissionLevel;
  accessScope: ShareAccessScope;
  canManageLinks: boolean;
  allowSharedLinkEdit: boolean;
  allowPublicEditLinks: boolean;
  password: string;
  expiresInDays: number;
}

/**
 * Client-side mirror of the API guardrails. The server remains authoritative;
 * this only blocks obviously invalid submissions before a round-trip.
 */
export function validateShareLinkForm(
  input: ShareLinkFormValidationInput
): string | null {
  if (!input.canManageLinks && input.permissionLevel !== 'view') {
    return 'このロールでは表示専用 (view) リンクのみ作成できます。';
  }
  if (input.permissionLevel !== 'edit') return null;
  if (!input.allowSharedLinkEdit) {
    return '管理者ポリシーにより編集共有リンクは無効化されています。';
  }
  if (input.accessScope !== 'public') return null;
  if (!input.allowPublicEditLinks) {
    return 'Public (匿名) 編集リンクは管理者ポリシーで禁止されています。認証済みユーザー限定 (company_only) を選択してください。';
  }
  if (!input.password.trim()) {
    return 'Public 編集リンクにはパスワードが必須です。';
  }
  if (!Number.isFinite(input.expiresInDays) || input.expiresInDays <= 0) {
    return 'Public 編集リンクには明示的な有効期限 (日) が必須です。';
  }
  return null;
}

/**
 * Human readable composition notice for SharedLinkLanding, e.g. a signed-in
 * Viewer opening an edit link composes to Viewer + Uploader.
 */
export function buildComposedAccessNotice(
  meta: Pick<
    PublicShareMeta,
    | 'permissionLevel'
    | 'canEdit'
    | 'requiresAuthForEdit'
    | 'composedRole'
    | 'composedCapabilities'
  > | null
): string | null {
  if (!meta) return null;
  if (meta.requiresAuthForEdit) {
    return '匿名アクセスでは編集できません — サインインしてください';
  }
  if (meta.permissionLevel !== 'edit') return null;
  if (!meta.canEdit) return null;
  const capabilities = meta.composedCapabilities ?? [];
  const canUploadNew = capabilities.includes('item.upload_new');
  const canUploadVersion = capabilities.includes('item.upload_version');
  const canWopi = capabilities.includes('item.edit_content');
  const actions: string[] = [];
  if (canUploadNew) actions.push('新規アップロード');
  if (canUploadVersion) actions.push('上書き保存');
  if (canWopi) actions.push('WOPI編集');
  return `権限の合成: ${meta.composedRole ?? 'viewer'} + 編集リンク => ${
    actions.join(' / ') || '閲覧のみ'
  }が可能（削除・権限・共有管理は不可）`;
}

/** Quick-change targets shown in the existing-link list. */
export function availablePermissionLevels(input: {
  canManageLinks: boolean;
  allowSharedLinkEdit: boolean;
}): SharePermissionLevel[] {
  if (!input.canManageLinks) return ['view'];
  return input.allowSharedLinkEdit
    ? ['view', 'download', 'edit']
    : ['view', 'download'];
}
