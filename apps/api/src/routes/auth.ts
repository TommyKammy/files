import { Hono } from 'hono';
import type { OidcHonoEnv } from '../types/oidc';
import { registerDevAuthRoutes } from './auth/dev';
import { registerGuestAuthRoutes } from './auth/guest';
import { registerOidcRoutes } from './auth/oidc';
import { registerSessionRoutes } from './auth/session';
import { registerTosAuthRoutes } from './auth/tos';

export const authRoutes = new Hono<OidcHonoEnv>();

registerOidcRoutes(authRoutes);
registerSessionRoutes(authRoutes);
registerTosAuthRoutes(authRoutes);
registerDevAuthRoutes(authRoutes);
registerGuestAuthRoutes(authRoutes);
