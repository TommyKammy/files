import { NextRequest, NextResponse } from 'next/server';

const isDev = process.env.NODE_ENV === 'development';
const enforceNonce = process.env.CSP_NONCE_MODE !== 'report';

// Authenticated app routes get a per-request nonce. Public/static routes keep
// the permissive static policy so `/` can remain statically generated/cached.
const NONCE_ROUTES = [/^\/workspace(?:\/|$)/, /^\/admin(?:\/|$)/];

function createNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getCollaboraFrameOrigin(): string | null {
  const raw = process.env.COLLABORA_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function buildCsp(nonce: string | null) {
  const collaboraOrigin = getCollaboraFrameOrigin();
  const frameSrc = [
    "'self'",
    'https://challenges.cloudflare.com',
    ...(collaboraOrigin ? [collaboraOrigin] : []),
  ].join(' ');
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
        isDev ? " 'unsafe-eval'" : ''
      }`
    : `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`;

  return [
    "default-src 'self'",
    scriptSrc,
    // Inline style attributes are not covered by style nonces. Keep
    // 'unsafe-inline' until the style={{...}} call sites are migrated.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' https: wss:${isDev ? ' ws:' : ''}`,
    "media-src 'self' blob: https:",
    "worker-src 'self' blob:",
    `frame-src ${frameSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
    'report-uri /api/csp-report',
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const wantsNonce = NONCE_ROUTES.some((pattern) =>
    pattern.test(request.nextUrl.pathname)
  );

  const requestHeaders = new Headers(request.headers);
  const staticCsp = buildCsp(null);
  let responseCsp = staticCsp;

  if (wantsNonce) {
    const nonce = createNonce();
    const nonceCsp = buildCsp(nonce);

    // Next.js reads the nonce from the request CSP header and applies it to
    // framework scripts, page bundles and generated inline scripts.
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', nonceCsp);
    responseCsp = nonceCsp;
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  if (wantsNonce) {
    if (enforceNonce) {
      response.headers.set('Content-Security-Policy', responseCsp);
    } else {
      // Report-only phase: do not set an enforced CSP here, otherwise Next.js
      // prefers that header when extracting the nonce and never injects one.
      response.headers.set(
        'Content-Security-Policy-Report-Only',
        responseCsp
      );
    }
    // A nonce must never be reused from a cached HTML response.
    response.headers.set('Cache-Control', 'private, no-store');
  } else {
    response.headers.set('Content-Security-Policy', responseCsp);
  }

  return response;
}

export const config = {
  matcher: [
    {
      source:
        '/((?!api|auth|scim|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
