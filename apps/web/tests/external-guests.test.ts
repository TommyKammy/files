import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptGuestInvitation,
  buildGuestInvitationPayload,
  buildGuestOtpVerifyPayload,
  createGuestInvitation,
  fetchGuestInviteMeta,
  requestGuestOtp,
  resendGuestInvitation,
  revokeGuestInvitation,
  verifyGuestOtp,
} from '@/lib/files-api';
import {
  guestInvitationStatusLabel,
  isGuestRoleAllowed,
  isValidOtp,
  normalizeDomainAllowlist,
  normalizeGuestDomain,
  OTP_INPUT_ATTRIBUTES,
  parseDomainAllowlistJson,
  readGuestPolicy,
  sanitizeOtpInput,
  sortGuestInvitations,
  validateDomainAllowlistInput,
} from '@/lib/guest-policy';
import { guestAuthErrorMessage } from '@/lib/guest-auth-messages';
import { ApiClientError } from '@/lib/files-api';
import type {
  GuestInvitationSummary,
  TenantPolicyRow,
} from '@/types/files';

function makePolicy(overrides: Partial<TenantPolicyRow> = {}): TenantPolicyRow {
  return {
    tenant_id: 'tenant-1',
    enforce_company_only_links: 0,
    require_watermark_confidential: 1,
    max_link_expiration_days: 30,
    session_max_hours: 12,
    trash_retention_days: 30,
    ai_classification_mode: 'metadata_only',
    ai_auto_apply_threshold: null,
    updated_by: null,
    updated_at: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

function invitation(
  overrides: Partial<GuestInvitationSummary>
): GuestInvitationSummary {
  return {
    id: 'gi-1',
    userId: 'guest-1',
    email: 'guest@partner.example',
    displayName: 'Guest',
    externalOrg: 'Partner',
    invitedBy: 'admin',
    targetType: 'folder',
    targetId: 'folder-1',
    targetName: 'Shared',
    role: 'viewer',
    status: 'pending',
    expiresAt: '2026-12-01T00:00:00.000Z',
    acceptedAt: null,
    revokedAt: null,
    revokedBy: null,
    resendCount: 0,
    lastSentAt: null,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

test('readGuestPolicy normalizes camelCase, snake_case and defaults', () => {
  assert.deepEqual(readGuestPolicy(null), {
    allowExternalCollaborators: false,
    allowGuestElevatedRoles: false,
    externalDomainAllowlist: [],
    guestInvitationExpiryDays: 14,
    guestSessionMaxHours: 24,
  });

  const camel = readGuestPolicy(
    makePolicy({
      allowExternalCollaborators: true,
      allowGuestElevatedRoles: true,
      externalDomainAllowlist: ['B.Example', 'a.example'],
      guestInvitationExpiryDays: 30,
      guestSessionMaxHours: 8,
    })
  );
  assert.deepEqual(camel, {
    allowExternalCollaborators: true,
    allowGuestElevatedRoles: true,
    externalDomainAllowlist: ['a.example', 'b.example'],
    guestInvitationExpiryDays: 30,
    guestSessionMaxHours: 8,
  });

  const snake = readGuestPolicy(
    makePolicy({
      allow_external_collaborators: 1,
      allow_guest_elevated_roles: 1,
      external_domain_allowlist_json: '["partner.example"]',
      guest_invitation_expiry_days: 3,
      guest_session_max_hours: 2,
    })
  );
  assert.equal(snake.allowExternalCollaborators, true);
  assert.equal(snake.allowGuestElevatedRoles, true);
  assert.deepEqual(snake.externalDomainAllowlist, ['partner.example']);
  assert.equal(snake.guestInvitationExpiryDays, 3);
  assert.equal(snake.guestSessionMaxHours, 2);

  const malformed = readGuestPolicy(
    makePolicy({
      external_domain_allowlist_json: '{not-json',
      guest_invitation_expiry_days: 0,
      guest_session_max_hours: 999,
    })
  );
  assert.deepEqual(malformed.externalDomainAllowlist, []);
  assert.equal(malformed.guestInvitationExpiryDays, 14);
  assert.equal(malformed.guestSessionMaxHours, 24);
});

test('domain validation lowercases, strips @, dedupes and rejects malformed input', () => {
  assert.equal(normalizeGuestDomain(' Partner.Example '), 'partner.example');
  assert.equal(normalizeGuestDomain('@partner.example'), 'partner.example');
  assert.equal(normalizeGuestDomain('partner.example.'), 'partner.example');
  assert.equal(normalizeGuestDomain('localhost'), null);
  assert.equal(normalizeGuestDomain('https://partner.example/path'), null);
  assert.equal(normalizeGuestDomain('*.partner.example'), null);
  assert.equal(normalizeGuestDomain('part_ner.example'), null);

  assert.deepEqual(
    normalizeDomainAllowlist([
      'B.Example.com',
      'a.example.com',
      'b.example.COM',
      'invalid',
      null,
    ]),
    ['a.example.com', 'b.example.com']
  );

  assert.deepEqual(validateDomainAllowlistInput(['B.Example.com', 'b.example.com']), {
    ok: true,
    domains: ['b.example.com'],
  });
  assert.deepEqual(validateDomainAllowlistInput(['ok.example', 'bad domain']), {
    ok: false,
    invalid: ['bad domain'],
  });
  assert.equal(validateDomainAllowlistInput('ok.example').ok, false);
  assert.deepEqual(parseDomainAllowlistJson('["x.example","X.example"]'), [
    'x.example',
  ]);
  assert.deepEqual(parseDomainAllowlistJson('nope'), []);
});

test('OTP helpers keep a single 6-digit input and reject partial codes', () => {
  assert.equal(sanitizeOtpInput('12a3 45'), '12345');
  assert.equal(sanitizeOtpInput('1234567'), '123456');
  assert.equal(sanitizeOtpInput('abc'), '');
  assert.equal(isValidOtp('012345'), true);
  assert.equal(isValidOtp('12345'), false);
  assert.equal(isValidOtp('12345a'), false);
  assert.equal(OTP_INPUT_ATTRIBUTES.type, 'text');
  assert.equal(OTP_INPUT_ATTRIBUTES.inputMode, 'numeric');
  assert.equal(OTP_INPUT_ATTRIBUTES.autoComplete, 'one-time-code');
  assert.equal(OTP_INPUT_ATTRIBUTES.pattern, '\\d{6}');
  assert.equal(OTP_INPUT_ATTRIBUTES.maxLength, 6);
});

test('guest role policy mirrors owner/elevated/advanced restrictions', () => {
  const base = { allowGuestElevatedRoles: false };
  assert.equal(isGuestRoleAllowed('viewer', base, { advancedRolesEnabled: false, targetType: 'folder' }), true);
  assert.equal(isGuestRoleAllowed('previewer', base, { advancedRolesEnabled: false, targetType: 'file' }), true);
  assert.equal(isGuestRoleAllowed('owner', { allowGuestElevatedRoles: true }, { advancedRolesEnabled: true, targetType: 'folder' }), false);
  assert.equal(isGuestRoleAllowed('co_owner', { allowGuestElevatedRoles: true }, { advancedRolesEnabled: true, targetType: 'folder' }), false);
  assert.equal(isGuestRoleAllowed('editor', base, { advancedRolesEnabled: true, targetType: 'folder' }), false);
  assert.equal(isGuestRoleAllowed('editor', { allowGuestElevatedRoles: true }, { advancedRolesEnabled: false, targetType: 'folder' }), true);
  assert.equal(isGuestRoleAllowed('uploader', base, { advancedRolesEnabled: false, targetType: 'folder' }), false);
  assert.equal(isGuestRoleAllowed('uploader', base, { advancedRolesEnabled: true, targetType: 'file' }), false);
  assert.equal(isGuestRoleAllowed('uploader', base, { advancedRolesEnabled: true, targetType: 'folder' }), true);
});

test('invitation status labels and sorting are stable', () => {
  assert.equal(guestInvitationStatusLabel('pending'), '招待中');
  assert.equal(guestInvitationStatusLabel('accepted'), '承諾済み');
  assert.equal(guestInvitationStatusLabel('revoked'), '取消済み');
  assert.equal(guestInvitationStatusLabel('expired'), '期限切れ');

  const sorted = sortGuestInvitations([
    invitation({ id: 'revoked', status: 'revoked', createdAt: '2026-11-19T00:00:00.000Z' }),
    invitation({ id: 'old-pending', status: 'pending', createdAt: '2026-11-17T00:00:00.000Z' }),
    invitation({ id: 'accepted', status: 'accepted', createdAt: '2026-11-18T00:00:00.000Z' }),
    invitation({ id: 'new-pending', status: 'pending', createdAt: '2026-11-20T00:00:00.000Z' }),
  ]);
  assert.deepEqual(
    sorted.map((row) => row.id),
    ['new-pending', 'old-pending', 'accepted', 'revoked']
  );
});

test('buildGuestInvitationPayload trims and lowercases identifiers', () => {
  assert.deepEqual(
    buildGuestInvitationPayload({
      email: '  Guest@Partner.Example ',
      displayName: '  Guest Name ',
      externalOrg: '  Partner Corp ',
      targetType: 'folder',
      targetId: ' folder-1 ',
      role: 'viewer',
    }),
    {
      email: 'guest@partner.example',
      displayName: 'Guest Name',
      externalOrg: 'Partner Corp',
      targetType: 'folder',
      targetId: 'folder-1',
      role: 'viewer',
    }
  );
  assert.deepEqual(buildGuestOtpVerifyPayload(' Guest@Partner.Example ', '12 3456'), {
    email: 'guest@partner.example',
    otp: '123456',
  });
});

interface FetchCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

function installFetchMock(
  responses: Array<{ status?: number; body: unknown }>
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      init: init ?? {},
      body:
        typeof init?.body === 'string' && init.body
          ? JSON.parse(init.body)
          : init?.body,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('guest API client uses the expected endpoints, payloads and credentials', async () => {
  const { calls, restore } = installFetchMock([
    { status: 201, body: { invitation: invitation({}) } },
    { status: 200, body: { invitations: [invitation({})] } },
    { status: 200, body: { ok: true, invitation: invitation({ resendCount: 1 }) } },
    { status: 200, body: { ok: true, invitation: invitation({ status: 'revoked' }) } },
    {
      status: 200,
      body: {
        invitation: {
          id: 'gi-1',
          status: 'pending',
          valid: true,
          canAccept: true,
        },
      },
    },
    {
      status: 200,
      body: {
        ok: true,
        email: 'guest@partner.example',
        emailMasked: 'g****@partner.example',
        targetName: 'Shared',
        otpExpiresAt: '2026-11-17T00:10:00.000Z',
      },
    },
    {
      status: 200,
      body: {
        ok: true,
        email: 'guest@partner.example',
        emailMasked: 'g****@partner.example',
        otpExpiresAt: '2026-11-17T00:10:00.000Z',
      },
    },
    {
      status: 200,
      body: { ok: true, user: { id: 'guest-1', userType: 'guest' } },
    },
  ]);

  try {
    await createGuestInvitation({
      email: 'Guest@Partner.Example',
      targetType: 'folder',
      targetId: 'folder-1',
      role: 'viewer',
    });
    assert.equal(calls[0].url, '/api/guests/invitations');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(calls[0].body, {
      email: 'guest@partner.example',
      targetType: 'folder',
      targetId: 'folder-1',
      role: 'viewer',
    });

    await resendGuestInvitation('gi/1');
    assert.equal(calls[1].url, '/api/guests/invitations/gi%2F1/resend');
    assert.equal(calls[1].init.method, 'POST');

    await revokeGuestInvitation('gi-1');
    assert.equal(calls[2].url, '/api/guests/invitations/gi-1/revoke');

    await fetchGuestInviteMeta(' token/with space ');
    assert.equal(
      calls[3].url,
      '/auth/guest/invite-meta?token=token%2Fwith%20space'
    );

    await acceptGuestInvitation('token-1');
    assert.equal(calls[4].url, '/auth/guest/accept');
    assert.deepEqual(calls[4].body, { token: 'token-1' });

    await requestGuestOtp(' Guest@Partner.Example ');
    assert.equal(calls[5].url, '/auth/guest/otp/request');
    assert.deepEqual(calls[5].body, { email: 'guest@partner.example' });

    await verifyGuestOtp(' Guest@Partner.Example ', ' 123 456 ');
    assert.equal(calls[6].url, '/auth/guest/otp/verify');
    assert.deepEqual(calls[6].body, {
      email: 'guest@partner.example',
      otp: '123456',
    });

    for (const call of calls) {
      assert.equal(call.init.credentials, 'include');
    }
  } finally {
    restore();
  }
});

test('guest API client surfaces ApiClientError codes and retry details', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: 'Too many attempts',
        code: 'GUEST_AUTH_RATE_LIMITED',
        retryAfterSeconds: 120,
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;
  try {
    await assert.rejects(
      () => verifyGuestOtp('guest@partner.example', '123456'),
      (err: unknown) => {
        assert.ok(err instanceof ApiClientError);
        assert.equal(err.status, 429);
        assert.equal(err.code, 'GUEST_AUTH_RATE_LIMITED');
        assert.equal(err.details?.retryAfterSeconds, 120);
        assert.match(
          guestAuthErrorMessage(err, 'fallback'),
          /2 分後に再試行/
        );
        return true;
      }
    );
    await assert.rejects(
      () => requestGuestOtp('guest@partner.example'),
      (err: unknown) => {
        assert.ok(err instanceof ApiClientError);
        assert.equal(err.code, 'GUEST_AUTH_RATE_LIMITED');
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('guestAuthErrorMessage maps invitation and OTP failure codes', () => {
  const expired = new ApiClientError(410, 'expired', 'INVITATION_EXPIRED');
  assert.match(guestAuthErrorMessage(expired, 'fallback'), /有効期限/);
  const used = new ApiClientError(410, 'used', 'INVITATION_ALREADY_USED');
  assert.match(guestAuthErrorMessage(used, 'fallback'), /使用済み/);
  const otp = new ApiClientError(401, 'bad otp', 'INVALID_OTP', {
    attemptsRemaining: 2,
  });
  assert.match(guestAuthErrorMessage(otp, 'fallback'), /残り 2 回/);
  assert.equal(guestAuthErrorMessage(new Error('boom'), 'fallback'), 'fallback');
});
