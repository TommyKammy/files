import { Hono } from 'hono';
import type { ScimHonoEnv } from '../types/scim';
import { registerScimGroupListRoutes } from './scim-groups/list';
import { registerScimGroupCreateRoutes } from './scim-groups/create';
import { registerScimGroupUpdateRoutes } from './scim-groups/update';
import { registerScimGroupPatchRoutes } from './scim-groups/patch';
import { registerScimGroupDeleteRoutes } from './scim-groups/delete';

export const scimGroupsRoutes = new Hono<ScimHonoEnv>();

registerScimGroupListRoutes(scimGroupsRoutes);
registerScimGroupCreateRoutes(scimGroupsRoutes);
registerScimGroupUpdateRoutes(scimGroupsRoutes);
registerScimGroupPatchRoutes(scimGroupsRoutes);
registerScimGroupDeleteRoutes(scimGroupsRoutes);
