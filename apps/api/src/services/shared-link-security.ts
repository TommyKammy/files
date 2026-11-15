import {
  bytesToBase64Url,
  base64UrlToBytes,
  decryptCookiePayload,
  encryptCookiePayload,
  timingSafeEqual,
} from './crypto-utils';

const PBKDF2_ITERATIONS = 10_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;
const SHARE_UNLOCK_TTL_MS = 30 * 60 * 1000;

const ACTIVE_CONTENT_EXTENSIONS = new Set(['html', 'htm', 'svg', 'xhtml']);
const ACTIVE_CONTENT_MIMES = new Set([
  'text/html',
  'image/svg+xml',
  'application/xhtml+xml',
]);

export interface ShareUnlockPayload {
  linkId: string;
  tokenHashPrefix: string;
  exp: number;
}

/**
 * Hash a share-link password using Web Crypto PBKDF2-SHA256 with a 16-byte random salt.
 * Iteration count (10,000) keeps CPU time well under the 10ms Workers Free limit,
 * paired with DB-enforced 5-attempt / 15-minute lockout against brute force.
 */
export async function hashSharePassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    DERIVED_BITS
  );
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(new Uint8Array(derived))}`;
}

export async function verifySharePassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 200_000) {
    return false;
  }

  let salt: Uint8Array;
  let expectedDigest: string;
  try {
    salt = base64UrlToBytes(parts[2]);
    expectedDigest = parts[3];
  } catch {
    return false;
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as Uint8Array<ArrayBuffer>,
      iterations,
    },
    keyMaterial,
    DERIVED_BITS
  );
  const actualDigest = bytesToBase64Url(new Uint8Array(derived));
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function getShareUnlockSecret(env: {
  SESSION_SECRET?: string;
  LOCAL_PROXY_SECRET?: string;
}): string {
  const secret = env.SESSION_SECRET ?? env.LOCAL_PROXY_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('SESSION_SECRET (or LOCAL_PROXY_SECRET in local dev) must be configured');
  }
  return secret;
}

export function getShareUnlockCookieName(linkId: string): string {
  return `files_share_unlock_${linkId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16)}`;
}

export async function issueShareUnlockToken(
  secret: string,
  linkId: string,
  tokenHash: string
): Promise<string> {
  const payload: ShareUnlockPayload = {
    linkId,
    tokenHashPrefix: tokenHash.slice(0, 16),
    exp: Date.now() + SHARE_UNLOCK_TTL_MS,
  };
  return encryptCookiePayload(secret, payload);
}

export async function verifyShareUnlockToken(
  secret: string,
  token: string | undefined,
  linkId: string,
  tokenHash: string
): Promise<boolean> {
  if (!token) return false;
  const payload = await decryptCookiePayload<ShareUnlockPayload>(secret, token);
  if (!payload) return false;
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return false;
  return (
    timingSafeEqual(payload.linkId, linkId) &&
    timingSafeEqual(payload.tokenHashPrefix, tokenHash.slice(0, 16))
  );
}

export function isActiveWebContent(filename: string, contentType?: string | null): boolean {
  const dotIdx = filename.lastIndexOf('.');
  const ext = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : '';
  if (ACTIVE_CONTENT_EXTENSIONS.has(ext)) {
    return true;
  }
  const normalizedMime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return ACTIVE_CONTENT_MIMES.has(normalizedMime);
}

export function maskViewerIp(ip: string): string {
  if (!ip || ip === 'unknown') return 'anon-viewer';
  if (ip.includes('.')) {
    const segs = ip.split('.');
    return segs.length === 4 ? `${segs[0]}.${segs[1]}.*.*` : 'anon-ipv4';
  }
  if (ip.includes(':')) {
    const segs = ip.split(':').filter(Boolean);
    return segs.length >= 2 ? `${segs[0]}:${segs[1]}::*` : 'anon-ipv6';
  }
  return 'anon-viewer';
}
