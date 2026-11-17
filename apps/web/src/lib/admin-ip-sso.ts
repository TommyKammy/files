import type {
  AdminIpAllowlistScope,
  TenantPolicyRow,
  UserRole,
} from '@/types/files';

/**
 * P12-3 / TOM-66 pure helpers shared by the admin auth-control UI and its
 * unit tests. Validation intentionally mirrors the Worker API so the form
 * rejects the same malformed CIDRs and domains before a round trip.
 */

export const IP_ALLOWLIST_MAX_ENTRIES = 200;

export const IP_ALLOWLIST_SCOPE_OPTIONS: readonly AdminIpAllowlistScope[] = [
  'admin_only',
  'internal_users',
  'all_access',
] as const;

export const IP_ALLOWLIST_SCOPE_META: Record<
  AdminIpAllowlistScope,
  { label: string; description: string }
> = {
  admin_only: {
    label: '管理者のみ',
    description:
      '管理 API・監査ログと sys_admin / sec_admin のアクセスだけを制限します。一般メンバーのワークスペース利用は妨げません。',
  },
  internal_users: {
    label: '社内ユーザー全体',
    description:
      '管理者に加えて全メンバーのセッション、ログイン、リアルタイム同期を制限します。ゲストと公開共有リンクは対象外です。',
  },
  all_access: {
    label: 'すべてのアクセス',
    description:
      'ゲストセッション、ゲスト招待/OIDC 認証、公開共有リンク、ファイルリクエストを含むテナント境界全体を制限します。',
  },
};

export const SSO_ALLOWED_DOMAIN_MAX_LENGTH = 253;

const IPV4_OCTET_RE = /^\d{1,3}$/;
const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
const PREFIX_RE = /^\d{1,3}$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ParsedIpAddress {
  family: 'ipv4' | 'ipv6';
  bytes: number[];
}

export interface ParsedIpEntry extends ParsedIpAddress {
  prefix: number;
  normalized: string;
}

function stripBrackets(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return trimmed;
  const closing = trimmed.indexOf(']');
  if (closing < 0) return trimmed;
  const suffix = trimmed.slice(closing + 1);
  if (suffix && suffix !== ':' && !/^:\d{1,5}$/.test(suffix)) return trimmed;
  return trimmed.slice(1, closing);
}

function parseIpv4Bytes(raw: string): number[] | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET_RE.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6Bytes(raw: string): number[] | null {
  let value = raw;
  if (!value.includes(':')) return null;

  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4Bytes(tail);
    if (!v4) return null;
    const high = ((v4[0]! << 8) | v4[1]!).toString(16);
    const low = ((v4[2]! << 8) | v4[3]!).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColonIndex = value.indexOf('::');
  if (doubleColonIndex !== value.lastIndexOf('::')) return null;

  const splitGroups = (part: string): string[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    return groups.every((group) => IPV6_GROUP_RE.test(group))
      ? groups
      : null;
  };

  let groups: string[];
  if (doubleColonIndex >= 0) {
    const left = splitGroups(value.slice(0, doubleColonIndex));
    const right = splitGroups(value.slice(doubleColonIndex + 2));
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  } else {
    const parsed = splitGroups(value);
    if (!parsed || parsed.length !== 8) return null;
    groups = parsed;
  }

  const bytes: number[] = [];
  for (const group of groups) {
    const valueGroup = Number.parseInt(group, 16);
    bytes.push((valueGroup >> 8) & 0xff, valueGroup & 0xff);
  }
  return bytes;
}

function normalizeIpv6Bytes(bytes: number[]): ParsedIpAddress {
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0);
  if (mapped && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { family: 'ipv4', bytes: bytes.slice(12) };
  }
  return { family: 'ipv6', bytes };
}

export function parseIpAddress(raw: string): ParsedIpAddress | null {
  const value = stripBrackets(raw);
  if (!value || /\s/.test(value) || value.includes('%') || value.includes('/')) {
    return null;
  }
  if (!value.includes(':')) {
    const bytes = parseIpv4Bytes(value);
    return bytes ? { family: 'ipv4', bytes } : null;
  }
  const bytes = parseIpv6Bytes(value);
  return bytes ? normalizeIpv6Bytes(bytes) : null;
}

function formatIpv4(bytes: number[]): string {
  return bytes.join('.');
}

