export interface TenantBranding {
  orgName: string | null;
  contactInfo: string | null;
  footerNote: string | null;
}

export const EMPTY_TENANT_BRANDING: TenantBranding = {
  orgName: null,
  contactInfo: null,
  footerNote: null,
};

export interface TenantBrandingRow {
  branding_org_name: string | null;
  branding_contact_info: string | null;
  branding_footer_note: string | null;
}

export const BRANDING_ORG_NAME_MAX_LENGTH = 120;
export const BRANDING_CONTACT_INFO_MAX_LENGTH = 500;
export const BRANDING_FOOTER_NOTE_MAX_LENGTH = 500;

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

export function projectTenantBranding(
  row: TenantBrandingRow | null | undefined
): TenantBranding {
  return {
    orgName: row?.branding_org_name?.trim() || null,
    contactInfo: row?.branding_contact_info?.trim() || null,
    footerNote: row?.branding_footer_note?.trim() || null,
  };
}

export async function loadTenantBranding(
  db: D1Database,
  tenantId: string
): Promise<TenantBranding> {
  const row = await db
    .prepare(
      `SELECT branding_org_name, branding_contact_info, branding_footer_note
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<TenantBrandingRow>();
  return projectTenantBranding(row);
}
