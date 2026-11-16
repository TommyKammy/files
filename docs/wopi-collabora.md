# WOPI / Collabora Online Integration

Phase 7 adds collaborative Office editing through a self-hosted Collabora
Online container. Files are fetched and saved through the Workers WOPI host;
the browser only embeds the Collabora editor iframe.

## Trust boundary

```text
Browser -> Next.js (/workspace) -> Collabora iframe
                          |
                          v
                 Files Workers /wopi/*
                          |
                          v
                     R2 + D1
```

- Collabora never receives D1 credentials or direct R2 credentials.
- WOPI access tokens are short-lived AES-GCM tokens bound to
  `fileId` / `userId` / `tenantId` / session ID.
- `confidential` and `previewer` sessions force
  `DisablePrint`, `DisableExport`, `DisableCopy` and a dynamic watermark.
- `WOPI_ALLOWED_CLIENT_IPS` can restrict the WOPI host to the Collabora
  container/VPC address range.

## Local validation (Mac Studio)

1. Start Collabora:

   ```bash
   docker compose -f docker-compose.collabora.yml up -d
   curl -fsS http://localhost:9980/hosting/discovery | head
   ```

2. Configure the API (`apps/api/.dev.vars`):

   ```text
   WOPI_HOST_ORIGIN=http://127.0.0.1:8787
   COLLABORA_URL=http://localhost:9980
   WOPI_TOKEN_SECRET=<random 32+ byte secret>
   WOPI_ALLOWED_CLIENT_IPS=
   ```

3. Configure the web app (`apps/web/.env.local`):

   ```text
   COLLABORA_URL=http://localhost:9980
   ```

4. Run the API and web app:

   ```bash
   pnpm --filter @files/api dev
   pnpm --filter @files/web dev
   ```

The web CSP `frame-src` is generated from `COLLABORA_URL`, so only the
configured Collabora origin can be embedded. Collabora's `aliasgroup1`
allowlists the WOPI host origins it may call. The local compose file allows
both the interactive `:8787` API and the isolated Playwright `:18787` API.

For the isolated Playwright stack, `e2e/scripts/start-api.mjs` binds Wrangler
to `0.0.0.0` and advertises `WOPI_HOST_ORIGIN=http://host.docker.internal:18787`,
because `127.0.0.1` from inside the Collabora container points at the container
itself. This binding is scoped to the E2E-only port and state directory.

## Session flow

1. `POST /api/files/:id/wopi-session` resolves RBAC and returns:
   - `accessToken`
   - `wopiSrc` (absolute `/wopi/files/:id` URL)
   - `wopiActionUrl` (resolved from `/hosting/discovery`)
   - `canWrite` / `readOnly`
2. The web UI POSTs `access_token` + `WOPISrc` into the Collabora iframe.
3. Collabora calls:
   - `GET /wopi/files/:id` — `CheckFileInfo`
   - `GET /wopi/files/:id/contents` — `GetFile`
   - `POST /wopi/files/:id` — `LOCK` / `GET_LOCK` / `REFRESH_LOCK` / `UNLOCK`
   - `POST /wopi/files/:id/contents` — `PutFile`
4. Autosaves create UUID-suffixed R2 drafts. `UNLOCK` promotes the last draft
   to a formal `file_versions` row and emits `file.version_finalized`.

## Production deployment

- Run Collabora in Cloudflare Containers or an organization VPC
  (ECS / Cloud Run). Do not expose it to the public internet.
- Pin the container image version; `latest` is for local validation only.
- Set `COLLABORA_URL` to the private HTTPS origin reachable from Workers.
- Set `WOPI_HOST_ORIGIN` to the public API origin Collabora can reach.
- Set `WOPI_TOKEN_SECRET` via secret storage, not plain vars.
- Restrict `WOPI_ALLOWED_CLIENT_IPS` to the Collabora egress addresses.
- Keep the Next.js CSP `frame-src` limited to the same Collabora origin.
- Use `COLLABORA_URL` as an HTTPS origin in staging/production; the web proxy
  rejects non-HTTP(S) values.

## Files Drive lock REST API

Future Files Drive clients share the same `FileLockHub` instance as WOPI.

```text
POST   /api/files/:id/lock         { lockId?, ttlSeconds? }
GET    /api/files/:id/lock-status
DELETE /api/files/:id/lock         { lockId }  (or X-Drive-Lock)
```

- A `desktop_exclusive` lock makes WOPI `CheckFileInfo` return
  `ReadOnly: true` / `UserCanWrite: false`.
- A `wopi_collab` lock makes Drive lock acquisition return
  `409 WOPI_LOCK_ACTIVE` with `readOnlyRecommended: true`,
  `webEditUrl`, and `wopiSessionPath`.
- `confidential` files return `syncPolicy: 'cloud_preview_only'` so desktop
  clients can suppress local caching.
- `GET /lock-status` reports the current lock, `canWrite`, `readOnly`, and
  `syncPolicy`.

### Phase 7 validation

The API/security matrix is covered by `vitest-pool-workers`
(`file-lock-api.test.ts`, `wopi-host.test.ts`, `wopi-drafts.test.ts`).
The real-container Playwright suite (`e2e/collabora.spec.ts`, `@collabora`)
covers two-browser collaborative editing, `TenantSyncHub` lock propagation,
`PutFile`/`UNLOCK` version promotion, `previewer`/`confidential` DLP viewer
mode, and `desktop_exclusive` read-only exclusion. Desktop-client integration
(macOS FileProvider / Windows Cloud Files) remains a later Files Drive phase.

## Benchmark-seeded files

The local benchmark seed creates metadata-only rows (for example
`file-0109999`) without corresponding `file_versions` / R2 objects.
Opening those files cannot succeed and the API now returns
`409 WOPI_CONTENT_NOT_FOUND` before creating a WOPI session, instead of
letting Collabora show a misleading WebSocket/proxy error.

For interactive editing tests, upload a real `.docx` / `.xlsx` / `.txt`
file through the workspace, or seed both `file_versions` and the R2 object.

## Japanese fonts and Hina Mincho default

`docker-compose.collabora.yml` builds `docker/collabora-ja/Dockerfile`, which adds:

- Noto Sans CJK / Noto Serif CJK (Debian `fonts-noto-cjk` + `fonts-noto-cjk-extra`)
- IPAex Gothic / IPAex Mincho
- Hina Mincho (`HinaMincho-Regular.ttf`, SIL OFL)

Hina Mincho is prepended to LibreOffice's VCL `LATIN_TEXT`, `CJK_TEXT`, and
`SERIF` default font lists for every locale. Fontconfig also maps the
unavailable Japanese fonts `MS Mincho` / `Yu Mincho` to Hina Mincho.

Calibri is **not** replaced. Calibri documents continue to use the bundled
metric-compatible Carlito font, and other explicitly specified fonts are left
untouched. MS Gothic / Yu Gothic / Meiryo fall back to Noto Sans CJK JP.

The result is:

- New/default Japanese text uses Hina Mincho.
- Calibri documents keep Calibri metrics via Carlito.
- Existing documents that explicitly embed/specify another font keep it.
- MS Gothic / Yu Gothic / Meiryo fall back to Noto Sans CJK JP for readability.

Verify after rebuilding:

```bash
docker compose -f docker-compose.collabora.yml build --no-cache
docker compose -f docker-compose.collabora.yml up -d
```

Open a Japanese document; the Collabora font box should show `Hina Mincho`
for default text, and PDF export should embed `HinaMincho-Regular`.
