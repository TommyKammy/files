#!/usr/bin/env node
/**
 * Issue a tenant- and IdP-issuer-scoped SCIM 2.0 Bearer token.
 * Stores only the SHA-256 hex digest in D1 `scim_tokens`; prints the plaintext token once.
 *
 * Usage:
 *   node scripts/issue-scim-token.mjs --tenant tenant-default --issuer https://okta.example.com/oauth2/default --name "Okta Production SCIM" [--env local|staging|production] [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'dry-run' || key === 'local' || key === 'remote' || key === 'help') {
      args[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for flag --${key}`);
    }
    args[key] = next;
    i++;
  }
  return args;
}

function escapeSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node scripts/issue-scim-token.mjs --tenant <tenant_id> --issuer <idp_issuer> [--name <label>] [--env local|staging|production] [--dry-run]',
      '',
      'Examples:',
      '  node scripts/issue-scim-token.mjs --tenant tenant-default --issuer https://okta.example.com/oauth2/default --name "Okta SCIM" --env local',
      '  node scripts/issue-scim-token.mjs --tenant tenant-acme --issuer https://login.microsoftonline.com/<tid>/v2.0 --name "Entra SCIM" --env staging',
    ].join('\n')
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const tenantId = args.tenant;
const idpIssuer = args.issuer;
const tokenName = args.name ?? 'SCIM Provisioning Token';
const targetEnv = args.env ?? (args.remote ? 'staging' : 'local');
const dryRun = Boolean(args['dry-run']);

if (!tenantId || !idpIssuer) {
  console.error('Error: --tenant and --issuer are required.');
  printUsage();
  process.exit(1);
}

if (!['local', 'staging', 'production'].includes(targetEnv)) {
  console.error(`Error: invalid --env "${targetEnv}". Use local, staging, or production.`);
  process.exit(1);
}

const tokenId = `scim_${randomUUID()}`;
const rawSecret = randomBytes(32).toString('base64url');
const plaintextToken = `scim_live_${rawSecret}`;
const tokenHash = createHash('sha256').update(plaintextToken).digest('hex');
const createdAt = new Date().toISOString();

const sql = [
  'INSERT INTO scim_tokens (id, tenant_id, idp_issuer, name, token_hash, created_at)',
  `VALUES (${escapeSqlLiteral(tokenId)}, ${escapeSqlLiteral(tenantId)}, ${escapeSqlLiteral(idpIssuer)}, ${escapeSqlLiteral(tokenName)}, ${escapeSqlLiteral(tokenHash)}, ${escapeSqlLiteral(createdAt)});`,
].join('\n');

if (dryRun) {
  console.log('--- DRY RUN (no D1 write executed) ---');
  console.log(`Token ID:   ${tokenId}`);
  console.log(`Tenant ID:  ${tenantId}`);
  console.log(`IdP Issuer: ${idpIssuer}`);
  console.log(`Token Name: ${tokenName}`);
  console.log(`Plaintext:  ${plaintextToken}`);
  console.log(`SHA-256:    ${tokenHash}`);
  console.log('\nSQL:\n' + sql);
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const apiDir = join(repoRoot, 'apps', 'api');
const tmpDir = mkdtempSync(join(tmpdir(), 'files-scim-token-'));
const sqlPath = join(tmpDir, 'insert-scim-token.sql');

try {
  writeFileSync(sqlPath, sql, 'utf8');
  const wranglerArgs = ['exec', 'wrangler', 'd1', 'execute', 'DB'];
  if (targetEnv === 'local') {
    wranglerArgs.push('--local');
  } else {
    wranglerArgs.push('--remote', '--env', targetEnv);
  }
  wranglerArgs.push('--file', sqlPath);

  execFileSync('pnpm', wranglerArgs, {
    cwd: apiDir,
    stdio: 'inherit',
  });

  console.log('\n============================================================');
  console.log('SCIM 2.0 Bearer Token Issued (shown ONCE — store securely!)');
  console.log('============================================================');
  console.log(`Environment: ${targetEnv}`);
  console.log(`Token ID:    ${tokenId}`);
  console.log(`Tenant ID:   ${tenantId}`);
  console.log(`IdP Issuer:  ${idpIssuer}`);
  console.log(`Name:        ${tokenName}`);
  console.log(`Bearer Token: ${plaintextToken}`);
  console.log(`Hash (D1):   ${tokenHash}`);
  console.log('============================================================');
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
