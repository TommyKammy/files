export interface PurgeProtectionResult {
  blocked: boolean;
  reason: 'legal_hold' | 'retention_policy' | null;
  holdName?: string;
  policyName?: string;
}

export interface PurgeProtectionOptions {
  createdBy?: string | null;
  classification?: string | null;
  createdAt?: string | null;
  nowIso?: string;
}

export class PurgeProtectionError extends Error {
  public readonly status = 423 as const;
  public readonly code: 'LEGAL_HOLD_ACTIVE' | 'RETENTION_POLICY_ACTIVE';
  public readonly holdName?: string;
  public readonly policyName?: string;

  constructor(result: PurgeProtectionResult) {
    const code =
      result.reason === 'retention_policy'
        ? 'RETENTION_POLICY_ACTIVE'
        : 'LEGAL_HOLD_ACTIVE';
    super(formatPurgeProtectionMessage(result));
    this.name = 'PurgeProtectionError';
    this.code = code;
    this.holdName = result.holdName;
    this.policyName = result.policyName;
  }
}

export function formatPurgeProtectionMessage(result: PurgeProtectionResult): string {
  if (result.reason === 'retention_policy') {
    const label = result.policyName ? `「${result.policyName}」` : '';
    return `保持ポリシー${label}の保持期間内のため、完全に削除できません。`;
  }
  const label = result.holdName ? `「${result.holdName}」` : '';
  return `法的保持${label}が有効なため、完全に削除できません。`;
}

function parseTimestampMs(raw: string | null | undefined): number {
  if (!raw) return Number.NaN;
  const trimmed = raw.trim();
  // SQLite datetime('now') produces 'YYYY-MM-DD HH:MM:SS' in UTC without Z.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  return Date.parse(normalized);
}

/**
 * Evaluate whether a file or folder is protected from permanent purge by an
 * active legal hold or an active retention policy whose retention window has
 * not yet elapsed.
 */
