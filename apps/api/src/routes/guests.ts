import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { requireMemberUser } from '../services/authorization';
import type { OidcHonoEnv } from '../types/oidc';
import { registerGuestInviteRoutes } from './guests/invite';
import { registerGuestListAndRevokeRoutes } from './guests/list-and-revoke';

export const guestsRoutes = new Hono<OidcHonoEnv>();
guestsRoutes.use('*', sessionAuthMiddleware({ required: true }), requireMemberUser);

registerGuestInviteRoutes(guestsRoutes);
registerGuestListAndRevokeRoutes(guestsRoutes);
