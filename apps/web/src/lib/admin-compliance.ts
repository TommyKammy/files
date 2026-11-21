import type {
  TenantBranding,
  TenantPolicyRow,
  TosTargetAudience,
} from '@/types/files';

/**
 * Pure helpers for TOM-72 compliance settings.
 *
 * These are intentionally framework-free so API projections, admin forms,
 * quota banners and the workspace ToS gate all share the same rules and remain
 * unit-testable without rendering React.
 */

export const DEFAULT_TOS_TITLE = '利用規約';
export const DEFAULT_FILE_REQUEST_MAX_SIZE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_QUOTA_WARN_THRESHOLD_PCT = 80;
export const DEFAULT_QUOTA_CRITICAL_THRESHOLD_PCT = 90;

export const TOS_AUDIENCE_OPTIONS: readonly TosTargetAudience[] = [
  'all_users',
  'guests_only',
  'members_only',
];

export const TOS_AUDIENCE_LABELS: Record<TosTargetAudience, string> = {
  all_users: 'すべてのユーザー',
  guests_only: '外部ゲストのみ',
  members_only: '社内メンバーのみ',
};

export function isTosTargetAudience(
  value: unknown
): value is TosTargetAudience {
  return (
    value === 'all_users' ||
    value === 'guests_only' ||
    value === 'members_only'
  );
}

export function formatTosAudienceLabel(
  audience: TosTargetAudience | null | undefined
): string {
  if (!audience) return TOS_AUDIENCE_LABELS.all_users;
  return TOS_AUDIENCE_LABELS[audience] ?? TOS_AUDIENCE_LABELS.all_users;
}

export type TosMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'paragraph'; text: string };

/**
 * Very small, deliberately non-HTML markdown subset used by the acceptance
 * modal. The renderer only ever emits React text nodes, so raw HTML from a
 * tenant policy can never execute.
 */
export function parseTosMarkdownBlocks(markdown: string): TosMarkdownBlock[] {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const blocks: TosMarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line.trim());
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line.trim());
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: 'bullet', text: bullet[1].trim() });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

export interface FileRequestPolicyProjection {
  allowFileRequests: boolean;
  fileRequestMaxSizeBytes: number;
  fileRequestEnforceAllowedExtensions: boolean;
}

export function readFileRequestPolicy(
  policy: TenantPolicyRow | null | undefined
): FileRequestPolicyProjection {
  const rawMax =
    policy?.fileRequestMaxSizeBytes ??
    policy?.file_request_max_size_bytes ??
    DEFAULT_FILE_REQUEST_MAX_SIZE_BYTES;
  return {
    allowFileRequests:
      typeof policy?.allowFileRequests === 'boolean'
        ? policy.allowFileRequests
        : policy?.allow_file_requests !== 0,
    fileRequestMaxSizeBytes:
      typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
        ? Math.floor(rawMax)
        : DEFAULT_FILE_REQUEST_MAX_SIZE_BYTES,
    fileRequestEnforceAllowedExtensions:
      typeof policy?.fileRequestEnforceAllowedExtensions === 'boolean'
        ? policy.fileRequestEnforceAllowedExtensions
        : policy?.file_request_enforce_allowed_extensions === 1,
  };
}

export const BRANDING_ACCENT_COLOR_PRESETS = [
  '#2563eb',
  '#0f766e',
  '#4f46e5',
  '#7c3aed',
  '#be123c',
  '#b45309',
  '#334155',
] as const;

