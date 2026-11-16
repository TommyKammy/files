import { buildAdminGuestQuery } from '@/lib/admin-guests';
import type {
  AdminGuestDetailResponse,
  AdminGuestListQuery,
  AdminGuestListResponse,
  AdminGuestMutationResponse,
  AdminGuestResendInviteResponse,
  ExternalDomainExistingGuestMode,
} from '@/types/files';
import { apiFetch } from './core';

/** P10-3 / TOM-61 tenant-admin guest lifecycle API client. */

export function fetchAdminGuests(
  query: AdminGuestListQuery = {}
): Promise<AdminGuestListResponse> {
  return apiFetch(`/api/admin/guests${buildAdminGuestQuery(query)}`);
}

export function fetchAdminGuestDetail(
  guestId: string
): Promise<AdminGuestDetailResponse> {
  return apiFetch(`/api/admin/guests/${encodeURIComponent(guestId)}`);
}

export function suspendAdminGuest(
  guestId: string,
  options: { idempotencyKey: string }
): Promise<AdminGuestMutationResponse> {
  return apiFetch(
    `/api/admin/guests/${encodeURIComponent(guestId)}/suspend`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': options.idempotencyKey },
      body: JSON.stringify({ idempotencyKey: options.idempotencyKey }),
    }
  );
}

export function resumeAdminGuest(
  guestId: string,
  options: {
    idempotencyKey: string;
    expiresAt?: string;
    extendDays?: number;
  }
): Promise<AdminGuestMutationResponse> {
  return apiFetch(`/api/admin/guests/${encodeURIComponent(guestId)}/resume`, {
    method: 'POST',
    headers: { 'Idempotency-Key': options.idempotencyKey },
    body: JSON.stringify({
      idempotencyKey: options.idempotencyKey,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      ...(options.extendDays !== undefined
        ? { extendDays: options.extendDays }
        : {}),
    }),
  });
}

export function resendAdminGuestInvite(
  guestId: string,
  options: { idempotencyKey: string; invitationId?: string | null }
): Promise<AdminGuestResendInviteResponse> {
  return apiFetch(
    `/api/admin/guests/${encodeURIComponent(guestId)}/resend-invite`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': options.idempotencyKey },
      body: JSON.stringify({
        idempotencyKey: options.idempotencyKey,
        ...(options.invitationId
          ? { invitationId: options.invitationId }
          : {}),
      }),
    }
  );
}

export function offboardAdminGuest(
  guestId: string,
  options: { idempotencyKey: string }
): Promise<AdminGuestMutationResponse> {
  return apiFetch(`/api/admin/guests/${encodeURIComponent(guestId)}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': options.idempotencyKey },
    body: JSON.stringify({ idempotencyKey: options.idempotencyKey }),
  });
}

export function updateAdminGuestDomainPolicy(payload: {
  externalDomainAllowlist?: string[];
  externalDomainExistingGuestMode?: ExternalDomainExistingGuestMode;
}): Promise<unknown> {
  return apiFetch('/api/admin/policies', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}
