import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createAdminLegalHold,
  createAdminRetentionPolicy,
  deleteAdminRetentionPolicy,
  fetchAdminLegalHolds,
  fetchAdminRetentionPolicies,
  releaseAdminLegalHold,
  updateAdminRetentionPolicy,
} from '@/lib/files-api/legal-holds';

test('AdminLegalHoldsSection is mounted inside AdminComplianceSettingsSection', () => {
  const compliancePath = path.resolve(
    process.cwd(),
    'src/components/admin/AdminComplianceSettingsSection.tsx'
  );
  const legalHoldsPath = path.resolve(
    process.cwd(),
    'src/components/admin/AdminLegalHoldsSection.tsx'
  );
  assert.equal(fs.existsSync(legalHoldsPath), true);
  const complianceSrc = fs.readFileSync(compliancePath, 'utf8');
  assert.equal(complianceSrc.includes('AdminLegalHoldsSection'), true);
});

test('legal-holds API client calls expected endpoints and methods', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(
      JSON.stringify({ ok: true, legalHolds: [], retentionPolicies: [] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  try {
    await fetchAdminLegalHolds('active');
    await createAdminLegalHold({
      name: 'Hold 1',
      targetType: 'folder',
      targetId: 'fld-1',
      reason: 'Audit',
    });
    await releaseAdminLegalHold('lh-1');
    await fetchAdminRetentionPolicies();
    await createAdminRetentionPolicy({
      name: 'Ret 1',
      targetType: 'classification',
      targetValue: 'confidential',
      retentionDays: 365,
    });
    await updateAdminRetentionPolicy('rp-1', { enabled: false });
    await deleteAdminRetentionPolicy('rp-1');

    assert.equal(calls.length, 7);
    assert.equal(
      calls[0].url.endsWith('/api/admin/legal-holds?status=active'),
      true
    );
    assert.equal(calls[0].method, 'GET');

    assert.equal(calls[1].url.endsWith('/api/admin/legal-holds'), true);
    assert.equal(calls[1].method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].body!), {
      name: 'Hold 1',
      targetType: 'folder',
      targetId: 'fld-1',
      reason: 'Audit',
    });

    assert.equal(
      calls[2].url.endsWith('/api/admin/legal-holds/lh-1/release'),
      true
    );
    assert.equal(calls[2].method, 'POST');

    assert.equal(calls[3].url.endsWith('/api/admin/retention-policies'), true);
    assert.equal(calls[3].method, 'GET');

    assert.equal(calls[4].url.endsWith('/api/admin/retention-policies'), true);
    assert.equal(calls[4].method, 'POST');

    assert.equal(
      calls[5].url.endsWith('/api/admin/retention-policies/rp-1'),
      true
    );
    assert.equal(calls[5].method, 'PATCH');

    assert.equal(
      calls[6].url.endsWith('/api/admin/retention-policies/rp-1'),
      true
    );
    assert.equal(calls[6].method, 'DELETE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
