import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

// CSP is generated per request in proxy.ts so authenticated app routes can
// use nonces. These headers are static and remain safe for every response.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // no-referrer prevents shared-link tokens in /s/<token> from leaking in the
  // Referer header of same-origin API requests.
  { key: 'Referrer-Policy', value: 'no-referrer' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  ...(isDev
    ? []
    : [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains',
        },
      ]),
];

const nextConfig: NextConfig = {
  // E2E runs use a dedicated Next build/dev directory so `next dev` on :3000
  // (which holds .next/dev/lock) and the Playwright web server never collide.
  distDir: process.env.NEXT_DIST_DIR?.trim() || '.next',
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') {
      return [];
    }

    const apiOrigin = process.env.LOCAL_API_ORIGIN ?? 'http://127.0.0.1:8787';

    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
      {
        source: '/auth/:path*',
        destination: `${apiOrigin}/auth/:path*`,
      },
      {
        source: '/scim/:path*',
        destination: `${apiOrigin}/scim/:path*`,
      },
      {
        source: '/wopi/:path*',
        destination: `${apiOrigin}/wopi/:path*`,
      },
    ];
  },
};

export default nextConfig;