export function normalizeHexAccentColor(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function readBranding(
  policy: TenantPolicyRow | null | undefined
): TenantBranding {
  const rawLogoUrl = policy?.brandingLogoUrl?.trim() || null;
  const rawAccent =
    policy?.brandingAccentColor?.trim() ||
    policy?.branding_accent_color?.trim() ||
    null;
  return {
    orgName:
      policy?.brandingOrgName?.trim() ||
      policy?.branding_org_name?.trim() ||
      null,
    contactInfo:
      policy?.brandingContactInfo?.trim() ||
      policy?.branding_contact_info?.trim() ||
      null,
    footerNote:
      policy?.brandingFooterNote?.trim() ||
      policy?.branding_footer_note?.trim() ||
      null,
    logoUrl: rawLogoUrl,
    accentColor: normalizeHexAccentColor(rawAccent),
  };
}

export interface QuotaThresholds {
  warn: number;
  critical: number;
}

export function readQuotaThresholds(
  policy: TenantPolicyRow | null | undefined
): QuotaThresholds {
  const warn =
    policy?.quotaWarnThresholdPct ??
    policy?.quota_warn_threshold_pct ??
    DEFAULT_QUOTA_WARN_THRESHOLD_PCT;
  const critical =
    policy?.quotaCriticalThresholdPct ??
    policy?.quota_critical_threshold_pct ??
    DEFAULT_QUOTA_CRITICAL_THRESHOLD_PCT;
  return {
    warn:
      typeof warn === 'number' && Number.isFinite(warn)
        ? warn
        : DEFAULT_QUOTA_WARN_THRESHOLD_PCT,
    critical:
      typeof critical === 'number' && Number.isFinite(critical)
        ? critical
        : DEFAULT_QUOTA_CRITICAL_THRESHOLD_PCT,
  };
}

export function validateQuotaThresholds(
  warn: number,
  critical: number
): { ok: boolean; error?: string; code?: string } {
  if (!Number.isInteger(warn) || warn < 50 || warn > 99) {
    return {
      ok: false,
      code: 'INVALID_QUOTA_THRESHOLDS',
      error: '警告しきい値は 50〜99% の整数で指定してください',
    };
  }
  if (!Number.isInteger(critical) || critical < 51 || critical > 100) {
    return {
      ok: false,
      code: 'INVALID_QUOTA_THRESHOLDS',
      error: '緊急しきい値は 51〜100% の整数で指定してください',
    };
  }
  if (warn >= critical) {
    return {
      ok: false,
      code: 'INVALID_QUOTA_THRESHOLDS',
      error: '警告しきい値は緊急しきい値より小さくしてください',
    };
  }
  return { ok: true };
}

export type QuotaBannerLevel = 'normal' | 'warning' | 'critical';

export interface QuotaBannerState {
  level: QuotaBannerLevel;
  usedPct: number;
  warn: number;
  critical: number;
  title: string;
  message: string;
}

export function evaluateQuotaBanner(
  usedPct: number,
  thresholds: QuotaThresholds
): QuotaBannerState {
  const clamped = Math.max(
    0,
    Math.min(100, Number.isFinite(usedPct) ? usedPct : 0)
  );
  const { warn, critical } = thresholds;
  if (clamped >= critical) {
    return {
      level: 'critical',
      usedPct: clamped,
      warn,
      critical,
      title: 'ストレージ使用率が緊急しきい値に到達しました',
      message: `契約ストレージの ${clamped}% を使用しています（緊急 ${critical}%）。不要なファイルの削除や容量追加を至急検討してください。`,
    };
  }
  if (clamped >= warn) {
    return {
      level: 'warning',
      usedPct: clamped,
      warn,
      critical,
      title: 'ストレージ使用率が警告しきい値に到達しました',
      message: `契約ストレージの ${clamped}% を使用しています（警告 ${warn}%）。容量計画を確認してください。`,
    };
  }
  return {
    level: 'normal',
    usedPct: clamped,
    warn,
    critical,
    title: '',
    message: '',
  };
}

const PRIVATE_IPV4_PARTS = new Set([0, 10, 127, 169, 172, 192, 100]);

function isPrivateIpv4Client(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function parseIpv6ClientGroups(host: string): number[] | null {
  let value = host.toLowerCase();
  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (!value.includes(':')) return null;

  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map((part) => Number(part));
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (segment: string): number[] | null => {
    if (!segment) return [];
    const groups = segment.split(':');
    const parsed: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      parsed.push(Number.parseInt(group, 16));
    }
    return parsed;
  };
  if (halves.length === 1) {
    const groups = parseGroups(value);
    return groups && groups.length === 8 ? groups : null;
  }
  const left = parseGroups(halves[0]);
  const right = parseGroups(halves[1]);
  if (!left || !right || left.length + right.length > 8) return null;
  return [
    ...left,
    ...new Array(8 - left.length - right.length).fill(0),
    ...right,
  ];
}

function isForbiddenIpv6Client(host: string): boolean {
  const groups = parseIpv6ClientGroups(host);
  if (!groups) return true; // fail closed on malformed IPv6 literals
  if (groups.every((group) => group === 0)) return true;
  if (
    groups.slice(0, 7).every((group) => group === 0) &&
    groups[7] === 1
  ) {
    return true;
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((group) => group === 0);
  if (mapped || compatible) {
    const octets = [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ];
    return isPrivateIpv4Client(octets.join('.'));
  }
  return false;
}

export function validateSiemUrlClient(raw: string): {
  ok: boolean;
  error?: string;
  code?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'SIEM Webhook URL を入力してください',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'SIEM Webhook URL は絶対 URL で指定してください',
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'SIEM Webhook URL は https: のみ許可されます',
    };
  }
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return {
      ok: false,
      code: 'SIEM_WEBHOOK_URL_FORBIDDEN',
      error: 'localhost / *.local / *.internal は指定できません',
    };
  }
  if (PRIVATE_IPV4_PARTS.has(Number(host.split('.')[0])) && isPrivateIpv4Client(host)) {
    return {
      ok: false,
      code: 'SIEM_WEBHOOK_URL_FORBIDDEN',
      error: 'プライベート / ループバック / リンクローカル IP は指定できません',
    };
  }
  if (host.includes(':')) {
    if (isForbiddenIpv6Client(host)) {
      return {
        ok: false,
        code: 'SIEM_WEBHOOK_URL_FORBIDDEN',
        error: 'プライベート / ループバック / リンクローカル IPv6 は指定できません',
      };
    }
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'URL に認証情報を埋め込まないでください',
    };
  }
  return { ok: true };
}

export const SIEM_EVENT_CATEGORY_OPTIONS = [
  { value: 'security_blocked', label: 'セキュリティブロック' },
  { value: 'admin_mutation', label: '管理者による変更' },
] as const;

export function readSiemEvents(events: string[] | null | undefined): string[] {
  if (!Array.isArray(events)) {
    return ['security_blocked', 'admin_mutation'];
  }
  return events.filter((event): event is string => typeof event === 'string');
}
