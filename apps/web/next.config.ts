import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
    ];
  },
};

export default nextConfig;
