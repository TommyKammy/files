import { AwsClient } from 'aws4fetch';
import { Hono } from 'hono';
import { bytesToBase64Url, timingSafeEqual } from './crypto-utils';
import type { Env } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';

const DEFAULT_LOCAL_DEV_PROXY_SECRET = 'dev-local-proxy-secret-change-in-prod';

const ACTIVE_HTML_EXTENSIONS = new Set(['html', 'htm', 'svg', 'xhtml']);
const ACTIVE_HTML_MIME_TYPES = new Set([
  'text/html',
  'image/svg+xml',
  'application/xhtml+xml',
]);

export interface SignedStorageUrlRequest {
  method: 'PUT' | 'GET';
  objectKey: string;
  tenantId: string;
  expiresInSeconds: number;
  maxSizeBytes?: number;
  disposition?: 'inline' | 'attachment';
  filename?: string;
  contentType?: string;
}

export interface SignedStorageUrlResult {
  url: string;
  method: 'PUT' | 'GET';
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

/** Prevent Stored XSS by disallowing inline browser rendering for HTML/SVG/XHTML. */
export function resolveSafeDisposition(
  requested: 'inline' | 'attachment',
  filename?: string,
  contentType?: string
): 'inline' | 'attachment' {
  if (requested === 'attachment') return 'attachment';
  const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
  const normalizedMime = contentType?.split(';')[0].trim().toLowerCase() ?? '';
  if (ACTIVE_HTML_EXTENSIONS.has(ext) || ACTIVE_HTML_MIME_TYPES.has(normalizedMime)) {
    return 'attachment';
  }
  return 'inline';
}

function getLocalProxySecret(env: Pick<Env, 'ENVIRONMENT' | 'LOCAL_PROXY_SECRET'>): string {
  if (env.LOCAL_PROXY_SECRET && env.LOCAL_PROXY_SECRET.trim()) {
    return env.LOCAL_PROXY_SECRET.trim();
  }
  if (env.ENVIRONMENT === 'local') {
    return DEFAULT_LOCAL_DEV_PROXY_SECRET;
  }
  throw new Error('LOCAL_PROXY_SECRET must be configured outside local environment');
}

async function computeProxyHmacSignature(
  secret: string,
  claims: {
    method: string;
    objectKey: string;
    tenantId: string;
    expiresAt: string;
    maxSizeBytes: string;
    disposition: string;
    filename: string;
    contentType: string;
  }
): Promise<string> {
  const canonical = [
    claims.method,
    claims.objectKey,
    claims.tenantId,
    claims.expiresAt,
    claims.maxSizeBytes,
    claims.disposition,
    claims.filename,
    claims.contentType,
  ].join('\n');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return bytesToBase64Url(new Uint8Array(sig));
}

function requireS3Config(env: Env): {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
} {
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_BUCKET_NAME ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error('R2 S3 presigned credentials (R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) are missing');
  }
  return {
    accountId: env.R2_ACCOUNT_ID,
    bucketName: env.R2_BUCKET_NAME,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

/**
 * Issue either an R2 S3 Presigned URL (`aws4fetch`) or an HMAC-signed sandboxed
 * Local Proxy URL depending on `env.STORAGE_MODE`.
 */
export async function issueSignedStorageUrl(
  env: Env,
  req: SignedStorageUrlRequest
): Promise<SignedStorageUrlResult> {
  const safeDisposition = req.disposition
    ? resolveSafeDisposition(req.disposition, req.filename, req.contentType)
    : undefined;
  const expiresAtIso = new Date(Date.now() + req.expiresInSeconds * 1000).toISOString();

  if (env.STORAGE_MODE === 's3_presigned') {
    const cfg = requireS3Config(env);
    const aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const encodedKey = req.objectKey
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const targetUrl = new URL(
      `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucketName}/${encodedKey}`
    );
    targetUrl.searchParams.set('X-Amz-Expires', String(req.expiresInSeconds));

    if (req.method === 'GET') {
      if (safeDisposition) {
        const encodedName = req.filename ? encodeURIComponent(req.filename) : 'download';
        targetUrl.searchParams.set(
          'response-content-disposition',
          `${safeDisposition}; filename*=UTF-8''${encodedName}`
        );
      }
      if (req.contentType) {
        targetUrl.searchParams.set('response-content-type', req.contentType);
      }
    }

    const signedRequest = await aws.sign(targetUrl.toString(), {
      method: req.method,
      headers:
        req.method === 'PUT' && req.contentType
          ? { 'Content-Type': req.contentType }
          : undefined,
      aws: { signQuery: true },
    });

    return {
      url: signedRequest.url,
      method: req.method,
      expiresAt: expiresAtIso,
      requiredHeaders:
        req.method === 'PUT' && req.contentType ? { 'Content-Type': req.contentType } : {},
    };
  }

  // local_proxy mode: HMAC-SHA256 signed Worker proxy endpoint
  const secret = getLocalProxySecret(env);
  const maxSizeStr = req.maxSizeBytes !== undefined ? String(req.maxSizeBytes) : '';
  const dispositionStr = safeDisposition ?? '';
  const filenameStr = req.filename ?? '';
  const contentTypeStr = req.contentType ?? '';

  const sig = await computeProxyHmacSignature(secret, {
    method: req.method,
    objectKey: req.objectKey,
    tenantId: req.tenantId,
    expiresAt: expiresAtIso,
    maxSizeBytes: maxSizeStr,
    disposition: dispositionStr,
    filename: filenameStr,
    contentType: contentTypeStr,
  });

  const proxyUrl = new URL('/api/storage/proxy', 'http://local-proxy.invalid');
  proxyUrl.searchParams.set('key', req.objectKey);
  proxyUrl.searchParams.set('tenantId', req.tenantId);
  proxyUrl.searchParams.set('expires', expiresAtIso);
  if (maxSizeStr) proxyUrl.searchParams.set('maxSize', maxSizeStr);
  if (dispositionStr) proxyUrl.searchParams.set('disposition', dispositionStr);
  if (filenameStr) proxyUrl.searchParams.set('filename', filenameStr);
  if (contentTypeStr) proxyUrl.searchParams.set('contentType', contentTypeStr);
  proxyUrl.searchParams.set('sig', sig);

  // Relative URL seamlessly works across Next.js dev proxy (:3000) & Worker (:8787)
  return {
    url: `${proxyUrl.pathname}${proxyUrl.search}`,
    method: req.method,
    expiresAt: expiresAtIso,
    requiredHeaders:
      req.method === 'PUT' && req.contentType ? { 'Content-Type': req.contentType } : {},
  };
}

export async function issueSignedMultipartPartUrl(
  env: Env,
  req: {
    objectKey: string;
    tenantId: string;
    uploadId: string;
    partNumber: number;
    maxSizeBytes: number;
    expiresInSeconds: number;
  }
): Promise<{ partNumber: number; url: string; expiresAt: string }> {
  const expiresAtIso = new Date(Date.now() + req.expiresInSeconds * 1000).toISOString();

  if (env.STORAGE_MODE === 's3_presigned') {
    const cfg = requireS3Config(env);
    const aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const encodedKey = req.objectKey
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const targetUrl = new URL(
      `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucketName}/${encodedKey}`
    );
    targetUrl.searchParams.set('partNumber', String(req.partNumber));
    targetUrl.searchParams.set('uploadId', req.uploadId);
    targetUrl.searchParams.set('X-Amz-Expires', String(req.expiresInSeconds));

    const signed = await aws.sign(targetUrl.toString(), {
      method: 'PUT',
      aws: { signQuery: true },
    });

    return {
      partNumber: req.partNumber,
      url: signed.url,
      expiresAt: expiresAtIso,
    };
  }

  const secret = getLocalProxySecret(env);
  const sig = await computeProxyHmacSignature(secret, {
    method: 'PUT_PART',
    objectKey: req.objectKey,
    tenantId: req.tenantId,
    expiresAt: expiresAtIso,
    maxSizeBytes: String(req.maxSizeBytes),
    disposition: String(req.partNumber),
    filename: req.uploadId,
    contentType: '',
  });

  const proxyUrl = new URL('/api/storage/multipart-part', 'http://local-proxy.invalid');
  proxyUrl.searchParams.set('key', req.objectKey);
  proxyUrl.searchParams.set('tenantId', req.tenantId);
  proxyUrl.searchParams.set('uploadId', req.uploadId);
  proxyUrl.searchParams.set('partNumber', String(req.partNumber));
  proxyUrl.searchParams.set('maxSize', String(req.maxSizeBytes));
  proxyUrl.searchParams.set('expires', expiresAtIso);
  proxyUrl.searchParams.set('sig', sig);

  return {
    partNumber: req.partNumber,
    url: `${proxyUrl.pathname}${proxyUrl.search}`,
    expiresAt: expiresAtIso,
  };
}

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
