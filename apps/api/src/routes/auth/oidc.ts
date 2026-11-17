import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  getOidcStateCookieName,
  isLocalDevBypassAllowed,
  LOCAL_DEV_OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE,
  shouldUseSecureHostCookie,
} from '../../middleware/session-auth';
import {
  decryptCookiePayload,
  encryptCookiePayload,
  generateRandomToken,
  sha256Base64Url,
  timingSafeEqual,
} from '../../services/crypto-utils';
import { recordAuthControlAudit } from '../../services/auth-audit';
import {
  enforceIpAllowlistForTenant,
  resolveClientIp,
} from '../../services/ip-allowlist';
import {
  isSsoEmailDomainAllowed,
  loadSsoPolicy,
} from '../../services/sso-policy';
import {
  buildConfiguredIdpProviders,
  fetchOidcDiscovery,
  OidcVerificationError,
  verifyOidcIdToken,
} from '../../services/oidc-verifier';
import { AccountLinkConflictError, syncUserWithD1 } from '../../services/user-sync';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  OIDC_STATE_TTL_MS,
  OidcStatePayload,
  clearHostOrLocalCookies,
  getCallbackBaseOrigin,
  getClientSecretForProvider,
  issueSessionForUser,
  recordAuthAudit,
  resolveProviderById,
  sanitizeReturnTo,
} from './shared';

