import { Hono } from 'hono';
import { buildAuditLogStmt } from '../services/audit';
import { getAuthenticatedUser } from '../services/authorization';
import {
  BRANDING_LOGO_MAX_BYTES,
  buildBrandingLogoUrl,
  detectSafeBrandingLogoMime,
  type SafeBrandingLogoMime,
} from '../services/branding';
import { buildSyncChangeStmt } from '../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../services/sync-notifier';
import type { OidcHonoEnv } from '../types/oidc';

const ALLOWED_SERVED_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

async function readUploadedLogoBytes(c: {
  req: {
    header: (name: string) => string | undefined;
    formData: () => Promise<FormData>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
}): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413; error: string; code: string }> {
  const contentLengthRaw = c.req.header('Content-Length');
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > BRANDING_LOGO_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        error: 'Logo file exceeds 512 KiB limit',
        code: 'LOGO_TOO_LARGE',
      };
    }
  }

  const contentType = (c.req.header('Content-Type') ?? '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return {
        ok: false,
        status: 400,
        error: 'Invalid multipart form data',
        code: 'INVALID_MULTIPART',
      };
    }

    let fileEntry: File | null = null;
    const named = formData.get('logo') ?? formData.get('file');
    if (named && typeof named === 'object' && 'arrayBuffer' in named) {
      fileEntry = named as File;
    } else {
      for (const value of formData.values()) {
        if (value && typeof value === 'object' && 'arrayBuffer' in value) {
          fileEntry = value as File;
          break;
        }
      }
    }

    if (!fileEntry) {
      return {
        ok: false,
        status: 400,
        error: 'No logo file provided in multipart payload',
        code: 'MISSING_LOGO_FILE',
      };
    }

    if (fileEntry.size > BRANDING_LOGO_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        error: 'Logo file exceeds 512 KiB limit',
        code: 'LOGO_TOO_LARGE',
      };
    }

    const buf = await fileEntry.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buf) };
  }

  const buf = await c.req.arrayBuffer();
  return { ok: true, bytes: new Uint8Array(buf) };
}

export function registerAdminBrandingRoutes(adminRoutes: Hono<OidcHonoEnv>) {
  adminRoutes.post('/branding/logo', async (c) => {
    const user = getAuthenticatedUser(c);
    const read = await readUploadedLogoBytes(c);
    if (!read.ok) {
      return c.json({ error: read.error, code: read.code }, read.status);
    }

    const { bytes } = read;
    if (bytes.byteLength === 0) {
      return c.json({ error: 'Logo file is empty', code: 'EMPTY_LOGO' }, 400);
    }
    if (bytes.byteLength > BRANDING_LOGO_MAX_BYTES) {
      return c.json(
        { error: 'Logo file exceeds 512 KiB limit', code: 'LOGO_TOO_LARGE' },
        413
      );
    }

    const detectedMime: SafeBrandingLogoMime | null =
      detectSafeBrandingLogoMime(bytes);
    if (!detectedMime) {
      return c.json(
        {
          error: 'Only PNG, JPEG, or WebP images are allowed',
          code: 'INVALID_LOGO_FORMAT',
        },
        400
      );
    }

    const r2Key = `branding/${user.tenantId}/logo`;
    await c.env.BUCKET.put(r2Key, bytes, {
      httpMetadata: {
        contentType: detectedMime,
      },
    });

    const nowIso = new Date().toISOString();
    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id, updated_by, updated_at)
         VALUES (?, ?, ?)`
      ).bind(user.tenantId, user.id, nowIso),
      c.env.DB.prepare(
        `UPDATE tenant_policies
            SET branding_logo_r2_key = ?,
                updated_by = ?,
                updated_at = ?
          WHERE tenant_id = ?`
      ).bind(r2Key, user.id, nowIso, user.tenantId),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'branding.logo_upload',
        targetType: 'tenant_policy',
        targetId: user.tenantId,
        metadata: {
          r2Key,
          contentType: detectedMime,
          sizeBytes: bytes.byteLength,
        },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'policy',
        entityId: user.tenantId,
        action: 'admin.policy_updated',
        payload: {
          updatedFields: ['brandingLogoR2Key'],
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    const syncSeq = extractLastSyncSeq(batchResults);
    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: syncSeq,
      eventKind: 'admin.policy_updated',
    });

    return c.json({
      ok: true,
      logoUrl: buildBrandingLogoUrl(user.tenantId, r2Key),
      contentType: detectedMime,
      sizeBytes: bytes.byteLength,
    });
  });

  adminRoutes.delete('/branding/logo', async (c) => {
    const user = getAuthenticatedUser(c);
    const existing = await c.env.DB.prepare(
      'SELECT branding_logo_r2_key FROM tenant_policies WHERE tenant_id = ?'
    )
      .bind(user.tenantId)
      .first<{ branding_logo_r2_key: string | null }>();

    const keysToDelete = new Set<string>([`branding/${user.tenantId}/logo`]);
    if (existing?.branding_logo_r2_key?.trim()) {
      keysToDelete.add(existing.branding_logo_r2_key.trim());
    }
    await Promise.all(
      Array.from(keysToDelete).map((key) =>
        c.env.BUCKET.delete(key).catch(() => {})
      )
    );

    const nowIso = new Date().toISOString();
    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tenant_policies
            SET branding_logo_r2_key = NULL,
                updated_by = ?,
                updated_at = ?
          WHERE tenant_id = ?`
      ).bind(user.id, nowIso, user.tenantId),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'branding.logo_delete',
        targetType: 'tenant_policy',
        targetId: user.tenantId,
        metadata: {
          previousKey: existing?.branding_logo_r2_key ?? null,
        },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'policy',
        entityId: user.tenantId,
        action: 'admin.policy_updated',
        payload: {
          updatedFields: ['brandingLogoR2Key'],
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    const syncSeq = extractLastSyncSeq(batchResults);
    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: syncSeq,
      eventKind: 'admin.policy_updated',
    });

    return c.json({ ok: true, logoUrl: null });
  });
}

export const publicBrandingRoutes = new Hono<OidcHonoEnv>();

publicBrandingRoutes.get('/:tenantId/logo', async (c) => {
  const tenantId = c.req.param('tenantId')?.trim() ?? '';
  if (!tenantId || tenantId.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(tenantId)) {
    return c.json({ error: 'Invalid tenant ID', code: 'INVALID_TENANT_ID' }, 400);
  }

  const row = await c.env.DB.prepare(
    'SELECT branding_logo_r2_key FROM tenant_policies WHERE tenant_id = ?'
  )
    .bind(tenantId)
    .first<{ branding_logo_r2_key: string | null }>();

  const r2Key = row?.branding_logo_r2_key?.trim();
  if (!r2Key) {
    return c.json({ error: 'Logo not found', code: 'LOGO_NOT_FOUND' }, 404);
  }

  const object = await c.env.BUCKET.get(r2Key);
  if (!object) {
    return c.json({ error: 'Logo not found', code: 'LOGO_NOT_FOUND' }, 404);
  }

  const rawMime = object.httpMetadata?.contentType ?? '';
  const contentType = ALLOWED_SERVED_MIMES.has(rawMime)
    ? rawMime
    : 'application/octet-stream';

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'public, max-age=300');
  if (typeof object.size === 'number') {
    headers.set('Content-Length', String(object.size));
  }

  return new Response(object.body, {
    status: 200,
    headers,
  });
});
