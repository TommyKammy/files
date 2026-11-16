import { AwsClient } from 'aws4fetch';
import { bytesToBase64Url } from './crypto-utils';
import type { Env } from '../types/api';

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

export function getLocalProxySecret(env: Pick<Env, 'ENVIRONMENT' | 'LOCAL_PROXY_SECRET'>): string {
  if (env.LOCAL_PROXY_SECRET && env.LOCAL_PROXY_SECRET.trim()) {
    return env.LOCAL_PROXY_SECRET.trim();
  }
  if (env.ENVIRONMENT === 'local') {
    return DEFAULT_LOCAL_DEV_PROXY_SECRET;
  }
  throw new Error('LOCAL_PROXY_SECRET must be configured outside local environment');
}

export async function computeProxyHmacSignature(
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
