/**
 * P11-3 / TOM-69 SCIM token console helpers.
 *
 * The implementation lives in `admin-groups.ts` with the rest of the group /
 * SCIM console rules; this module keeps the SCIM-specific import path stable.
 */
export {
  ADMIN_SCIM_TOKEN_STATUS_LABELS,
  buildScimEndpointUrl,
  canAdministrateScimTokens,
  canManageScimTokens,
  canRevokeScimToken,
  canRotateScimToken,
  canViewScimTokens,
  scimTokenPermissionNotice,
  scimTokenStatusBadgeClass,
  scimTokenStatusLabel,
  scimTokenUsageLabel,
} from '@/lib/admin-groups';
