import type { GuestLifecycleStatus } from '../guest-detail';

export type AdminGuestStatusFilter =
  | 'all'
  | 'active'
  | 'suspended'
  | 'expired'
  | 'pending_invite'
  | 'offboarded';

export type AdminGuestSortBy =
  | 'createdAt'
  | 'lastLoginAt'
  | 'expiresAt'
  | 'email'
  | 'externalOrg';

export type AdminGuestSortDir = 'asc' | 'desc';

export interface AdminGuestFilters {
  query: string | null;
  status: AdminGuestStatusFilter;
  domain: string | null;
  invitedBy: string | null;
  expiresBefore: string | null;
  sortBy: AdminGuestSortBy;
  sortDir: AdminGuestSortDir;
  limit: number;
  offset: number;
}

export interface AdminGuestRow {
  id: string;
  email: string;
  displayName: string;
  externalOrg: string | null;
  invitedBy: string | null;
  invitedByName: string | null;
  invitedByEmail: string | null;
  expiresAt: string | null;
  lastLoginAt: string | null;
  accountStatus: 'active' | 'suspended';
  status: GuestLifecycleStatus;
  offboardedAt: string | null;
  offboardedBy: string | null;
  domain: string | null;
  allowedByPolicy: boolean;
  pendingInvitationCount: number;
  createdAt: string;
}

export interface AdminGuestDomainSummary {
  domain: string;
  count: number;
  active: number;
  suspended: number;
  expired: number;
  allowedByPolicy: boolean;
}

export interface AdminGuestInviterSummary {
  inviterId: string;
  inviterName: string;
  inviterEmail: string | null;
  count: number;
  active: number;
  suspended: number;
  expired: number;
}

export interface AdminGuestAggregations {
  total: number;
  byStatus: Record<AdminGuestStatusFilter, number>;
  byDomain: AdminGuestDomainSummary[];
  byInviter: AdminGuestInviterSummary[];
  disallowedDomainGuestCount: number;
}

export interface AdminGuestListResult {
  guests: AdminGuestRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  sort: { by: AdminGuestSortBy; dir: AdminGuestSortDir };
  summary: AdminGuestAggregations;
  aggregations: AdminGuestAggregations;
}

export const ADMIN_GUEST_STATUS_VALUES: AdminGuestStatusFilter[] = [
  'all',
  'active',
  'suspended',
  'expired',
  'pending_invite',
  'offboarded',
];

const SORT_BY_VALUES: AdminGuestSortBy[] = [
  'createdAt',
  'lastLoginAt',
  'expiresAt',
  'email',
  'externalOrg',
];

export function isAdminGuestStatusFilter(
  value: unknown
): value is AdminGuestStatusFilter {
  return (
    typeof value === 'string' &&
    (ADMIN_GUEST_STATUS_VALUES as readonly string[]).includes(value)
  );
}

export function isAdminGuestSortBy(value: unknown): value is AdminGuestSortBy {
  return (
    typeof value === 'string' &&
    (SORT_BY_VALUES as readonly string[]).includes(value)
  );
}

export class AdminGuestError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 410 | 502 | 503,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminGuestError';
  }
}
