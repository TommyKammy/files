import type { StorageStatsResponse } from './admin';
import type { ClassificationLabel, ResourceRole } from './core';

export type AdminInsightsRangeDays = 7 | 30;

export interface AdminInsightsBlockedActionRow {
  action: string;
  count: number;
}

export interface AdminInsightsTrendPoint {
  day: string;
  activeUsers: number;
  activeGuests: number;
  newFiles: number;
  downloads: number;
  sharedLinksCreated: number;
  blockedAudits: number;
  usedBytesSnapshot: number;
  totalFilesSnapshot: number;
}

export interface AdminInsightsResponse {
  rangeDays: AdminInsightsRangeDays;
  generatedAt: string;
  storage: StorageStatsResponse;
  security: {
    blocked7dCount: number;
    blocked30dCount: number;
    blockedRecentCount: number;
    blockedByAction: AdminInsightsBlockedActionRow[];
    unsetSharedFilesCount: number;
    activeSharedLinksCount: number;
    publicSharedLinksCount: number;
    activeFileLocksCount: number;
    expiringGuestsCount: number;
  };
  collaboration: {
    activeMembers: number;
    suspendedMembers: number;
    activeGuests: number;
    expiringGuests72h: number;
    groupsCount: number;
    activeSessionsCount: number;
  };
  trends: AdminInsightsTrendPoint[];
}

export interface AiSuggestionItem {
  fileId: string;
  folderId: string | null;
  folderName: string | null;
  name: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number;
  currentClassification: ClassificationLabel;
  suggestedLabel: ClassificationLabel;
  confidence: number | null;
  reason: string | null;
  uploaderEmail: string | null;
  updatedAt: string;
}

export type TosTargetAudience = 'all_users' | 'guests_only' | 'members_only';

export interface TenantBranding {
  orgName: string | null;
  contactInfo: string | null;
  footerNote: string | null;
  logoUrl?: string | null;
  accentColor?: string | null;
}

/** GET /api/auth/tos and `/api/sync/bootstrap` TOS projection. */
export interface TosStatus {
  enabled: boolean;
  applicable: boolean;
  targetAudience: TosTargetAudience;
  version: number;
  title: string;
  bodyMarkdown: string;
  requiresAcceptance: boolean;
  accepted: boolean;
  acceptedVersion: number | null;
  acceptedAt: string | null;
  updatedAt: string | null;
}

export interface TosStatusResponse {
  tos: TosStatus;
  branding: TenantBranding;
}

