import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { resolveClientIp } from '../../services/ip-allowlist';
import {
  buildConfiguredIdpProviders,
  fetchOidcDiscovery,
} from '../../services/oidc-verifier';
import {
  loadSsoPolicy,
  maskOidcClientId,
} from '../../services/sso-policy';
import {
  getCallbackBaseOrigin,
  getClientSecretForProvider,
} from '../auth/shared';
import type { IdpProviderConfig, OidcEnv, OidcHonoEnv } from '../../types/oidc';

export interface AdminSsoProviderStatus {
  provider: IdpProviderConfig['provider'];
  issuer: string;
  clientIdMasked: string;
  clientSecretConfigured: boolean;
  jwksUri: string | null;
  discovery?: {
    ok: boolean;
    jwksUri: string | null;
    authorizationEndpoint: string | null;
    tokenEndpoint: string | null;
    error: string | null;
  };
}

function providerStatus(
  env: OidcEnv,
  provider: IdpProviderConfig
): AdminSsoProviderStatus {
  return {
    provider: provider.provider,
    issuer: provider.issuer,
    // The full client id and every secret stay server-side.
    clientIdMasked: maskOidcClientId(provider.audience),
    clientSecretConfigured: Boolean(
      getClientSecretForProvider(env, provider.provider)
    ),
    jwksUri: provider.jwksUri ?? null,
  };
}

async function probeDiscovery(
  provider: IdpProviderConfig
): Promise<NonNullable<AdminSsoProviderStatus['discovery']>> {
  try {
    const discovery = await fetchOidcDiscovery(provider.issuer, true);
    return {
      ok: true,
      jwksUri: discovery.jwks_uri ?? null,
      authorizationEndpoint: discovery.authorization_endpoint ?? null,
      tokenEndpoint: discovery.token_endpoint ?? null,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      jwksUri: null,
      authorizationEndpoint: null,
      tokenEndpoint: null,
      error: err instanceof Error ? err.message : 'Discovery probe failed',
    };
  }
}

export function registerAdminSsoRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/admin/sso/status — read-only IdP visibility for sys_admin and
   * sec_admin. Secrets are never serialized; client ids are always masked.
   * `?probeDiscovery=1` adds a lightweight reachability check and still
   * returns 200 when the IdP is unreachable.
   */
  routes.get('/sso/status', async (c) => {
    const user = getAuthenticatedUser(c);
    const providers = buildConfiguredIdpProviders(c.env);
    const shouldProbe =
      c.req.query('probeDiscovery') === '1' ||
      c.req.query('probeDiscovery') === 'true';

    const providerStatuses = await Promise.all(
      providers.map(async (provider) => {
        const status = providerStatus(c.env, provider);
        if (shouldProbe) {
          const discovery = await probeDiscovery(provider);
          status.discovery = discovery;
          if (!status.jwksUri) {
            status.jwksUri = discovery.jwksUri;
          }
        }
        return status;
      })
    );

    const ssoPolicy = await loadSsoPolicy(c.env.DB, user.tenantId);

    return c.json({
      providers: providerStatuses,
      callbackUrl: `${getCallbackBaseOrigin(c.env, c.req.url)}/auth/callback`,
      environment: c.env.ENVIRONMENT ?? 'unconfigured',
      allowDevAuth: c.env.ALLOW_DEV_AUTH === 'true',
      requireSsoLogin: ssoPolicy.requireSsoLogin,
      ssoAllowedDomains: ssoPolicy.allowedDomains,
      clientIp: resolveClientIp(c),
    });
  });
}
