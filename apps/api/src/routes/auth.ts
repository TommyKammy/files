import { Hono } from 'hono';
import type { OidcHonoEnv } from '../types/oidc';
import { registerDevAuthRoutes } from './auth/dev';
import { registerGuestAuthRoutes } from './auth/guest';
import { registerOidcRoutes } from './auth/oidc';
import { registerSessionRoutes } from './auth/session';

export const authRoutes = new Hono<OidcHonoEnv>();

registerOidcRoutes(authRoutes);
registerSessionRoutes(authRoutes);
registerDevAuthRoutes(authRoutes);
registerGuestAuthRoutes(authRoutes);
