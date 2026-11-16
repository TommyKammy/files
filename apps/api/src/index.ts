import { Hono } from 'hono';
import { handleJobsQueueBatch } from './consumers/classification-consumer';
import { runDailyMaintenance } from './consumers/maintenance-cron';
import { scimAuthMiddleware } from './middleware/scim-auth';
import { adminGovernanceRoutes, auditLogsRoutes } from './routes/admin-governance';
import { authRoutes } from './routes/auth';
import { FileLockHub } from './durable-objects/file-lock-hub';
import { TenantSyncHub } from './durable-objects/tenant-sync-hub';
import { devBenchmarkRoutes } from './routes/dev-benchmark';
import { filesClassificationRoutes } from './routes/files-classification';
import { filesMultipartUploadRoutes } from './routes/files-multipart-upload';
import { fileRequestsRoutes, publicFileRequestsRoutes } from './routes/file-requests';
import { filesUploadRoutes } from './routes/files-upload';
import { foldersRoutes } from './routes/folders';
import { permissionsRoutes } from './routes/permissions';
import { searchRoutes } from './routes/search';
import { publicShareRoutes, sharedLinksRoutes } from './routes/shared-links';
import { scimGroupsRoutes } from './routes/scim-groups';
import { scimUsersRoutes } from './routes/scim-users';
import { syncRoutes } from './routes/sync';
import { workspaceRoutes } from './routes/workspace';
import { scimJson } from './services/scim-helpers';
import { storageProxyRoutes } from './services/storage-url-provider';
import type { JobsQueueMessage } from './types/classification';
import type { OidcEnv, OidcHonoEnv } from './types/oidc';
import type { ScimHonoEnv } from './types/scim';

const app = new Hono<OidcHonoEnv>();

app.get('/', (c) => {
  if (c.env.ENVIRONMENT === 'local' && c.req.header('Accept')?.includes('text/html')) {
    return c.redirect(c.env.APP_ORIGIN ?? 'http://localhost:3000', 302);
  }
  return c.json({ error: 'Not Found' }, 404);
});

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'files-api',
    environment: c.env.ENVIRONMENT ?? 'unconfigured',
    storageMode: c.env.STORAGE_MODE,
  });
});

// CSP reports are sent anonymously by the browser. Keep this route before the
// authenticated API routes and cap the logged payload.
app.post('/api/csp-report', async (c) => {
  const report = await c.req.text();
  if (report.length <= 2000) {
    console.warn('[csp-report]', report);
  }
  return c.body(null, 204);
});

app.route('/', authRoutes);
app.route('/api', permissionsRoutes);
app.route('/api/sync', syncRoutes);
app.route('/api/workspace', workspaceRoutes);
app.route('/api/folders', foldersRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/files/multipart', filesMultipartUploadRoutes);
app.route('/api/files', filesUploadRoutes);
app.route('/api/files', filesClassificationRoutes);
app.route('/api/shared-links', sharedLinksRoutes);
app.route('/api/s', publicShareRoutes);
app.route('/api/file-requests', fileRequestsRoutes);
app.route('/api/fr', publicFileRequestsRoutes);
app.route('/api/admin', adminGovernanceRoutes);
app.route('/api/audit-logs', auditLogsRoutes);
app.route('/api/storage', storageProxyRoutes);
app.route('/api/__bench', devBenchmarkRoutes);

const scimApp = new Hono<ScimHonoEnv>();
scimApp.use('*', scimAuthMiddleware);
scimApp.get('/ServiceProviderConfig', (c) =>
  scimJson(c, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Tenant-scoped SCIM 2.0 Bearer Token',
      },
    ],
  })
);
scimApp.route('/Users', scimUsersRoutes);
scimApp.route('/Groups', scimGroupsRoutes);
app.route('/scim/v2', scimApp);

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

const worker: ExportedHandler<OidcEnv> = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async queue(batch, env, _ctx) {
    await handleJobsQueueBatch(batch as MessageBatch<JobsQueueMessage>, env);
  },
  async scheduled(_controller, env, _ctx) {
    const summary = await runDailyMaintenance(env);
    console.log('[cron] daily maintenance summary:', JSON.stringify(summary));
  },
};

export { app, FileLockHub, TenantSyncHub };
export default worker;