export interface AdminTosPolicy {
  enabled: boolean;
  version: number;
  targetAudience: TosTargetAudience;
  title: string;
  bodyMarkdown: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AdminSiemSettings {
  enabled: boolean;
  url: string | null;
  secretConfigured: boolean;
  events: string[];
  updatedAt: string | null;
}

export interface UpdateAdminTosPayload {
  enabled?: boolean;
  targetAudience?: TosTargetAudience;
  title?: string;
  bodyMarkdown?: string;
  bumpVersion?: boolean;
}

export interface UpdateAdminSiemPayload {
  enabled?: boolean;
  url?: string | null;
  secret?: string;
  clearSecret?: boolean;
  events?: string[];
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorIp: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  classificationSnapshot: ClassificationLabel | null;
  status: 'allowed' | 'blocked';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* P9-7 / TOM-57 permission audit & admin bulk operations              */
/* ------------------------------------------------------------------ */

export type AdminPermissionTargetType = 'all' | 'folder' | 'file';
export type AdminPermissionSource = 'all' | 'direct' | 'inherited';
export type AdminPermissionGranteeStatus = 'active' | 'suspended' | 'deleted';
export type AdminPermissionHealth =
  | 'all'
  | 'owner_missing'
  | 'inactive_owner';
export type AdminPermissionSortBy =
  | 'createdAt'
  | 'role'
  | 'targetName'
  | 'granteeName';
export type AdminPermissionSortDir = 'asc' | 'desc';

export interface AdminPermissionAuditEntry {
  id: string;
  permissionId: string;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  classification: ClassificationLabel;
  targetDeletedAt: string | null;
  rootFolderId: string | null;
  rootFolderName: string | null;
  granteeType: 'user' | 'group';
  granteeId: string;
  granteeName: string;
  granteeEmail: string | null;
  granteeStatus: AdminPermissionGranteeStatus;
  role: ResourceRole;
  source: 'direct' | 'inherited';
  inheritedFromId: string | null;
  inheritedFromName: string | null;
  inheritedDepth: number;
  grantedBy: string;
  grantedByName: string | null;
  grantedByEmail: string | null;
  createdAt: string;
}

export interface AdminPermissionRootSummary {
  id: string;
  name: string;
  classification: ClassificationLabel;
  archived: boolean;
  deletedAt: string | null;
  ownerCount: number;
  activeOwnerCount: number;
  coOwnerCount: number;
  editorCount: number;
  totalGrantCount: number;
  ownerMissing: boolean;
  hasSuspendedOwner: boolean;
  hasDeletedOwner: boolean;
}

export interface AdminPermissionAnomaliesSummary {
  ownerMissingCount: number;
  suspendedOwnerCount: number;
  deletedOwnerCount: number;
  inactiveGranterCount: number;
  suspendedGranteeCount: number;
  deletedGranteeCount: number;
}

export interface AdminPermissionAuditResponse {
  entries: AdminPermissionAuditEntry[];
  totalCount: number;
  nextOffset: number | null;
  rootSummaries: AdminPermissionRootSummary[];
  anomaliesSummary: AdminPermissionAnomaliesSummary;
}

export interface AdminPermissionAuditQuery {
  targetType?: 'all' | 'folder' | 'file';
  targetId?: string | null;
  rootFolderId?: string | null;
  includeInherited?: boolean;
  grantee?: string | null;
  granteeType?: 'user' | 'group' | null;
  role?: ResourceRole[] | string | null;
  source?: AdminPermissionSource;
  inheritedFromId?: string | null;
  grantedBy?: string | null;
  from?: string | null;
  to?: string | null;
  granteeStatus?: AdminPermissionGranteeStatus | null;
  health?: AdminPermissionHealth;
  sortBy?: AdminPermissionSortBy;
  sortDir?: AdminPermissionSortDir;
  limit?: number;
  offset?: number;
}

/* ------------------------------------------------------------------ */
/* P13-3 / TOM-68 asynchronous & scheduled admin reports               */
/* ------------------------------------------------------------------ */

export type AdminReportType =
  | 'user_activity'
  | 'shared_links_inventory'
  | 'access_stats'
  | 'users_and_guests';

export type AdminReportStatus = 'queued' | 'running' | 'completed' | 'failed';
export type AdminReportCadence = 'weekly' | 'monthly';
export type AdminReportFilterStatus = 'allowed' | 'blocked';

export interface AdminReportFilters {
  from?: string;
  to?: string;
  actorEmail?: string;
  targetId?: string;
  targetType?: string;
  status?: AdminReportFilterStatus;
  actionPrefix?: string;
}

export interface AdminReportJobRow {
  id: string;
  tenantId: string;
  scheduleId: string | null;
  reportType: AdminReportType;
  status: AdminReportStatus;
  filters: AdminReportFilters;
  r2ObjectKey: string | null;
  rowCount: number;
  byteSize: number;
  errorMessage: string | null;
  createdBy: string;
  createdByEmail: string | null;
  expiresAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  downloadUrl?: string;
}

export interface AdminReportScheduleRow {
  id: string;
  tenantId: string;
  name: string;
  reportType: AdminReportType;
  cadence: AdminReportCadence;
  enabled: boolean;
  filters: AdminReportFilters;
  retentionDays: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminReportListResponse {
  jobs: AdminReportJobRow[];
}

export interface AdminReportScheduleListResponse {
  schedules: AdminReportScheduleRow[];
}

export interface AdminReportJobCreateResponse {
  job: AdminReportJobRow;
  jobId: string;
  downloadUrl: string;
}

export interface AdminReportScheduleCreateResponse {
  schedule: AdminReportScheduleRow;
}

export interface AdminReportSignedUrlResponse {
  url: string;
  method: 'GET';
  expiresAt: string;
  expiresInSeconds: number;
  filename: string;
  reportType: AdminReportType;
  rowCount: number;
  byteSize: number;
}
