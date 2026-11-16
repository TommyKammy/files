import type {
  CreateGuestInvitationPayload,
  GuestAcceptResponse,
  GuestInvitationListResponse,
  GuestInvitationSummary,
  GuestInviteMeta,
  GuestOtpRequestResponse,
  GuestOtpVerifyResponse,
  GuestSummaryResponse,
} from '@/types/files';
import { apiFetch } from './core';

export interface GuestInvitationTargetQuery {
  targetType?: 'folder' | 'file';
  targetId?: string;
}

export function buildGuestInvitationPayload(
  payload: CreateGuestInvitationPayload
): CreateGuestInvitationPayload & { email: string } {
  const displayName = payload.displayName?.trim();
  const externalOrg = payload.externalOrg?.trim();
  return {
    email: payload.email.trim().toLowerCase(),
    ...(displayName ? { displayName } : {}),
    ...(externalOrg ? { externalOrg } : {}),
    targetType: payload.targetType,
    targetId: payload.targetId.trim(),
    role: payload.role,
  };
}

export function buildGuestOtpRequestPayload(email: string): { email: string } {
  return { email: email.trim().toLowerCase() };
}

export function buildGuestOtpVerifyPayload(
  email: string,
  otp: string
): { email: string; otp: string } {
  return {
    email: email.trim().toLowerCase(),
    otp: otp.replace(/\D+/g, '').slice(0, 6),
  };
}

export function fetchGuestInvitations(
  query: GuestInvitationTargetQuery = {}
): Promise<GuestInvitationListResponse> {
  const params = new URLSearchParams();
  if (query.targetType) params.set('targetType', query.targetType);
  if (query.targetId) params.set('targetId', query.targetId);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(`/api/guests/invitations${suffix}`);
}

export function createGuestInvitation(
  payload: CreateGuestInvitationPayload
): Promise<{ invitation: GuestInvitationSummary | null; notice?: string }> {
  return apiFetch('/api/guests/invitations', {
    method: 'POST',
    body: JSON.stringify(buildGuestInvitationPayload(payload)),
  });
}

export function resendGuestInvitation(
  invitationId: string
): Promise<{ invitation: GuestInvitationSummary | null; notice?: string }> {
  return apiFetch(
    `/api/guests/invitations/${encodeURIComponent(invitationId)}/resend`,
    { method: 'POST' }
  );
}

export function revokeGuestInvitation(
  invitationId: string
): Promise<{
  ok: boolean;
  invitation: GuestInvitationSummary | null;
  notice?: string;
}> {
  return apiFetch(
    `/api/guests/invitations/${encodeURIComponent(invitationId)}/revoke`,
    { method: 'POST' }
  );
}

/** GET /api/guests/:userId/summary — internal-only guest detail card. */
export function fetchGuestSummary(
  userId: string
): Promise<GuestSummaryResponse> {
  return apiFetch(
    `/api/guests/${encodeURIComponent(userId)}/summary`
  );
}

export function fetchGuestInviteMeta(token: string): Promise<{ invitation: GuestInviteMeta }> {
  return apiFetch(
    `/auth/guest/invite-meta?token=${encodeURIComponent(token.trim())}`
  );
}

export function acceptGuestInvitation(token: string): Promise<GuestAcceptResponse> {
  return apiFetch('/auth/guest/accept', {
    method: 'POST',
    body: JSON.stringify({ token: token.trim() }),
  });
}

export function requestGuestOtp(email: string): Promise<GuestOtpRequestResponse> {
  return apiFetch('/auth/guest/otp/request', {
    method: 'POST',
    body: JSON.stringify(buildGuestOtpRequestPayload(email)),
  });
}

export function verifyGuestOtp(
  email: string,
  otp: string
): Promise<GuestOtpVerifyResponse> {
  return apiFetch('/auth/guest/otp/verify', {
    method: 'POST',
    body: JSON.stringify(buildGuestOtpVerifyPayload(email, otp)),
  });
}
