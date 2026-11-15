# SCIM 2.0 Provisioning & IdP Setup Guide

Files isolates tenants strictly by the SHA-256 hash stored in D1 `scim_tokens` (mapped to `(tenant_id, idp_issuer)`). Any `X-Tenant-Id` header sent by callers is ignored on `/scim/v2/*`.

## 1. Issue a Tenant SCIM Bearer Token

```bash
# Local Miniflare D1
node scripts/issue-scim-token.mjs \
  --tenant tenant-default \
  --issuer https://okta.example.com/oauth2/default \
  --name "Okta Dev SCIM" \
  --env local

# Staging / Production D1
node scripts/issue-scim-token.mjs \
  --tenant <TENANT_ID> \
  --issuer https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0 \
  --name "Entra ID SCIM" \
  --env staging
```

> The CLI stores **only the SHA-256 hex hash** in `scim_tokens` and displays the plaintext Bearer token once at issuance.

## 2. SCIM Endpoint Base URL

- Base URL: `https://<your-files-domain>/scim/v2`
- Endpoints:
  - `GET/POST /scim/v2/Users` and `GET/PUT/PATCH/DELETE /scim/v2/Users/:id`
  - `GET/POST /scim/v2/Groups` and `GET/PUT/PATCH/DELETE /scim/v2/Groups/:id`
  - `GET /scim/v2/ServiceProviderConfig`
- Authentication: `Authorization: Bearer <issued-scim-token>`

## 3. Microsoft Entra ID Provisioning Attribute Mapping

To guarantee deterministic subject correlation with OIDC ID token `oid` (mitigating nOAuth email spoofing):

1. Open **Enterprise Applications -> <Files App> -> Provisioning -> Mappings -> Provision Microsoft Entra ID Users**.
2. Set `externalId` mapping explicitly to Entra **`objectId`** (do **not** map `mailNickname` or `userPrincipalName` to `externalId`):
   - `objectId` -> `externalId` (Matching precedence: optional, primary identity key for OIDC `(tenant_id, idp_issuer, external_idp_id)`)
   - `userPrincipalName` -> `userName`
   - `displayName` -> `displayName`
   - `department` -> `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department`
   - `NOT([IsSoftDeleted])` -> `active`
3. Notes on Entra ID SCIM payload normalization handled automatically by Files:
   - Case-insensitive `op` (`"Add"`, `"Replace"`, `"Remove"`).
   - String booleans on `active` (`"False"` / `"True"`).
   - Flattened extension attribute paths (`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department`).
   - Group member removals using filter path syntax `members[value eq "<userId>"]`.

## 4. Okta SCIM 2.0 Notes

- Use Okta **SCIM 2.0 (OAuth Bearer Token)** connector.
- Configure `userName` (primary email) and `externalId` (Okta user `id` matching OIDC `sub`).
- Path-omitted `PATCH` operations (`{ op: "replace", value: { active: false } }`) are normalized automatically.
- Setting `active=false` or `DELETE /scim/v2/Users/:id` marks `users.status = 'suspended'` and revokes all active user sessions in D1 `sessions` in the same batch.
