import type { Context } from 'hono';
import type { AuthUser, UserRole } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { sha256Hex } from './crypto-utils';

/**
 * P12-3 / TOM-66 IP allowlist engine.
 *
 * The matcher is deliberately dependency-free and tiny: edge Workers execute
 * it on every protected request, so it only allocates one Uint8Array per
 * address and rejects malformed input without backtracking or regex-heavy
 * parsing.
 *
 * Supported input:
 * - IPv4 single address (`203.0.113.10`)
 * - IPv4 CIDR (`203.0.113.0/24`)
 * - IPv6 single address (`2001:db8::1`)
 * - IPv6 CIDR (`2001:db8::/32`)
 * - Bracketed IPv6 (`[2001:db8::1]`)
 * - IPv4-mapped IPv6 (`::ffff:203.0.113.10`) normalized to IPv4
 */

export const IP_ALLOWLIST_MAX_ENTRIES = 200;

export type IpAllowlistScope = 'admin_only' | 'internal_users' | 'all_access';

export const IP_ALLOWLIST_SCOPES: readonly IpAllowlistScope[] = [
  'admin_only',
  'internal_users',
  'all_access',
] as const;

export function isIpAllowlistScope(value: unknown): value is IpAllowlistScope {
  return (
    value === 'admin_only' ||
    value === 'internal_users' ||
    value === 'all_access'
  );
}

type IpFamily = 'ipv4' | 'ipv6';

export interface ParsedIp {
  family: IpFamily;
  bytes: Uint8Array;
}

export interface ParsedIpAllowlistEntry extends ParsedIp {
  prefix: number;
  normalized: string;
}

const IPV4_OCTET_RE = /^\d{1,3}$/;
const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
const PREFIX_RE = /^\d{1,3}$/;

function stripBrackets(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return trimmed;
  const closing = trimmed.indexOf(']');
  if (closing < 0) return trimmed;
  // Accept `[2001:db8::1]` and `[2001:db8::1]:443`; the port is irrelevant to
  // the address match but accepting it keeps proxy-style headers usable.
  const suffix = trimmed.slice(closing + 1);
  if (suffix && suffix !== ':' && !/^:\d{1,5}$/.test(suffix)) {
    return trimmed;
  }
  return trimmed.slice(1, closing);
}

function parseIpv4Bytes(raw: string): Uint8Array | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!IPV4_OCTET_RE.test(part)) return null;
    // Leading zeros are ambiguous (some parsers treat them as octal) and are
    // not valid in canonical dotted-quad notation.
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6Bytes(raw: string): Uint8Array | null {
  let value = raw;
  if (!value.includes(':')) return null;

  // IPv4-mapped / embedded IPv4 at the tail. Convert it to two hex groups so
  // the rest of the parser only deals with hex groups.
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
    return groups.every((group) => IPV6_GROUP_RE.test(group)) ? groups : null;
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

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = Number.parseInt(groups[i]!, 16);
    bytes[i * 2] = (group >> 8) & 0xff;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/**
 * Converts raw 16-byte IPv6 values to an IPv4 representation when they are
 * IPv4-mapped (`::ffff:a.b.c.d`). IPv4-compatible forms such as `::1` are left
 * as IPv6: `::1` is the IPv6 loopback, not `0.0.0.1`.
 */
function normalizeIpv6Bytes(bytes: Uint8Array): ParsedIp {
  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { family: 'ipv4', bytes: bytes.slice(12) };
  }
  return { family: 'ipv6', bytes };
}

