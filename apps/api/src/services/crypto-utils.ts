const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function generateRandomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = textEncoder.encode(a);
  const bytesB = textEncoder.encode(b);
  const maxLen = Math.max(bytesA.length, bytesB.length);
  let diff = bytesA.length ^ bytesB.length;
  for (let i = 0; i < maxLen; i++) {
    const ba = i < bytesA.length ? bytesA[i] : 0;
    const bb = i < bytesB.length ? bytesB[i] : 0;
    diff |= ba ^ bb;
  }
  return diff === 0;
}

async function deriveAesGcmKey(
  secret: string,
  usages: Array<'encrypt' | 'decrypt'>
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));
  return crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, usages);
}

export async function encryptCookiePayload(secret: string, payload: unknown): Promise<string> {
  const key = await deriveAesGcmKey(secret, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

export async function decryptCookiePayload<T>(
  secret: string,
  sealed: string
): Promise<T | null> {
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  try {
    const iv = base64UrlToBytes(parts[1]);
    const ciphertext = base64UrlToBytes(parts[2]);
    if (iv.length !== 12) return null;
    const key = await deriveAesGcmKey(secret, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(textDecoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export async function sealRecoverableToken(
  env: { SESSION_SECRET?: string; LOCAL_PROXY_SECRET?: string },
  rawToken: string
): Promise<string | null> {
  const secret = env.SESSION_SECRET ?? env.LOCAL_PROXY_SECRET;
  if (!secret || !rawToken) return null;
  return encryptCookiePayload(secret, { kind: 'recoverable_token', token: rawToken });
}

export async function unsealRecoverableToken(
  env: { SESSION_SECRET?: string; LOCAL_PROXY_SECRET?: string },
  ciphertext: string | null | undefined
): Promise<string | null> {
  const secret = env.SESSION_SECRET ?? env.LOCAL_PROXY_SECRET;
  if (!secret || !ciphertext) return null;
  const payload = await decryptCookiePayload<{ kind?: string; token?: string }>(
    secret,
    ciphertext
  );
  if (payload?.kind !== 'recoverable_token' || typeof payload.token !== 'string' || !payload.token) {
    return null;
  }
  return payload.token;
}
