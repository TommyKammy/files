import { Hono } from 'hono';
import type { OidcHonoEnv } from '../types/oidc';
import { metadataTemplatesRoutes } from './metadata-templates';
import { tagsRoutes } from './tags';

export type { TagItemType } from './tags';
export type {
  MetadataFieldDefinition,
  MetadataFieldType,
} from './metadata-templates';
export { tagsRoutes } from './tags';
export { metadataTemplatesRoutes } from './metadata-templates';

export const tagsMetadataRoutes = new Hono<OidcHonoEnv>();
tagsMetadataRoutes.route('/', tagsRoutes);
tagsMetadataRoutes.route('/', metadataTemplatesRoutes);