/** Parses an unbracketed IP address and normalizes IPv4-mapped IPv6 to IPv4. */
export function parseIp(raw: string): ParsedIp | null {
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

function formatIpv4(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
  }

  // Compress the longest run (minimum length 2) of zero groups, RFC 5952.
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

export function formatIp(parsed: ParsedIp): string {
  return parsed.family === 'ipv4'
    ? formatIpv4(parsed.bytes)
    : formatIpv6(parsed.bytes);
}

/**
 * Parses an IPv4-mapped IPv6 prefix. Prefixes below /96 describe non-mapped
 * IPv4 space and cannot be represented as an IPv4 allowlist entry.
 */
function prefixFromMappedIpv6(prefixPart: string | null): number | null {
  if (prefixPart === null) return 32;
  if (!PREFIX_RE.test(prefixPart)) return null;
  if (prefixPart.length > 1 && prefixPart.startsWith('0')) return null;
  const prefix = Number(prefixPart);
  if (prefix < 96 || prefix > 128) return null;
  return prefix - 96;
}

/**
 * Parses one allowlist entry. The normalized form is canonical so duplicate
 * IPv6 spellings cannot silently bypass the 200-entry cap.
 */
export function parseIpAllowlistEntry(
  raw: unknown
): ParsedIpAllowlistEntry | null {
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
    : parseIp(rawAddress);
  if (!address) return null;

  // A mapped IPv6 CIDR keeps its IPv6 prefix semantics (`/120` == IPv4 `/24`).
  // Prefixes below /96 describe non-mapped IPv4 space and cannot be represented
  // as an IPv4 allowlist entry.
  const normalizedPrefix =
    rawIpv6 && address.family === 'ipv4' ? prefixFromMappedIpv6(prefixPart) : null;
  if (rawIpv6 && address.family === 'ipv4' && normalizedPrefix === null) {
    return null;
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
  if (normalizedPrefix !== null) prefix = normalizedPrefix;

  return {
    ...address,
    prefix,
    // Preserve an explicitly supplied prefix (`/32`, `/128`) but keep plain
    // single-address entries in dotted/compressed notation.
    normalized:
      prefixPart !== null
        ? `${formatIp(address)}/${prefix}`
        : formatIp(address),
  };
}

export function isValidIpAllowlistEntry(raw: unknown): boolean {
  return parseIpAllowlistEntry(raw) !== null;
}

function bytesInPrefix(
  candidate: Uint8Array,
  network: Uint8Array,
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

/** True when `ip` is inside the already-parsed allowlist entry. */
export function ipMatchesEntry(
  ip: ParsedIp,
  entry: ParsedIpAllowlistEntry
): boolean {
  if (ip.family !== entry.family) return false;
  return bytesInPrefix(ip.bytes, entry.bytes, entry.prefix);
}

/** Matches a single client IP against JSON/array entries. Fails closed. */
export function isIpAllowed(
  ip: string,
  entries: readonly string[]
): boolean {
  const parsedIp = parseIp(ip);
  if (!parsedIp) return false;
  for (const entry of entries) {
    const parsedEntry = parseIpAllowlistEntry(entry);
    if (parsedEntry && ipMatchesEntry(parsedIp, parsedEntry)) return true;
  }
  return false;
}

export type IpAllowlistValidation =
  | { ok: true; entries: string[] }
  | { ok: false; invalidEntries: string[]; maxEntries: number };

/** Validates, canonicalizes and de-duplicates administrator input. */
export function normalizeIpAllowlistInput(
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

/** Reads the stored JSON column, dropping corrupt/invalid entries defensively. */
export function parseIpAllowlistJson(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const entry = parseIpAllowlistEntry(item);
    if (!entry || seen.has(entry.normalized)) continue;
    seen.add(entry.normalized);
    entries.push(entry.normalized);
  }
  return entries;
}

export interface IpAllowlistPolicy {
  enabled: boolean;
  scope: IpAllowlistScope;
  entries: string[];
}

export const DEFAULT_IP_ALLOWLIST_POLICY: IpAllowlistPolicy = {
  enabled: false,
  scope: 'admin_only',
  entries: [],
};

export async function loadIpAllowlistPolicy(
  db: D1Database,
  tenantId: string
): Promise<IpAllowlistPolicy> {
  const row = await db
    .prepare(
      `SELECT ip_allowlist_enabled, ip_allowlist_scope, ip_allowlist_json
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<{
      ip_allowlist_enabled: number | null;
      ip_allowlist_scope: string | null;
      ip_allowlist_json: string | null;
    }>();
  if (!row) return { ...DEFAULT_IP_ALLOWLIST_POLICY, entries: [] };
  return {
    enabled: row.ip_allowlist_enabled === 1,
    scope: isIpAllowlistScope(row.ip_allowlist_scope)
      ? row.ip_allowlist_scope
      : DEFAULT_IP_ALLOWLIST_POLICY.scope,
    entries: parseIpAllowlistJson(row.ip_allowlist_json),
  };
}

type IpHeaderContext = {
  env: Pick<OidcHonoEnv['Bindings'], 'ENVIRONMENT'>;
  req: { header: (name: string) => string | undefined };
};

/**
 * Resolves the caller IP. `CF-Connecting-IP` is authoritative; the
 * `X-Forwarded-For` fallback exists only for the local Wrangler/Next proxy,
 * where Cloudflare does not inject the header.
 */
export function resolveClientIp(c: IpHeaderContext): string {
  const cfConnectingIp = c.req.header('CF-Connecting-IP')?.trim();
  if (cfConnectingIp) return stripBrackets(cfConnectingIp);

  if (c.env.ENVIRONMENT === 'local') {
    const forwarded = c.req.header('X-Forwarded-For');
    const first = forwarded?.split(',')[0]?.trim();
    if (first) return stripBrackets(first);
  }

  return '127.0.0.1';
}

export type IpAllowlistRequestKind =
  | 'admin'
  | 'internal_auth'
  | 'sync_ws'
  | 'member'
  | 'guest_session'
  | 'guest_auth'
  | 'public_share'
  | 'file_request';

interface IpAllowlistSubject {
  kind: IpAllowlistRequestKind;
  user: Pick<AuthUser, 'id' | 'email' | 'role' | 'userType'> | null;
}

function isAdminRole(role: UserRole | undefined): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

/**
 * Scope-to-request decision. Admin-role sessions are checked by every scope:
 * `admin_only` must not become a loophole for administrators using a normal
 * workspace route.
 */
export function ipAllowlistScopeApplies(
  policy: Pick<IpAllowlistPolicy, 'scope'>,
  subject: IpAllowlistSubject
): boolean {
  if (subject.kind === 'admin') return true;
  if (isAdminRole(subject.user?.role)) return true;

  switch (policy.scope) {
    case 'admin_only':
      return false;
    case 'internal_users':
      return (
        subject.kind === 'internal_auth' ||
        subject.kind === 'sync_ws' ||
        subject.kind === 'member'
      );
    case 'all_access':
      return true;
    default:
      return false;
  }
}

export function classifyAuthenticatedRequest(
  path: string,
  user: Pick<AuthUser, 'userType'>
): IpAllowlistRequestKind {
  if (
    path === '/api/admin' ||
    path.startsWith('/api/admin/') ||
    path === '/api/audit-logs' ||
    path.startsWith('/api/audit-logs/')
  ) {
    return 'admin';
  }
  if (path.startsWith('/api/s/')) return 'public_share';
  if (path.startsWith('/api/fr/')) return 'file_request';
  if (path.startsWith('/auth/guest/')) return 'guest_auth';
  if (
    path === '/auth/dev-login' ||
    path === '/auth/login' ||
    path === '/auth/callback'
  ) {
    return 'internal_auth';
  }
  if (path === '/api/sync/ws') return 'sync_ws';
  return user.userType === 'guest' ? 'guest_session' : 'member';
}

function authAuditTargetId(path: string): string {
  return path.split('?', 1)[0] || path;
}

async function recordIpBlockedAudit(
  db: D1Database,
  params: {
    tenantId: string;
    subject: IpAllowlistSubject;
    ip: string;
    policy: IpAllowlistPolicy;
    path: string;
    method: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action,
         target_type, target_id, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, 'auth.ip_blocked', 'auth', ?, 'blocked', ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      params.tenantId,
      params.subject.user?.id ?? null,
      params.subject.user?.email ?? null,
      params.ip,
      authAuditTargetId(params.path),
      JSON.stringify({
        ip: params.ip,
        scope: params.policy.scope,
        requestKind: params.subject.kind,
        method: params.method,
        path: authAuditTargetId(params.path),
      }),
      new Date().toISOString()
    )
    .run();
}

export function ipNotAllowedResponse(
  c: Context<OidcHonoEnv>,
  ip: string
): Response {
  return c.json(
    {
      error: 'Access from this IP address is not allowed',
      code: 'IP_NOT_ALLOWED',
      ip,
    },
    403
  );
}

/**
 * Central enforcement used by authenticated routes, public token routes and
 * login flows. `kind` is explicit so anonymous public access never has to
 * guess an identity.
 */
export async function enforceIpAllowlistForTenant(
  c: Context<OidcHonoEnv>,
  params: {
    tenantId: string;
    kind: IpAllowlistRequestKind;
    user?: Pick<AuthUser, 'id' | 'email' | 'role' | 'userType'> | null;
  }
): Promise<Response | null> {
  const policy = await loadIpAllowlistPolicy(c.env.DB, params.tenantId);
  if (!policy.enabled) return null;

  const subject: IpAllowlistSubject = {
    kind: params.kind,
    user: params.user ?? null,
  };
  if (!ipAllowlistScopeApplies(policy, subject)) return null;

  const ip = resolveClientIp(c);
  if (isIpAllowed(ip, policy.entries)) return null;

  await recordIpBlockedAudit(c.env.DB, {
    tenantId: params.tenantId,
    subject,
    ip,
    policy,
    path: new URL(c.req.url).pathname,
    method: c.req.method,
  });
  return ipNotAllowedResponse(c, ip);
}

/** Authenticated-request enforcement (called from sessionAuthMiddleware). */
export async function enforceSessionIpAllowlist(
  c: Context<OidcHonoEnv>,
  user: AuthUser
): Promise<Response | null> {
  const path = new URL(c.req.url).pathname;
  return enforceIpAllowlistForTenant(c, {
    tenantId: user.tenantId,
    kind: classifyAuthenticatedRequest(path, user),
    user,
  });
}

async function loadTenantIdForHash(
  db: D1Database,
  table: 'shared_links' | 'file_requests',
  rawToken: string | undefined
): Promise<string | null> {
  if (!rawToken || rawToken.length < 16) return null;
  const row = await db
    .prepare(`SELECT tenant_id FROM ${table} WHERE token_hash = ?`)
    .bind(await sha256Hex(rawToken))
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

/** `/api/s/:token` all_access enforcement. Invalid tokens fall through to 404. */
export async function enforcePublicShareIpAllowlist(
  c: Context<OidcHonoEnv>
): Promise<Response | null> {
  const tenantId = await loadTenantIdForHash(
    c.env.DB,
    'shared_links',
    c.req.param('token')
  );
  if (!tenantId) return null;
  return enforceIpAllowlistForTenant(c, {
    tenantId,
    kind: 'public_share',
    user: c.get('user'),
  });
}

/** `/api/fr/:token` all_access enforcement. */
export async function enforceFileRequestIpAllowlist(
  c: Context<OidcHonoEnv>
): Promise<Response | null> {
  const tenantId = await loadTenantIdForHash(
    c.env.DB,
    'file_requests',
    c.req.param('token')
  );
  if (!tenantId) return null;
  return enforceIpAllowlistForTenant(c, {
    tenantId,
    kind: 'file_request',
    user: c.get('user'),
  });
}

interface GuestTenantLookup {
  token?: string;
  email?: string;
  tenantId?: string;
}

/**
 * `/auth/guest/*` tenant resolution without consuming tokens. The helper only
 * reads rows; the actual guest route remains responsible for validation and
 * single-use consumption.
 */
export async function resolveGuestAuthTenantId(
  db: D1Database,
  lookup: GuestTenantLookup
): Promise<string | null> {
  if (lookup.tenantId?.trim()) return lookup.tenantId.trim();

  if (lookup.token && lookup.token.length >= 16) {
    const row = await db
      .prepare('SELECT tenant_id FROM guest_invitations WHERE token_hash = ?')
      .bind(await sha256Hex(lookup.token))
      .first<{ tenant_id: string }>();
    if (row?.tenant_id) return row.tenant_id;
  }

  const email = lookup.email?.trim().toLowerCase();
  if (email) {
    const guest = await db
      .prepare(
        `SELECT tenant_id FROM users
          WHERE email = ? AND user_type = 'guest'
          ORDER BY created_at DESC, id ASC LIMIT 1`
      )
      .bind(email)
      .first<{ tenant_id: string }>();
    if (guest?.tenant_id) return guest.tenant_id;

    const challenge = await db
      .prepare(
        `SELECT tenant_id FROM guest_otp_challenges
          WHERE email = ?
          ORDER BY created_at DESC LIMIT 1`
      )
      .bind(email)
      .first<{ tenant_id: string }>();
    if (challenge?.tenant_id) return challenge.tenant_id;
  }

  return null;
}
