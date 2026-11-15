import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TENANT_ID = 'tenant-default';
const DEFAULT_FILES_COUNT = 1_000_000;
const USERS_COUNT = 1_000;
const GROUPS_COUNT = 50;
const FOLDERS_COUNT = 30_000;
const HOTSPOT_FILES_COUNT = 50_000;
const AI_QUEUE_COUNT = 5_000;
const BATCH_SIZE = 25_000;

function parseArgs(argv) {
  let dbPath = null;
  let totalFiles = DEFAULT_FILES_COUNT;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    } else if (arg.startsWith('--files=')) {
      const parsed = Number.parseInt(arg.slice('--files='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        totalFiles = parsed;
      }
    }
  }
  return { dbPath, totalFiles };
}

function findLocalD1Sqlite(explicitPath) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const dir = path.resolve(
    'apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject'
  );
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Local D1 directory not found: ${dir}. Run "pnpm db:migrate:local" first.`
    );
  }

  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
    .map((f) => path.join(dir, f));

  for (const candidate of candidates) {
    const probe = new DatabaseSync(candidate, { open: true, readOnly: true });
    try {
      const hit = probe
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'files'")
        .get();
      if (hit?.ok === 1) {
        return candidate;
      }
    } finally {
      probe.close();
    }
  }

  throw new Error(
    `No migrated D1 SQLite database found under ${dir}. Run "pnpm db:migrate:local" first.`
  );
}

function pad(num, width) {
  return String(num).padStart(width, '0');
}

function main() {
  const { dbPath: argDbPath, totalFiles } = parseArgs(process.argv);
  const dbPath = findLocalD1Sqlite(argDbPath);
  const hotspotCount = Math.min(HOTSPOT_FILES_COUNT, totalFiles);
  const aiQueueCount = Math.min(AI_QUEUE_COUNT, totalFiles);

  console.log(`[seed-1m] Target SQLite: ${dbPath}`);
  console.log(
    `[seed-1m] Planned volume: ${USERS_COUNT} users, ${GROUPS_COUNT} groups, ${FOLDERS_COUNT} folders, ${totalFiles.toLocaleString()} files`
  );

  const startedAt = performance.now();
  const db = new DatabaseSync(dbPath);
  const baseMs = Date.UTC(2026, 10, 1, 0, 0, 0);
  const nowIso = new Date().toISOString();

  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -524288;
      PRAGMA foreign_keys = OFF;
    `);

    console.log('[seed-1m] Clearing existing rows...');
    db.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM audit_logs;
      DELETE FROM file_requests;
      DELETE FROM shared_links;
      DELETE FROM permissions;
      DELETE FROM files_fts;
      DELETE FROM tenant_storage_stats;
      DELETE FROM file_versions;
      DELETE FROM files;
      DELETE FROM folder_closures;
      DELETE FROM folders;
      DELETE FROM group_members;
      DELETE FROM groups;
      DELETE FROM sessions;
      DELETE FROM scim_tokens;
      DELETE FROM users;
      DELETE FROM tenant_policies;
      DELETE FROM tenants;
      COMMIT;
    `);

    // 1. Tenant, Policies, Users, Groups
    db.exec('BEGIN IMMEDIATE;');
    db.prepare(
      `INSERT INTO tenants (id, name, slug, storage_quota_bytes)
       VALUES (?, 'Files Enterprise Benchmark', 'default-bench', 109951162777600)`
    ).run(DEFAULT_TENANT_ID);

    db.prepare(
      `INSERT INTO tenant_policies (
         tenant_id, enforce_company_only_links, require_watermark_confidential,
         max_link_expiration_days, session_max_hours, trash_retention_days,
         ai_classification_mode, ai_auto_apply_threshold
       ) VALUES (?, 0, 1, 30, 12, 30, 'metadata_only', 0.90)`
    ).run(DEFAULT_TENANT_ID);

    const insertUser = db.prepare(
      `INSERT INTO users (id, tenant_id, idp_issuer, external_idp_id, email, display_name, department, role, status)
       VALUES (?, ?, 'https://idp.example.com', ?, ?, ?, ?, ?, 'active')`
    );
    for (let u = 1; u <= USERS_COUNT; u++) {
      const uid = `user-${pad(u, 6)}`;
      const role = u === 1 ? 'sys_admin' : u === 2 ? 'sec_admin' : 'member';
      insertUser.run(
        uid,
        DEFAULT_TENANT_ID,
        `ext-${uid}`,
        `${uid}@example.com`,
        `Benchmark User ${u}`,
        `Dept-${(u % 10) + 1}`,
        role
      );
    }

    const insertGroup = db.prepare(
      `INSERT INTO groups (id, tenant_id, external_idp_id, name)
       VALUES (?, ?, ?, ?)`
    );
    for (let g = 1; g <= GROUPS_COUNT; g++) {
      const gid = `group-${pad(g, 6)}`;
      insertGroup.run(gid, DEFAULT_TENANT_ID, `ext-${gid}`, `Team-${pad(g, 2)}`);
    }

    const insertGroupMember = db.prepare(
      `INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`
    );
    // Assign user-000005 to 5 groups (for Case 2 Closure RBAC test)
    for (let g = 1; g <= 5; g++) {
      insertGroupMember.run(`group-${pad(g, 6)}`, 'user-000005');
    }
    for (let u = 1; u <= USERS_COUNT; u++) {
      if (u === 5) continue;
      const g1 = ((u - 1) % GROUPS_COUNT) + 1;
      const g2 = ((u + 7) % GROUPS_COUNT) + 1;
      insertGroupMember.run(`group-${pad(g1, 6)}`, `user-${pad(u, 6)}`);
      if (g2 !== g1) {
        insertGroupMember.run(`group-${pad(g2, 6)}`, `user-${pad(u, 6)}`);
      }
    }
    db.exec('COMMIT;');
    console.log('[seed-1m] Users & Groups inserted.');

    // 2. 30,000 Folders (depth 0..5 = 6 hierarchy tiers) + Closure Table
    db.exec('BEGIN IMMEDIATE;');
    const insertFolder = db.prepare(
      `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'user-000001')`
    );
    const insertClosure = db.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       VALUES (?, ?, ?, ?)`
    );

    const ancestorsByIndex = new Array(FOLDERS_COUNT + 1);
    const depthByIndex = new Int32Array(FOLDERS_COUNT + 1);

    // Folders 1..6: deterministic 6-tier chain for Case 1 (folder-000001) & Case 2 (folder-000006)
    for (let f = 1; f <= FOLDERS_COUNT; f++) {
      const id = `folder-${pad(f, 6)}`;
      let parentIdx = 0;
      if (f >= 2 && f <= 6) {
        parentIdx = f - 1;
      } else if (f > 105) {
        // Spread across earlier folders while capping depth <= 5
        parentIdx = ((f - 106) % 5000) + 1;
        while (depthByIndex[parentIdx] >= 5) {
          parentIdx = Math.max(7, parentIdx % 100 + 7);
        }
      }

      const depth = parentIdx === 0 ? 0 : depthByIndex[parentIdx] + 1;
      depthByIndex[f] = depth;
      const parentId = parentIdx === 0 ? null : `folder-${pad(parentIdx, 6)}`;
      const classification =
        f === 1 || f <= 6 || f % 10 === 0
          ? 'confidential'
          : f % 5 === 0
            ? 'public'
            : 'internal';

      insertFolder.run(
        id,
        DEFAULT_TENANT_ID,
        parentId,
        f === 1 ? 'Hotspot-50K' : `Folder-${pad(f, 6)}`,
        depth,
        classification
      );

      const chain = parentIdx === 0 ? [id] : [...ancestorsByIndex[parentIdx], id];
      ancestorsByIndex[f] = chain;
      for (let idx = 0; idx < chain.length; idx++) {
        insertClosure.run(DEFAULT_TENANT_ID, chain[idx], id, chain.length - 1 - idx);
      }
    }

    // RBAC permissions across hotspot, deep chain, and partial subtrees for search isolation
    const insertPerm = db.prepare(
      `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES (?, ?, 'folder', ?, ?, ?, ?, 'user-000001')`
    );
    insertPerm.run('perm-0001', DEFAULT_TENANT_ID, 'folder-000001', 'user', 'user-000001', 'owner');
    insertPerm.run('perm-0002', DEFAULT_TENANT_ID, 'folder-000001', 'group', 'group-000001', 'viewer');
    insertPerm.run('perm-0003', DEFAULT_TENANT_ID, 'folder-000003', 'group', 'group-000003', 'editor');
    insertPerm.run('perm-0004', DEFAULT_TENANT_ID, 'folder-000006', 'group', 'group-000005', 'co_owner');
    for (let f = 7; f <= 20; f++) {
      insertPerm.run(
        `perm-sub-${f}`,
        DEFAULT_TENANT_ID,
        `folder-${pad(f, 6)}`,
        'group',
        'group-000002',
        'viewer'
      );
    }
    db.exec('COMMIT;');
    console.log('[seed-1m] Folders, Closures & Permissions inserted.');

    // 3. 1,000,000 Files + 1,000,000 FTS5 rows in chunked transactions
    const insertFile = db.prepare(
      `INSERT INTO files (
         id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
         upload_state, current_version_id, current_version_num, classification,
         ai_suggested_label, ai_confidence, ai_reason, ai_evaluated_at,
         created_by, updated_by, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?,
         'active', ?, 1, ?,
         ?, ?, ?, ?,
         'user-000001', 'user-000001', ?, ?
       )`
    );
    const insertFts = db.prepare(
      `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const stats = {
      confidential: { count: 0, bytes: 0 },
      internal: { count: 0, bytes: 0 },
      public: { count: 0, bytes: 0 },
      unset: { count: 0, bytes: 0 },
    };

    const aiSuggestions = ['confidential', 'internal', 'public'];
    const aiStartIndex = totalFiles - aiQueueCount + 1;

    for (let offset = 1; offset <= totalFiles; offset += BATCH_SIZE) {
      const end = Math.min(offset + BATCH_SIZE - 1, totalFiles);
      db.exec('BEGIN IMMEDIATE;');

      for (let i = offset; i <= end; i++) {
        const fileId = `file-${pad(i, 7)}`;
        const versionId = `ver-${pad(i, 7)}`;
        const isHotspot = i <= hotspotCount;
        const folderNum = isHotspot
          ? 1
          : ((i - hotspotCount - 1) % (FOLDERS_COUNT - 1)) + 2;
        const folderId = `folder-${pad(folderNum, 6)}`;

        const isAiQueue = i >= aiStartIndex;
        let classification;
        let aiSuggestedLabel = null;
        let aiConfidence = null;
        let aiReason = '';

        if (isAiQueue) {
          classification = 'unset';
          aiSuggestedLabel = aiSuggestions[i % 3];
          aiConfidence = 0.72 + ((i % 27) / 100);
          aiReason = 'Automated edge benchmark classification candidate';
        } else {
          const mod = i % 10;
          if (mod === 0) classification = 'confidential';
          else if (mod === 1) classification = 'unset';
          else if (mod === 2 || mod === 3) classification = 'public';
          else classification = 'internal';
        }

        const isSpecialSearchMatch =
          classification === 'confidential' && (i <= 2000 || (i > 60000 && i <= 65000));
        const ext = i % 3 === 0 ? 'pdf' : i % 3 === 1 ? 'docx' : 'txt';
        const mimeType =
          ext === 'pdf'
            ? 'application/pdf'
            : ext === 'docx'
              ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              : 'text/plain';
        const fileName = isHotspot
          ? `hs-${pad(i, 6)}.${ext}`
          : isSpecialSearchMatch
            ? `roadmap-q4-${pad(i, 7)}.${ext}`
            : `doc-${pad(i, 7)}.${ext}`;
        const sizeBytes = 4096 + (i % 65536);
        const tsIso = new Date(baseMs + i * 1000).toISOString();

        insertFile.run(
          fileId,
          DEFAULT_TENANT_ID,
          folderId,
          fileName,
          ext,
          mimeType,
          sizeBytes,
          versionId,
          classification,
          aiSuggestedLabel,
          aiConfidence,
          aiReason || null,
          aiSuggestedLabel ? nowIso : null,
          tsIso,
          tsIso
        );

        insertFts.run(
          fileId,
          DEFAULT_TENANT_ID,
          classification,
          fileName,
          ext,
          isSpecialSearchMatch ? 'executive confidential roadmap budget' : aiReason
        );

        stats[classification].count += 1;
        stats[classification].bytes += sizeBytes;
      }

      db.exec('COMMIT;');
      const pct = Math.round((end / totalFiles) * 100);
      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
      console.log(`[seed-1m] Inserted ${end.toLocaleString()} / ${totalFiles.toLocaleString()} files (${pct}%, ${elapsed}s)`);
    }

    // 4. Populate O(1) tenant_storage_stats & ANALYZE query planner stats
    db.exec('BEGIN IMMEDIATE;');
    const insertStat = db.prepare(
      `INSERT INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const [label, tally] of Object.entries(stats)) {
      insertStat.run(DEFAULT_TENANT_ID, label, tally.count, tally.bytes, nowIso);
    }
    db.exec('COMMIT;');

    console.log('[seed-1m] Running ANALYZE & checkpointing WAL...');
    db.exec(`
      ANALYZE;
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);

    const totalSec = ((performance.now() - startedAt) / 1000).toFixed(2);
    console.log(`[seed-1m] Done in ${totalSec}s.`);
    console.log('[seed-1m] Classification tallies:', stats);
  } finally {
    db.close();
  }
}

main();