export async function checkPurgeProtection(
  db: D1Database,
  tenantId: string,
  targetType: 'file' | 'folder',
  targetId: string,
  opts?: PurgeProtectionOptions
): Promise<PurgeProtectionResult> {
  // (a) Direct active legal hold on the target itself
  const directHold = await db
    .prepare(
      `SELECT name
         FROM legal_holds
        WHERE tenant_id = ?
          AND status = 'active'
          AND target_type = ?
          AND target_id = ?
        LIMIT 1`
    )
    .bind(tenantId, targetType, targetId)
    .first<{ name: string }>();
  if (directHold) {
    return {
      blocked: true,
      reason: 'legal_hold',
      holdName: directHold.name,
    };
  }

  let folderId: string | null = null;
  let createdBy = opts?.createdBy ?? null;
  let classification = opts?.classification ?? null;
  let createdAt = opts?.createdAt ?? null;

  if (targetType === 'file') {
    const fileRow = await db
      .prepare(
        `SELECT folder_id, created_by, classification, created_at
           FROM files
          WHERE tenant_id = ? AND id = ?`
      )
      .bind(tenantId, targetId)
      .first<{
        folder_id: string | null;
        created_by: string | null;
        classification: string | null;
        created_at: string | null;
      }>();
    if (fileRow) {
      folderId = fileRow.folder_id;
      createdBy = opts?.createdBy !== undefined ? opts.createdBy : fileRow.created_by;
      classification =
        opts?.classification !== undefined ? opts.classification : fileRow.classification;
      createdAt = opts?.createdAt !== undefined ? opts.createdAt : fileRow.created_at;
    }
  } else if (
    opts?.createdBy === undefined ||
    opts?.classification === undefined ||
    opts?.createdAt === undefined
  ) {
    const folderRow = await db
      .prepare(
        `SELECT created_by, classification, created_at
           FROM folders
          WHERE tenant_id = ? AND id = ?`
      )
      .bind(tenantId, targetId)
      .first<{
        created_by: string | null;
        classification: string | null;
        created_at: string | null;
      }>();
    if (folderRow) {
      createdBy = opts?.createdBy !== undefined ? opts.createdBy : folderRow.created_by;
      classification =
        opts?.classification !== undefined ? opts.classification : folderRow.classification;
      createdAt = opts?.createdAt !== undefined ? opts.createdAt : folderRow.created_at;
    }
  }

  // (b) Ancestor folder hold (and descendant folder / file holds when purging a folder)
  if (targetType === 'file' && folderId) {
    const ancestorHold = await db
      .prepare(
        `SELECT lh.name
           FROM folder_closures fc
           JOIN legal_holds lh
             ON lh.tenant_id = fc.tenant_id
            AND lh.status = 'active'
            AND lh.target_type = 'folder'
            AND lh.target_id = fc.ancestor_id
          WHERE fc.tenant_id = ?
            AND fc.descendant_id = ?
          LIMIT 1`
      )
      .bind(tenantId, folderId)
      .first<{ name: string }>();
    if (ancestorHold) {
      return {
        blocked: true,
        reason: 'legal_hold',
        holdName: ancestorHold.name,
      };
    }
  } else if (targetType === 'folder') {
    const relatedFolderHold = await db
      .prepare(
        `SELECT lh.name
           FROM legal_holds lh
          WHERE lh.tenant_id = ?
            AND lh.status = 'active'
            AND lh.target_type = 'folder'
            AND (
              lh.target_id IN (
                SELECT ancestor_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND descendant_id = ?
              )
              OR lh.target_id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )
            )
          LIMIT 1`
      )
      .bind(tenantId, tenantId, targetId, tenantId, targetId)
      .first<{ name: string }>();
    if (relatedFolderHold) {
      return {
        blocked: true,
        reason: 'legal_hold',
        holdName: relatedFolderHold.name,
      };
    }

    const descendantFileHold = await db
      .prepare(
        `SELECT lh.name
           FROM legal_holds lh
           JOIN files fl
             ON fl.tenant_id = lh.tenant_id
            AND lh.target_type = 'file'
            AND lh.target_id = fl.id
           JOIN folder_closures fc
             ON fc.tenant_id = fl.tenant_id
            AND fc.descendant_id = fl.folder_id
          WHERE lh.tenant_id = ?
            AND lh.status = 'active'
            AND fc.ancestor_id = ?
          LIMIT 1`
      )
      .bind(tenantId, targetId)
      .first<{ name: string }>();
    if (descendantFileHold) {
      return {
        blocked: true,
        reason: 'legal_hold',
        holdName: descendantFileHold.name,
      };
    }
  }

  // (c) Active legal hold on item creator (or creator of a file inside a purged folder)
  if (createdBy) {
    const userHold = await db
      .prepare(
        `SELECT name
           FROM legal_holds
          WHERE tenant_id = ?
            AND status = 'active'
            AND target_type = 'user'
            AND target_id = ?
          LIMIT 1`
      )
      .bind(tenantId, createdBy)
      .first<{ name: string }>();
    if (userHold) {
      return {
        blocked: true,
        reason: 'legal_hold',
        holdName: userHold.name,
      };
    }
  }

  if (targetType === 'folder') {
    const descendantUserHold = await db
      .prepare(
        `SELECT lh.name
           FROM legal_holds lh
           JOIN files fl
             ON fl.tenant_id = lh.tenant_id
            AND lh.target_type = 'user'
            AND lh.target_id = fl.created_by
           JOIN folder_closures fc
             ON fc.tenant_id = fl.tenant_id
            AND fc.descendant_id = fl.folder_id
          WHERE lh.tenant_id = ?
            AND lh.status = 'active'
            AND fc.ancestor_id = ?
          LIMIT 1`
      )
      .bind(tenantId, targetId)
      .first<{ name: string }>();
    if (descendantUserHold) {
      return {
        blocked: true,
        reason: 'legal_hold',
        holdName: descendantUserHold.name,
      };
    }
  }

  // (d) Active retention policy on ancestor folder or classification
  const createdMs = parseTimestampMs(createdAt);
  const nowMs = opts?.nowIso ? parseTimestampMs(opts.nowIso) : Date.now();
  if (!Number.isNaN(createdMs) && !Number.isNaN(nowMs)) {
    const ageDays = Math.max(0, (nowMs - createdMs) / (1000 * 60 * 60 * 24));
    const folderLookupId = targetType === 'folder' ? targetId : folderId;

    const matchingPolicies = await db
      .prepare(
        `SELECT name, retention_days
           FROM retention_policies
          WHERE tenant_id = ?
            AND enabled = 1
            AND (
              (target_type = 'classification' AND target_value = ?)
              OR (
                target_type = 'folder'
                AND ? IS NOT NULL
                AND target_value IN (
                  SELECT ancestor_id
                    FROM folder_closures
                   WHERE tenant_id = ? AND descendant_id = ?
                )
              )
            )
          ORDER BY retention_days DESC`
      )
      .bind(
        tenantId,
        classification ?? '',
        folderLookupId,
        tenantId,
        folderLookupId ?? ''
      )
      .all<{ name: string; retention_days: number }>();

    for (const policy of matchingPolicies.results) {
      if (ageDays < policy.retention_days) {
        return {
          blocked: true,
          reason: 'retention_policy',
          policyName: policy.name,
        };
      }
    }
  }

  return { blocked: false, reason: null };
}
