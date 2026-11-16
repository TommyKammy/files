import type { ClassificationLabel, ResourceRole } from '@/types/files';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, exp);
  return `${val >= 10 || exp === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[exp]}`;
}

export function formatDateTime(
  iso: string | null | undefined,
  options?: { timeZone?: string; timeZoneName?: 'short' | 'long' }
): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
    ...(options?.timeZoneName ? { timeZoneName: options.timeZoneName } : {}),
  }).format(new Date(ms));
}

/**
 * Audit timestamps are displayed in JST with an explicit zone label so the
 * value cannot be mistaken for the viewer's local time.
 */
export function formatAuditDateTime(iso: string | null | undefined): string {
  return formatDateTime(iso, {
    timeZone: 'Asia/Tokyo',
    timeZoneName: 'short',
  });
}

export const CLASSIFICATION_META: Record<
  ClassificationLabel,
  {
    label: string;
    shortJa: string;
    badgeClass: string;
    dotClass: string;
    barClass: string;
  }
> = {
  confidential: {
    label: 'Confidential',
    shortJa: '極秘',
    badgeClass: 'bg-red-50 text-red-700 border-red-200',
    dotClass: 'bg-red-600',
    barClass: 'bg-red-500',
  },
  internal: {
    label: 'Internal',
    shortJa: '社内限定',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
    dotClass: 'bg-blue-600',
    barClass: 'bg-blue-500',
  },
  public: {
    label: 'Public',
    shortJa: '社外公開可',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotClass: 'bg-emerald-600',
    barClass: 'bg-emerald-500',
  },
  unset: {
    label: 'Unset',
    shortJa: '未分類',
    badgeClass: 'bg-slate-100 text-slate-600 border-slate-200',
    dotClass: 'bg-slate-400',
    barClass: 'bg-slate-300',
  },
};

export const ROLE_META: Record<ResourceRole, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'すべての権限' },
  co_owner: { label: 'Co-Owner', description: '編集 + 権限管理（Owner除く）' },
  editor: { label: 'Editor', description: '作成・更新・共有設定可' },
  viewer_uploader: {
    label: 'Viewer + Uploader',
    description: '閲覧・DL・編集 + 新規/新版アップロード',
  },
  previewer_uploader: {
    label: 'Previewer + Uploader',
    description: '画面プレビュー + 新規アップロード（DL・既存版更新は不可）',
  },
  viewer: { label: 'Viewer', description: '閲覧・ダウンロード可' },
  previewer: { label: 'Previewer', description: '画面プレビューのみ（DL不可）' },
  uploader: {
    label: 'Uploader',
    description: '新規アップロード専用（閲覧・DL・プレビュー不可）',
  },
};

/**
 * Legacy UI ordering used by `hasRoleAtLeast`. The 8 roles are not totally
 * ordered, so the fractional ranks only encode the subset relations the UI
 * needs (`editor+`, `viewer+`, `previewer+`); authorization itself is decided
 * by the API's capability array.
 */
const ROLE_ORDER: Record<ResourceRole, number> = {
  uploader: 0.5,
  previewer: 1,
  previewer_uploader: 1.5,
  viewer: 2,
  viewer_uploader: 2.5,
  editor: 3,
  co_owner: 4,
  owner: 5,
};

export function hasRoleAtLeast(
  role: ResourceRole | undefined | null,
  required: ResourceRole
): boolean {
  if (!role) return false;
  return ROLE_ORDER[role] >= ROLE_ORDER[required];
}

const CLASSIFICATION_SEVERITY: Record<ClassificationLabel, number> = {
  confidential: 3,
  internal: 2,
  public: 1,
  unset: 0,
};

export function isClassificationFloorViolated(
  ancestorLabels: ClassificationLabel[],
  targetLabel: ClassificationLabel
): boolean {
  if (!ancestorLabels.includes('confidential')) return false;
  return CLASSIFICATION_SEVERITY[targetLabel] < CLASSIFICATION_SEVERITY.confidential;
}

export function pickStricterClassification(
  a: ClassificationLabel,
  b: ClassificationLabel
): ClassificationLabel {
  return CLASSIFICATION_SEVERITY[a] >= CLASSIFICATION_SEVERITY[b] ? a : b;
}

export function allocateCopyDisplayName(
  desiredName: string,
  kind: 'file' | 'folder',
  existingNames: Set<string>
): string {
  if (!existingNames.has(desiredName)) {
    existingNames.add(desiredName);
    return desiredName;
  }
  let stem = desiredName;
  let extSuffix = '';
  if (kind === 'file') {
    const dotIdx = desiredName.lastIndexOf('.');
    if (dotIdx > 0 && dotIdx < desiredName.length - 1) {
      stem = desiredName.slice(0, dotIdx);
      extSuffix = desiredName.slice(dotIdx);
    }
  }
  for (let i = 1; i <= 100; i++) {
    const tag = i === 1 ? ' (コピー)' : ` (コピー ${i})`;
    const candidate = `${stem.slice(0, Math.max(1, 255 - tag.length - extSuffix.length))}${tag}${extSuffix}`;
    if (!existingNames.has(candidate)) {
      existingNames.add(candidate);
      return candidate;
    }
  }
  const fallback = `${stem.slice(0, 200)} (${Date.now().toString(36)})${extSuffix}`;
  existingNames.add(fallback);
  return fallback;
}

export function getExtensionFromName(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function isActiveWebFile(name: string, mimeType: string | null | undefined): boolean {
  const ext = getExtensionFromName(name);
  const mime = (mimeType ?? '').toLowerCase();
  if (ext === 'html' || ext === 'htm' || ext === 'svg' || ext === 'xhtml') {
    return true;
  }
  return (
    mime.includes('text/html') ||
    mime.includes('image/svg+xml') ||
    mime.includes('application/xhtml+xml')
  );
}

export function isPdfFile(name: string, mimeType: string | null | undefined): boolean {
  const ext = getExtensionFromName(name);
  const mime = (mimeType ?? '').toLowerCase();
  return ext === 'pdf' || mime === 'application/pdf';
}

export function isSafeImageFile(name: string, mimeType: string | null | undefined): boolean {
  if (isActiveWebFile(name, mimeType)) return false;
  const ext = getExtensionFromName(name);
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'].includes(ext);
}

export function isPlainTextFile(name: string, mimeType: string | null | undefined): boolean {
  const ext = getExtensionFromName(name);
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return true;
  }
  return [
    'txt',
    'md',
    'markdown',
    'csv',
    'tsv',
    'json',
    'yaml',
    'yml',
    'toml',
    'xml',
    'log',
    'sql',
    'ts',
    'tsx',
    'js',
    'jsx',
    'css',
    'py',
    'sh',
  ].includes(ext);
}
