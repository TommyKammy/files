import type { AppVariables } from './api';
import type { OidcEnv } from './oidc';

export const SCIM_CORE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_ENTERPRISE_USER_SCHEMA =
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const SCIM_CORE_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

export interface ScimContext {
  scimTokenId: string;
  tenantId: string;
  idpIssuer: string;
  tokenName: string;
}

export type ScimHonoEnv = {
  Bindings: OidcEnv;
  Variables: AppVariables;
};

export interface ScimErrorResponse {
  schemas: [typeof SCIM_ERROR_SCHEMA];
  status: string;
  scimType?: string;
  detail: string;
}

export interface ScimListResponse<T> {
  schemas: [typeof SCIM_LIST_RESPONSE_SCHEMA];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  displayName: string;
  emails: Array<{ value: string; type: 'work'; primary: boolean }>;
  active: boolean;
  [SCIM_ENTERPRISE_USER_SCHEMA]?: {
    department?: string;
  };
  meta: {
    resourceType: 'User';
    created?: string;
    lastModified?: string;
  };
}

export interface ScimGroupMemberRef {
  value: string;
  display?: string;
}

export interface ScimGroupResource {
  schemas: [typeof SCIM_CORE_GROUP_SCHEMA];
  id: string;
  externalId?: string;
  displayName: string;
  members: ScimGroupMemberRef[];
  meta: {
    resourceType: 'Group';
    created?: string;
  };
}

export interface ScimPatchOperationInput {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}
