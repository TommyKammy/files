/**
 * P12-3 / TOM-66 OIDC SSO policy helpers.
 *
 * Domains are exact-match email domains: a wildcard would silently widen the
 * policy to every subdomain, so `*` is rejected by the API and the admin UI.
 */

export const SSO_ALLOWED_DOMAIN_MAX_LENGTH = 253;

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Lowercases, trims and removes a leading `@`. Returns null for anything that
 * is not a plain domain (scheme, path, wildcard, bare label, IP address...).
 */
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

/** Validates and de-duplicates administrator input. */
export function normalizeSsoAllowedDomainsInput(
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

export function parseSsoAllowedDomainsJson(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const domains: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const domain = normalizeSsoDomain(item);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains.sort();
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeSsoDomain(email.slice(at + 1));
}

/**
 * Empty allowlists intentionally allow every IdP-verified domain (the legacy
 * behaviour). A non-empty list requires an exact domain match.
 */
export function isSsoEmailDomainAllowed(
  email: string,
  allowedDomains: readonly string[]
): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = emailDomain(email);
  if (!domain) return false;
  return allowedDomains.includes(domain);
}

export interface SsoPolicy {
  requireSsoLogin: boolean;
  allowedDomains: string[];
}

export const DEFAULT_SSO_POLICY: SsoPolicy = {
  requireSsoLogin: false,
  allowedDomains: [],
};

export async function loadSsoPolicy(
  db: D1Database,
  tenantId: string
): Promise<SsoPolicy> {
  const row = await db
    .prepare(
      `SELECT require_sso_login, sso_allowed_domains_json
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<{
      require_sso_login: number | null;
      sso_allowed_domains_json: string | null;
    }>();
  if (!row) return { ...DEFAULT_SSO_POLICY, allowedDomains: [] };
  return {
    requireSsoLogin: row.require_sso_login === 1,
    allowedDomains: parseSsoAllowedDomainsJson(row.sso_allowed_domains_json),
  };
}

/**
 * Never return a full OIDC client id from the status endpoint. Short ids are
 * masked completely; longer ids keep only enough prefix/suffix to recognize
 * the configured application.
 */
export function maskOidcClientId(clientId: string): string {
  const value = clientId.trim();
  if (!value) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