function formatIpv6(bytes: number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
  }

  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === 0) {
      if (currentStart < 0) currentStart = i;
      currentLength += 1;
    } else {
      if (currentLength > bestLength) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
      currentStart = -1;
      currentLength = 0;
    }
  }
  if (currentLength > bestLength) {
    bestStart = currentStart;
    bestLength = currentLength;
  }

  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex
    .slice(bestStart + bestLength)
    .join(':')}`;
}

function formatIp(parsed: ParsedIpAddress): string {
  return parsed.family === 'ipv4'
    ? formatIpv4(parsed.bytes)
    : formatIpv6(parsed.bytes);
}

export function parseIpAllowlistEntry(raw: unknown): ParsedIpEntry | null {
  if (typeof raw !== 'string') return null;
  const value = stripBrackets(raw);
  if (!value) return null;

  const slash = value.indexOf('/');
  if (slash !== -1 && slash !== value.lastIndexOf('/')) return null;

  const addressPart = slash === -1 ? value : value.slice(0, slash);
  const prefixPart = slash === -1 ? null : value.slice(slash + 1);
  const rawAddress = stripBrackets(addressPart);
  const rawIpv6 = rawAddress.includes(':')
    ? parseIpv6Bytes(rawAddress)
    : null;
  const address = rawIpv6
    ? normalizeIpv6Bytes(rawIpv6)
    : parseIpAddress(rawAddress);
  if (!address) return null;

  let mappedPrefix: number | null = null;
  if (rawIpv6 && address.family === 'ipv4') {
    if (prefixPart === null) {
      mappedPrefix = 32;
    } else if (PREFIX_RE.test(prefixPart) && !(prefixPart.length > 1 && prefixPart.startsWith('0'))) {
      const prefix = Number(prefixPart);
      if (prefix >= 96 && prefix <= 128) mappedPrefix = prefix - 96;
    }
    if (mappedPrefix === null) return null;
  }

  const maxPrefix = address.family === 'ipv4' ? 32 : 128;
  let prefix = maxPrefix;
  if (prefixPart !== null) {
    if (!PREFIX_RE.test(prefixPart)) return null;
    if (prefixPart.length > 1 && prefixPart.startsWith('0')) return null;
    prefix = Number(prefixPart);
    const declaredMaxPrefix = rawIpv6 ? 128 : maxPrefix;
    if (prefix > declaredMaxPrefix) return null;
  }
  if (mappedPrefix !== null) prefix = mappedPrefix;

  return {
    ...address,
    prefix,
    normalized:
      prefixPart !== null
        ? `${formatIp(address)}/${prefix}`
        : formatIp(address),
  };
}

export function isValidIpOrCidr(raw: unknown): boolean {
  return parseIpAllowlistEntry(raw) !== null;
}

function bytesInPrefix(
  candidate: number[],
  network: number[],
  prefix: number
): boolean {
  const fullBytes = Math.floor(prefix / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (candidate[i] !== network[i]) return false;
  }
  const remainder = prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (
    (candidate[fullBytes]! & mask) === (network[fullBytes]! & mask)
  );
}

export function ipMatchesAllowlistEntry(
  ip: ParsedIpAddress,
  entry: ParsedIpEntry
): boolean {
  return (
    ip.family === entry.family &&
    bytesInPrefix(ip.bytes, entry.bytes, entry.prefix)
  );
}

export function isIpAllowedByList(
  ip: string,
  entries: readonly string[]
): boolean {
  const parsedIp = parseIpAddress(ip);
  if (!parsedIp) return false;
  return entries.some((entry) => {
    const parsedEntry = parseIpAllowlistEntry(entry);
    return parsedEntry ? ipMatchesAllowlistEntry(parsedIp, parsedEntry) : false;
  });
}

export type IpAllowlistValidation =
  | { ok: true; entries: string[] }
  | { ok: false; invalidEntries: string[]; maxEntries: number };

export function validateIpAllowlistInput(
  value: unknown
): IpAllowlistValidation {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      invalidEntries: ['<not-an-array>'],
      maxEntries: IP_ALLOWLIST_MAX_ENTRIES,
    };
  }

  const entries: string[] = [];
  const seen = new Set<string>();
  const invalidEntries: string[] = [];

  for (const item of value) {
    const parsed = parseIpAllowlistEntry(item);
    if (!parsed) {
      invalidEntries.push(typeof item === 'string' ? item : String(item));
      continue;
    }
    if (!seen.has(parsed.normalized)) {
      seen.add(parsed.normalized);
      entries.push(parsed.normalized);
    }
  }

  if (invalidEntries.length > 0 || entries.length > IP_ALLOWLIST_MAX_ENTRIES) {
    return {
      ok: false,
      invalidEntries,
      maxEntries: IP_ALLOWLIST_MAX_ENTRIES,
    };
  }
  return { ok: true, entries };
}

export function readIpAllowlistEnabled(policy: TenantPolicyRow | null): boolean {
  if (!policy) return false;
  if (typeof policy.ipAllowlistEnabled === 'boolean') {
    return policy.ipAllowlistEnabled;
  }
  return policy.ip_allowlist_enabled === 1;
}

export function readIpAllowlistScope(
  policy: TenantPolicyRow | null
): AdminIpAllowlistScope {
  if (!policy) return 'admin_only';
  const scope = policy.ipAllowlistScope ?? policy.ip_allowlist_scope;
  return scope === 'internal_users' || scope === 'all_access'
    ? scope
    : 'admin_only';
}

export function readIpAllowlist(policy: TenantPolicyRow | null): string[] {
  if (!policy) return [];
  if (Array.isArray(policy.ipAllowlist)) {
    const validation = validateIpAllowlistInput(policy.ipAllowlist);
    return validation.ok
      ? validation.entries
      : policy.ipAllowlist.filter((entry) => isValidIpOrCidr(entry));
  }
  if (typeof policy.ip_allowlist_json !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(policy.ip_allowlist_json);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is string =>
            typeof entry === 'string' && isValidIpOrCidr(entry)
        )
      : [];
  } catch {
    return [];
  }
}

export function readRequireSsoLogin(policy: TenantPolicyRow | null): boolean {
  if (!policy) return false;
  if (typeof policy.requireSsoLogin === 'boolean') return policy.requireSsoLogin;
  return policy.require_sso_login === 1;
}

export function readSsoAllowedDomains(policy: TenantPolicyRow | null): string[] {
  if (!policy) return [];
  if (Array.isArray(policy.ssoAllowedDomains)) return policy.ssoAllowedDomains;
  if (typeof policy.sso_allowed_domains_json !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(policy.sso_allowed_domains_json);
    return Array.isArray(parsed)
      ? parsed.filter((domain): domain is string => typeof domain === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Lowercases/trims a single domain. Wildcards and URLs return null. */
export function normalizeSsoDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('@')) value = value.slice(1);
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (!value || value.length > SSO_ALLOWED_DOMAIN_MAX_LENGTH) return null;
  if (value.includes('*')) return null;
  if (value.includes('/') || value.includes(':') || value.includes('@')) {
    return null;
  }
  const labels = value.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => DOMAIN_LABEL_RE.test(label))) return null;
  return value;
}

export type SsoDomainValidation =
  | { ok: true; domains: string[] }
  | { ok: false; invalidDomains: string[]; wildcardDomains: string[] };

export function validateSsoAllowedDomains(
  value: unknown
): SsoDomainValidation {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      invalidDomains: ['<not-an-array>'],
      wildcardDomains: [],
    };
  }

  const domains: string[] = [];
  const seen = new Set<string>();
  const invalidDomains: string[] = [];
  const wildcardDomains: string[] = [];

  for (const item of value) {
    const raw = typeof item === 'string' ? item.trim() : '';
    if (raw.includes('*')) {
      wildcardDomains.push(raw || '*');
      continue;
    }
    const domain = normalizeSsoDomain(item);
    if (!domain) {
      invalidDomains.push(typeof item === 'string' ? item : String(item));
      continue;
    }
    if (!seen.has(domain)) {
      seen.add(domain);
      domains.push(domain);
    }
  }

  if (invalidDomains.length > 0 || wildcardDomains.length > 0) {
    return { ok: false, invalidDomains, wildcardDomains };
  }
  return { ok: true, domains: domains.sort() };
}

/** sys_admin writes; sec_admin keeps read-only visibility. */
export function canManageAuthControls(role: UserRole | null | undefined): boolean {
  return role === 'sys_admin';
}

export function describeAuthControlError(
  code: string | undefined,
  message: string,
  details?: Record<string, unknown>
): string {
  if (code === 'SELF_IP_LOCKOUT_PREVENTED') {
    const ip = typeof details?.ip === 'string' ? details.ip : '不明';
    return `自己ロックアウトを防止しました (SELF_IP_LOCKOUT_PREVENTED): 現在の接続元 IP (${ip}) が許可リストに含まれていないため保存できません。`;
  }
  if (code === 'INVALID_IP_ALLOWLIST_ENTRY') {
    return `IP アドレス / CIDR の形式が不正です (INVALID_IP_ALLOWLIST_ENTRY): ${message}`;
  }
  if (code === 'INVALID_SSO_DOMAIN') {
    return `SSO 許可ドメインが不正です (INVALID_SSO_DOMAIN): ${message}`;
  }
  return message;
}
