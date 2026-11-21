export interface TenantBranding {
  orgName: string | null;
  contactInfo: string | null;
  footerNote: string | null;
  logoUrl: string | null;
  accentColor: string | null;
}

export const EMPTY_TENANT_BRANDING: TenantBranding = {
  orgName: null,
  contactInfo: null,
  footerNote: null,
  logoUrl: null,
  accentColor: null,
};

export interface TenantBrandingRow {
  branding_org_name: string | null;
  branding_contact_info: string | null;
  branding_footer_note: string | null;
  branding_logo_r2_key?: string | null;
  branding_accent_color?: string | null;
}

export const BRANDING_ORG_NAME_MAX_LENGTH = 120;
export const BRANDING_CONTACT_INFO_MAX_LENGTH = 500;
export const BRANDING_FOOTER_NOTE_MAX_LENGTH = 500;
export const BRANDING_LOGO_MAX_BYTES = 512 * 1024; // 512 KiB

export type SafeBrandingLogoMime = 'image/png' | 'image/jpeg' | 'image/webp';

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Branding values are stored as plain text and always rendered as React text
 * nodes by the web client. Strip control characters and clamp lengths so a
 * malicious policy value cannot smuggle terminal/newline injection into
 * logs or public surfaces.
 */
export function normalizeBrandingText(
  value: unknown,
  maxLength: number
): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

/**
 * Validate and normalize a `#RRGGBB` hex accent color.
 * Empty string or `null` clears the color.
 */
export function normalizeBrandingAccentColor(
  value: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === '') {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: 'brandingAccentColor must be a #RRGGBB hex string or null',
    };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (!HEX_COLOR_REGEX.test(trimmed)) {
    return {
      ok: false,
      error: 'brandingAccentColor must match #RRGGBB format',
    };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}

export function buildBrandingLogoUrl(
  tenantId: string,
  logoR2Key: string | null | undefined
): string | null {
  if (!logoR2Key?.trim()) return null;
  return `/api/branding/${encodeURIComponent(tenantId)}/logo`;
}

/**
 * Strictly inspect magic bytes to allow only PNG, JPEG, and WebP.
 * Rejects SVG, HTML, XML, or any other format to prevent stored XSS.
 */
export function detectSafeBrandingLogoMime(
  bytes: Uint8Array
): SafeBrandingLogoMime | null {
  if (bytes.length < 12) {
    // JPEG can technically be small, check PNG/JPEG minimum lengths below
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    ) {
      return 'image/jpeg';
    }
    return null;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

export function projectTenantBranding(
  row: TenantBrandingRow | null | undefined,
  tenantId?: string
): TenantBranding {
  const accentNormalized = normalizeBrandingAccentColor(
    row?.branding_accent_color ?? null
  );
  return {
    orgName: row?.branding_org_name?.trim() || null,
    contactInfo: row?.branding_contact_info?.trim() || null,
    footerNote: row?.branding_footer_note?.trim() || null,
    logoUrl: tenantId
      ? buildBrandingLogoUrl(tenantId, row?.branding_logo_r2_key)
      : null,
    accentColor: accentNormalized.ok ? accentNormalized.value : null,
  };
}

export async function loadTenantBranding(
  db: D1Database,
  tenantId: string
): Promise<TenantBranding> {
  const row = await db
    .prepare(
      `SELECT branding_org_name, branding_contact_info, branding_footer_note,
              branding_logo_r2_key, branding_accent_color
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<TenantBrandingRow>();
  return projectTenantBranding(row, tenantId);
}
