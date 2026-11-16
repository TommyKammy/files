import { Hono } from 'hono';
import type { ScimHonoEnv } from '../types/scim';
import { registerScimUserListRoutes } from './scim-users/list';
import { registerScimUserCreateRoutes } from './scim-users/create';
import { registerScimUserUpdateRoutes } from './scim-users/update';
import { registerScimUserPatchRoutes } from './scim-users/patch';
import { registerScimUserDeleteRoutes } from './scim-users/delete';

export const scimUsersRoutes = new Hono<ScimHonoEnv>();

registerScimUserListRoutes(scimUsersRoutes);
registerScimUserCreateRoutes(scimUsersRoutes);
registerScimUserUpdateRoutes(scimUsersRoutes);
registerScimUserPatchRoutes(scimUsersRoutes);
registerScimUserDeleteRoutes(scimUsersRoutes);
