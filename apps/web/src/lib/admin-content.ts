import type {
  AdminContentInspectPolicy,
  AdminContentSearchFilters,
  AdminContentSearchItem,
  ClassificationLabel,
  TenantPolicyRow,
} from '@/types/files';

export const ADMIN_CONTENT_PAGE_SIZE = 25;
export const ADMIN_CONTENT_REASON_MIN = 3;
export const ADMIN_CONTENT_REASON_MAX = 300;

export const ADMIN_CONTENT_INSPECT_POLICY_META: Record<
  AdminContentInspectPolicy,
  { label: string; description: string }
> = {
  watermark_confidential: {
    label: '透かし強制付きプレビューを許可',
    description:
      '管理者は理由を記録してプレビューできます。機密区分のファイルには必ず単発の透かしが入ります。',
  },
  deny_confidential: {
    label: 'confidential の検査を禁止',
    description:
      '通常ファイルは検査できますが、機密区分のファイルは理由を入力してもブロックされ、監査ログに記録されます。',
  },
  disabled: {
    label: '管理者コンテンツ検査を全面禁止',
    description:
      '管理者であってもファイル内容のプレビュー URL は発行されません。試行は監査ログに blocked として記録されます。',
  },
};

export const ADMIN_CONTENT_INSPECT_POLICY_OPTIONS: AdminContentInspectPolicy[] = [
  'watermark_confidential',
  'deny_confidential',
  'disabled',
];

export const ADMIN_CONTENT_CLASSIFICATION_OPTIONS: Array<{
  value: ClassificationLabel | 'all';
  label: string;
}> = [
  { value: 'all', label: 'すべての機密区分' },
  { value: 'unset', label: '未設定 (unset)' },
  { value: 'internal', label: '社内 (internal)' },
  { value: 'confidential', label: '機密 (confidential)' },
  { value: 'public', label: '公開 (public)' },
];

export const DEFAULT_ADMIN_CONTENT_FILTERS: AdminContentSearchFilters = {
  targetType: 'all',
  query: '',
  classification: 'all',
  createdBy: '',
  extension: '',
  lockedOnly: false,
  hasSharedLink: false,
};

export function readAdminContentInspectPolicy(
  policy: TenantPolicyRow | null
): AdminContentInspectPolicy {
  if (!policy) return 'watermark_confidential';
  const value =
    policy.adminContentInspectPolicy ?? policy.admin_content_inspect_policy;
  return value === 'disabled' || value === 'deny_confidential'
    ? value
    : 'watermark_confidential';
}

export function isAdminContentReasonValid(reason: string): boolean {
  const trimmed = reason.trim();
  return (
    trimmed.length >= ADMIN_CONTENT_REASON_MIN &&
    trimmed.length <= ADMIN_CONTENT_REASON_MAX
  );
}

export function adminContentReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (!trimmed) return '理由を入力してください（3〜300文字）。';
  if (trimmed.length < ADMIN_CONTENT_REASON_MIN) {
    return `理由は${ADMIN_CONTENT_REASON_MIN}文字以上で入力してください。`;
  }
  if (trimmed.length > ADMIN_CONTENT_REASON_MAX) {
    return `理由は${ADMIN_CONTENT_REASON_MAX}文字以内で入力してください。`;
  }
  return null;
}

export function buildAdminContentSearchQueryString(
  filters: AdminContentSearchFilters,
  cursor: string | null = null,
  limit = ADMIN_CONTENT_PAGE_SIZE
): string {
  const params = new URLSearchParams();
  params.set('targetType', filters.targetType);
  if (filters.query.trim()) params.set('query', filters.query.trim());
  if (filters.classification !== 'all') {
    params.set('classification', filters.classification);
  }
  if (filters.createdBy.trim()) params.set('createdBy', filters.createdBy.trim());
  if (filters.extension.trim()) {
    params.set('extension', filters.extension.trim());
  }
  if (filters.lockedOnly) params.set('lockedOnly', '1');
  if (filters.hasSharedLink) params.set('hasSharedLink', '1');
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(limit));
  return params.toString();
}

export function mergeAdminContentSearchItems(
  existing: readonly AdminContentSearchItem[],
  incoming: readonly AdminContentSearchItem[]
): AdminContentSearchItem[] {
  const seen = new Set(
    existing.map((item) => `${item.targetType}:${item.id}`)
  );
  const merged = [...existing];
  for (const item of incoming) {
    const key = `${item.targetType}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function formatAdminContentOwner(owner: {
  email: string | null;
  displayName: string | null;
  id: string;
}): string {
  return owner.displayName ?? owner.email ?? owner.id;
}

export function canInspectAdminContent(
  policy: AdminContentInspectPolicy,
  classification: ClassificationLabel
): boolean {
  if (policy === 'disabled') return false;
  if (policy === 'deny_confidential' && classification === 'confidential') {
    return false;
  }
  return true;
}
