import { Hono } from 'hono';
import type { Env } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { timingSafeEqual } from './crypto-utils';
import {
  computeProxyHmacSignature,
  getLocalProxySecret,
  resolveSafeDisposition,
} from './storage-url-signing';

export const storageProxyRoutes = new Hono<OidcHonoEnv>();

async function verifyProxyRequest(
  c: { env: Env; req: { method: string; query: (k: string) => string | undefined } },
  expectedMethod: 'PUT' | 'GET'
): Promise<
  | {
      ok: true;
      objectKey: string;
      tenantId: string;
      maxSizeBytes: number | null;
      disposition: 'inline' | 'attachment';
      filename: string;
      contentType: string;
    }
  | { ok: false; status: 400 | 403; error: string }
> {
  if (c.env.STORAGE_MODE !== 'local_proxy') {
    return { ok: false, status: 403, error: 'Local storage proxy is disabled' };
  }

  const objectKey = c.req.query('key') ?? '';
  const tenantId = c.req.query('tenantId') ?? '';
  const expiresAt = c.req.query('expires') ?? '';
  const maxSizeStr = c.req.query('maxSize') ?? '';
  const dispositionRaw = c.req.query('disposition') ?? '';
  const filename = c.req.query('filename') ?? '';
  const contentType = c.req.query('contentType') ?? '';
  const sig = c.req.query('sig') ?? '';

  if (!objectKey || !tenantId || !expiresAt || !sig) {
    return { ok: false, status: 400, error: 'Missing signed proxy parameters' };
  }
  if (!objectKey.startsWith(`tenants/${tenantId}/`)) {
    return { ok: false, status: 403, error: 'Object key tenant mismatch' };
  }
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
    return { ok: false, status: 403, error: 'Signed proxy URL expired' };
  }

  const expectedSig = await computeProxyHmacSignature(getLocalProxySecret(c.env), {
    method: expectedMethod,
    objectKey,
    tenantId,
    expiresAt,
    maxSizeBytes: maxSizeStr,
    disposition: dispositionRaw,
    filename,
    contentType,
  });
  if (!timingSafeEqual(sig, expectedSig)) {
    return { ok: false, status: 403, error: 'Invalid proxy signature' };
  }

  const maxSizeBytes = maxSizeStr ? Number.parseInt(maxSizeStr, 10) : null;
  const disposition = resolveSafeDisposition(
    dispositionRaw === 'inline' ? 'inline' : 'attachment',
    filename,
    contentType
  );

  return {
    ok: true,
    objectKey,
    tenantId,
    maxSizeBytes: maxSizeBytes !== null && Number.isFinite(maxSizeBytes) ? maxSizeBytes : null,
    disposition,
    filename: filename || objectKey.split('/').pop() || 'file',
    contentType: contentType || 'application/octet-stream',
  };
}

storageProxyRoutes.put('/proxy', async (c) => {
  const verified = await verifyProxyRequest(c, 'PUT');
  if (!verified.ok) {
    return c.json({ error: verified.error }, verified.status);
  }

  const contentLenHeader = c.req.header('Content-Length');
  if (
    verified.maxSizeBytes !== null &&
    contentLenHeader &&
    Number(contentLenHeader) > verified.maxSizeBytes
  ) {
    return c.json({ error: 'Payload exceeds signed max size limit' }, 413);
  }

  const bodyBytes = await c.req.arrayBuffer();
  if (verified.maxSizeBytes !== null && bodyBytes.byteLength > verified.maxSizeBytes) {
    return c.json({ error: 'Payload exceeds signed max size limit' }, 413);
  }

  const stored = await c.env.BUCKET.put(verified.objectKey, bodyBytes, {
    httpMetadata: verified.contentType ? { contentType: verified.contentType } : undefined,
  });

  return c.json(
    {
      ok: true,
      key: verified.objectKey,
      size: bodyBytes.byteLength,
      etag: stored?.etag ?? null,
    },
    200
  );
});

storageProxyRoutes.get('/proxy', async (c) => {
  const verified = await verifyProxyRequest(c, 'GET');
  if (!verified.ok) {
    return c.json({ error: verified.error }, verified.status);
  }

  const object = await c.env.BUCKET.get(verified.objectKey);
  if (!object) {
    return c.json({ error: 'Object not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set(
    'Content-Type',
    verified.contentType || object.httpMetadata?.contentType || 'application/octet-stream'
  );
  headers.set(
    'Content-Disposition',
    `${verified.disposition}; filename*=UTF-8''${encodeURIComponent(verified.filename)}`
  );
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, {
    status: 200,
    headers,
  });
});

storageProxyRoutes.put('/multipart-part', async (c) => {
  if (c.env.STORAGE_MODE !== 'local_proxy') {
    return c.json({ error: 'Local storage proxy is disabled' }, 403);
  }

  const objectKey = c.req.query('key') ?? '';
  const tenantId = c.req.query('tenantId') ?? '';
  const uploadId = c.req.query('uploadId') ?? '';
  const partNumberStr = c.req.query('partNumber') ?? '';
  const maxSizeStr = c.req.query('maxSize') ?? '';
  const expiresAt = c.req.query('expires') ?? '';
  const sig = c.req.query('sig') ?? '';

  if (!objectKey || !tenantId || !uploadId || !partNumberStr || !expiresAt || !sig) {
    return c.json({ error: 'Missing signed multipart parameters' }, 400);
  }
  if (!objectKey.startsWith(`tenants/${tenantId}/`)) {
    return c.json({ error: 'Object key tenant mismatch' }, 403);
  }
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
    return c.json({ error: 'Signed part URL expired' }, 403);
  }

  const expectedSig = await computeProxyHmacSignature(getLocalProxySecret(c.env), {
    method: 'PUT_PART',
    objectKey,
    tenantId,
    expiresAt,
    maxSizeBytes: maxSizeStr,
    disposition: partNumberStr,
    filename: uploadId,
    contentType: '',
  });
  if (!timingSafeEqual(sig, expectedSig)) {
    return c.json({ error: 'Invalid multipart signature' }, 403);
  }

  const partNumber = Number.parseInt(partNumberStr, 10);
  const maxSizeBytes = Number.parseInt(maxSizeStr, 10);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return c.json({ error: 'Invalid partNumber' }, 400);
  }

  const bodyBytes = await c.req.arrayBuffer();
  if (Number.isFinite(maxSizeBytes) && bodyBytes.byteLength > maxSizeBytes) {
    return c.json({ error: 'Part payload exceeds signed max size' }, 413);
  }

  const mpu = c.env.BUCKET.resumeMultipartUpload(objectKey, uploadId);
  const uploadedPart = await mpu.uploadPart(partNumber, bodyBytes);

  return c.json(
    {
      ok: true,
      partNumber: uploadedPart.partNumber,
      etag: uploadedPart.etag,
    },
    200,
    { ETag: uploadedPart.etag }
  );
});
