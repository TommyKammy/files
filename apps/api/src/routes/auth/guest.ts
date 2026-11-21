import { Hono } from 'hono';
import type { OidcHonoEnv } from '../../types/oidc';
import { registerGuestAcceptRoutes } from './guest/accept';
import { registerGuestOtpRoutes } from './guest/otp-login';

export function registerGuestAuthRoutes(routes: Hono<OidcHonoEnv>) {
  registerGuestAcceptRoutes(routes);
  registerGuestOtpRoutes(routes);
}