export function registerOidcRoutes(routes: Hono<OidcHonoEnv>) {
  routes.get('/auth/login', async (c) => {
    const cookieKey = c.env.OIDC_STATE_COOKIE_KEY;
    if (!cookieKey || cookieKey.length < 16) {
      return c.json({ error: 'OIDC_STATE_COOKIE_KEY is not configured' }, 500);
    }

    const providers = buildConfiguredIdpProviders(c.env);
    const requestedIdp = c.req.query('idp');
    const provider = resolveProviderById(providers, requestedIdp);
    const requestedTenantId = (
      c.req.query('tenant') ??
      c.env.DEFAULT_TENANT_ID ??
      'tenant-default'
    ).trim();
    const loginIpBlocked = await enforceIpAllowlistForTenant(c, {
      tenantId: requestedTenantId,
      kind: 'internal_auth',
    });
    if (loginIpBlocked) return loginIpBlocked;

    if (!provider) {
      if (!requestedIdp && isLocalDevBypassAllowed(c)) {
        // TOM-66: never silently bypass a tenant that requires SSO. Without
        // configured IdP metadata there is no safe login path, so fail closed.
        const ssoPolicy = await loadSsoPolicy(c.env.DB, requestedTenantId);
        if (ssoPolicy.requireSsoLogin) {
          await recordAuthControlAudit(c.env.DB, {
            tenantId: requestedTenantId,
            actorId: null,
            actorEmail: null,
            actorIp: resolveClientIp(c),
            action: 'auth.sso_required_blocked',
            targetId: '/auth/login',
            status: 'blocked',
            metadata: {
              source: 'local_bypass_redirect',
              path: '/auth/login',
            },
          });
          return c.json(
            {
              error: 'SSO login is required for this tenant',
              code: 'SSO_LOGIN_REQUIRED',
            },
            403
          );
        }
        return c.redirect(sanitizeReturnTo(c.req.query('returnTo')), 302);
      }
      return c.json({ error: 'Requested OIDC provider is not configured' }, 400);
    }

    const tenantId = requestedTenantId;
    const tenantRow = await c.env.DB.prepare('SELECT id FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ id: string }>();
    if (!tenantRow) {
      return c.json({ error: 'Unknown tenant' }, 400);
    }

    const discovery = await fetchOidcDiscovery(provider.issuer);
    if (!discovery.authorization_endpoint) {
      return c.json({ error: 'OIDC authorization_endpoint is missing in discovery' }, 502);
    }

    const state = generateRandomToken(32);
    const nonce = generateRandomToken(32);
    const codeVerifier = generateRandomToken(48);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const returnTo = sanitizeReturnTo(c.req.query('returnTo'));

    const sealedState = await encryptCookiePayload(cookieKey, {
      state,
      nonce,
      codeVerifier,
      idp: provider.provider,
      tenantId: tenantRow.id,
      returnTo,
      exp: Date.now() + OIDC_STATE_TTL_MS,
    } satisfies OidcStatePayload);

    const useSecure = shouldUseSecureHostCookie(c.env, c.req.url);
    setCookie(c, getOidcStateCookieName(c.env, c.req.url), sealedState, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: useSecure,
      maxAge: Math.floor(OIDC_STATE_TTL_MS / 1000),
    });

    const redirectUri = `${getCallbackBaseOrigin(c.env, c.req.url)}/auth/callback`;
    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', provider.audience);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return c.redirect(authUrl.toString(), 302);
  });

  routes.get('/auth/callback', async (c) => {
    const ipAddress = resolveClientIp(c);
    const stateCookieName = getOidcStateCookieName(c.env, c.req.url);
    const sealedState = getCookie(c, stateCookieName);
    clearHostOrLocalCookies(c, OIDC_STATE_COOKIE, LOCAL_DEV_OIDC_STATE_COOKIE);

    const idpError = c.req.query('error');
    if (idpError) {
      return c.json({ error: 'OIDC authentication denied', code: idpError }, 401);
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    const cookieKey = c.env.OIDC_STATE_COOKIE_KEY;
    if (!code || !state || !sealedState || !cookieKey) {
      return c.json({ error: 'Invalid OIDC callback state' }, 400);
    }

    const statePayload = await decryptCookiePayload<OidcStatePayload>(cookieKey, sealedState);
    if (
      !statePayload ||
      Date.now() > statePayload.exp ||
      !timingSafeEqual(state, statePayload.state)
    ) {
      return c.json({ error: 'Expired or mismatched OIDC state' }, 400);
    }

    const ipBlocked = await enforceIpAllowlistForTenant(c, {
      tenantId: statePayload.tenantId,
      kind: 'internal_auth',
    });
    if (ipBlocked) return ipBlocked;

    const providers = buildConfiguredIdpProviders(c.env);
    const provider = resolveProviderById(providers, statePayload.idp);
    if (!provider) {
      return c.json({ error: 'OIDC provider configuration not found' }, 400);
    }

    const discovery = await fetchOidcDiscovery(provider.issuer);
    if (!discovery.token_endpoint) {
      return c.json({ error: 'OIDC token_endpoint is missing in discovery' }, 502);
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${getCallbackBaseOrigin(c.env, c.req.url)}/auth/callback`,
      client_id: provider.audience,
      code_verifier: statePayload.codeVerifier,
    });
    const clientSecret = getClientSecretForProvider(c.env, provider.provider);
    if (clientSecret) {
      form.set('client_secret', clientSecret);
    }

    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });

    if (!tokenRes.ok) {
      await recordAuthAudit(c.env.DB, {
        tenantId: statePayload.tenantId,
        actorId: null,
        actorEmail: null,
        actorIp: ipAddress,
        action: 'auth.token_exchange_failed',
        targetId: provider.provider,
        status: 'blocked',
        metadata: { httpStatus: tokenRes.status },
      });
      return c.json({ error: 'Failed to exchange authorization code' }, 401);
    }

    const tokenBody = (await tokenRes.json()) as { id_token?: string };
    if (!tokenBody.id_token) {
      return c.json({ error: 'ID token missing in token response' }, 401);
    }

    let claims;
    try {
      claims = await verifyOidcIdToken(tokenBody.id_token, c.env, statePayload.nonce);
    } catch (err) {
      if (err instanceof OidcVerificationError) {
        await recordAuthAudit(c.env.DB, {
          tenantId: statePayload.tenantId,
          actorId: null,
          actorEmail: null,
          actorIp: ipAddress,
          action: 'auth.oidc_verification_failed',
          targetId: err.code,
          status: 'blocked',
          metadata: { code: err.code, message: err.message },
        });
        return c.json({ error: err.message, code: err.code }, 401);
      }
      throw err;
    }

    let syncedUser;
    try {
      // TOM-66: an explicit SSO domain allowlist narrows who may use the IdP,
      // on top of the IdP's own email verification.
      const ssoPolicy = await loadSsoPolicy(c.env.DB, statePayload.tenantId);
      if (!isSsoEmailDomainAllowed(claims.email, ssoPolicy.allowedDomains)) {
        await recordAuthControlAudit(c.env.DB, {
          tenantId: statePayload.tenantId,
          actorId: null,
          actorEmail: claims.email,
          actorIp: ipAddress,
          action: 'auth.sso_domain_blocked',
          targetId: claims.email,
          status: 'blocked',
          metadata: {
            provider: claims.provider,
            issuer: claims.issuer,
            emailDomain: claims.email.split('@').pop() ?? null,
            allowedDomains: ssoPolicy.allowedDomains,
          },
        });
        return c.json(
          {
            error: 'This email domain is not allowed for SSO login',
            code: 'SSO_DOMAIN_NOT_ALLOWED',
          },
          403
        );
      }

      syncedUser = await syncUserWithD1(c.env.DB, statePayload.tenantId, claims, ipAddress);
    } catch (err) {
      if (err instanceof AccountLinkConflictError) {
        await recordAuthAudit(c.env.DB, {
          tenantId: statePayload.tenantId,
          actorId: null,
          actorEmail: claims.email,
          actorIp: ipAddress,
          action: 'auth.account_link_conflict',
          targetId: claims.email,
          status: 'blocked',
          metadata: { issuer: claims.issuer, provider: claims.provider },
        });
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }

    if (syncedUser.status !== 'active') {
      await recordAuthAudit(c.env.DB, {
        tenantId: statePayload.tenantId,
        actorId: syncedUser.id,
        actorEmail: syncedUser.email,
        actorIp: ipAddress,
        action: 'auth.suspended_user_login',
        targetId: syncedUser.id,
        status: 'blocked',
        metadata: { issuer: claims.issuer },
      });
      return c.json({ error: 'Account is suspended' }, 403);
    }

    await issueSessionForUser(c, {
      tenantId: statePayload.tenantId,
      userId: syncedUser.id,
      email: syncedUser.email,
      ipAddress,
      auditAction: 'auth.login',
      auditMetadata: { provider: claims.provider, issuer: claims.issuer },
    });

    return c.redirect(sanitizeReturnTo(statePayload.returnTo), 302);
  });


}
