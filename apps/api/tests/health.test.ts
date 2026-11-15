import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('files-api skeleton', () => {
  it('returns ok on GET /api/health', async () => {
    const res = await exports.default.fetch('http://example.com/api/health');
    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      service: string;
      environment: string;
      storageMode: string;
    }>();
    expect(body).toEqual({
      ok: true,
      service: 'files-api',
      environment: 'local',
      storageMode: 'local_proxy',
    });
  });

  it('returns 404 JSON on unknown route', async () => {
    const res = await exports.default.fetch('http://example.com/api/unknown');
    expect(res.status).toBe(404);
  });
});
