'use client';

import { Shield } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import { FolderInvitePolicyForm } from '@/components/permissions/FolderInvitePolicyForm';
import { GuestCollaborationSection } from '@/components/permissions/GuestCollaborationSection';
import { GuestSummaryCard } from '@/components/permissions/GuestSummaryCard';
import { InvitePolicyBanner } from '@/components/permissions/InvitePolicyBanner';
import { PermissionBreakdownSection } from '@/components/permissions/PermissionBreakdownSection';
import { PermissionGrantForm } from '@/components/permissions/PermissionGrantForm';
import { PermissionsList } from '@/components/permissions/PermissionsList';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import { ROLE_META, canAccess, roleGroupsForTarget } from '@/lib/capabilities';
import { guestRoleOptions } from '@/lib/guest-collaboration';
import { usePermissionsModal } from '@/lib/use-permissions-modal';
import type { Capability, InvitePolicy, ResourceRole } from '@/types/files';

export function PermissionsModal({
  targetType,
  targetId,
  targetName,
  effectiveRole,
  targetCapabilities,
  onClose,
}: {
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  effectiveRole: ResourceRole;
  targetCapabilities?: Capability[];
  onClose: () => void;
}) {
  const {
    permissions,
    capabilities,
    advancedRolesEnabled,
    permissionInheritanceMode,
    invitePolicy,
    grantableRoles,
    guestInvitations,
    guestPolicy,
    canInvite,
    policySaving,
    policyNotice,
    setPolicyNotice,
    effectiveBreakdown,
    effectiveRole: currentEffectiveRole,
    loading,
    error,
    query,
    setQuery,
    candidates,
    setCandidates,
    searching,
    selectedPrincipal,
    setSelectedPrincipal,
    selectedPrincipalLock,
    role,
    setRole,
    submitting,
    canManage,
    handleGrant,
    handleRevoke,
    handleUpdateFolderInvitePolicy,
    reloadPermissions,
  } = usePermissionsModal({ targetType, targetId, effectiveRole });

  const effectiveCapabilities = targetCapabilities ?? capabilities;
  const canViewPermissions = canAccess(
    { capabilities: effectiveCapabilities, effectiveRole: currentEffectiveRole },
    'permission.view'
  );

  const guestSelected =
    selectedPrincipal?.type === 'user' && selectedPrincipal.userType === 'guest';
  const guestRoleCandidates = useMemo(
    () =>
      guestRoleOptions({
        targetType,
        advancedRolesEnabled,
        allowGuestElevatedRoles: guestPolicy?.allowGuestElevatedRoles ?? false,
        grantableRoles,
      }),
    [
      targetType,
      advancedRolesEnabled,
      guestPolicy?.allowGuestElevatedRoles,
      grantableRoles,
    ]
  );
  const guestAssignableRoles = useMemo(
    () =>
      guestRoleCandidates
        .filter((option) => option.enabled)
        .map((option) => option.role),
    [guestRoleCandidates]
  );

  const roleGroups = useMemo(() => {
    if (guestSelected) {
      return guestAssignableRoles.length > 0
        ? [
            {
              id: 'guest-allowed',
              label: '外部ゲストに付与できるロール',
              roles: guestAssignableRoles,
            },
          ]
        : [];
    }
    const grantable = new Set(grantableRoles);
    return roleGroupsForTarget(targetType, {
      advancedRolesEnabled,
    })
      .map((group) => ({
        ...group,
        roles: group.roles.filter(
          (candidate) =>
            grantable.has(candidate) &&
            (candidate !== 'owner' || currentEffectiveRole === 'owner')
        ),
      }))
      .filter((group) => group.roles.length > 0);
  }, [
    targetType,
    advancedRolesEnabled,
    currentEffectiveRole,
    grantableRoles,
    guestSelected,
    guestAssignableRoles,
  ]);

  // A guest principal must never keep a stale member-only role selection.
  useEffect(() => {
    if (!guestSelected) return;
    if (guestAssignableRoles.length === 0) return;
    if (!guestAssignableRoles.includes(role)) {
      setRole(guestAssignableRoles[0]!);
    }
  }, [guestSelected, guestAssignableRoles, role, setRole]);

  const assignableRoleIds = roleGroups.flatMap((group) => group.roles);
  // Keep the selected role legal when the advanced policy changes underneath us.
  const safeRole = assignableRoleIds.includes(role)
    ? role
    : assignableRoleIds[0] ?? 'viewer';

  const inheritedInviteFloor: InvitePolicy =
    invitePolicy?.inheritedFloor ??
    invitePolicy?.tenantPolicy ??
    'owners';
  const effectiveInvitePolicy = invitePolicy?.effectivePolicy ?? 'owners';
  const [folderPolicyChoice, setFolderPolicyChoice] = useState<
    InvitePolicy | null
  >(invitePolicy?.folderOwnPolicy ?? null);
  const [guestDetailUserId, setGuestDetailUserId] = useState<string | null>(
    null
  );

  useEffect(() => {
    setFolderPolicyChoice(invitePolicy?.folderOwnPolicy ?? null);
  }, [invitePolicy?.folderOwnPolicy, targetId]);

  const folderPolicyDirty =
    (invitePolicy?.folderOwnPolicy ?? null) !== folderPolicyChoice;

  return (
    <ModalShell
      label={`アクセス権限: ${targetName}`}
      onClose={onClose}
      className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <ModalHeader
        icon={<Shield className="h-4 w-4 shrink-0 text-blue-600" />}
        title={`アクセス権限: ${targetName}`}
        subtitle={`あなたの実効ロール: ${ROLE_META[currentEffectiveRole]?.label ?? currentEffectiveRole}`}
        onClose={onClose}
      />

      <div className="max-h-[75vh] space-y-5 overflow-y-auto p-5">
        <ModalError message={error} />

        {invitePolicy && (
          <InvitePolicyBanner
            targetType={targetType}
            targetId={targetId}
            invitePolicy={invitePolicy}
            effectiveInvitePolicy={effectiveInvitePolicy}
            canInvite={canInvite}
          />
        )}

        <div
          data-testid="permission-inheritance-mode"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium ${
            permissionInheritanceMode === 'waterfall'
              ? 'border-sky-200 bg-sky-50 text-sky-800'
              : 'border-slate-200 bg-slate-50 text-slate-700'
          }`}
        >
          <Shield className="h-3.5 w-3.5" />
          継承:{' '}
          {permissionInheritanceMode === 'waterfall'
            ? 'Waterfall (親優先)'
            : 'Additive (加算)'}
        </div>

        {canInvite &&
          permissionInheritanceMode === 'waterfall' &&
          selectedPrincipalLock && (
            <div
              role="alert"
              aria-live="assertive"
              data-testid="waterfall-inherited-notice"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-900"
            >
              親フォルダ「{selectedPrincipalLock.sourceName}」から権限継承中のため、この子フォルダで再付与・変更はできません。親フォルダで変更してください。
            </div>
          )}

        {!canViewPermissions ? (
          <div
            role="status"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs text-amber-800"
          >
            このリソースの権限一覧を表示する権限がありません。
          </div>
        ) : (
          <>
            {canInvite && (
              <PermissionGrantForm
                targetType={targetType}
                advancedRolesEnabled={advancedRolesEnabled}
                query={query}
                setQuery={setQuery}
                candidates={candidates}
                setCandidates={setCandidates}
                searching={searching}
                selectedPrincipal={selectedPrincipal}
                setSelectedPrincipal={setSelectedPrincipal}
                selectedPrincipalLock={selectedPrincipalLock}
                safeRole={safeRole}
                setRole={setRole}
                roleGroups={roleGroups}
                guestSelected={guestSelected}
                guestAssignableRoles={guestAssignableRoles}
                guestPolicy={guestPolicy}
                submitting={submitting}
                onSubmit={handleGrant}
              />
            )}

            <GuestCollaborationSection
              targetType={targetType}
              targetId={targetId}
              targetName={targetName}
              canInvite={canInvite}
              advancedRolesEnabled={advancedRolesEnabled}
              grantableRoles={grantableRoles}
              guestPolicy={guestPolicy}
              guestInvitations={guestInvitations}
              onReload={reloadPermissions}
              onOpenGuestDetail={setGuestDetailUserId}
            />

            {targetType === 'folder' && invitePolicy?.canEditFolderPolicy && (
              <FolderInvitePolicyForm
                inheritedInviteFloor={inheritedInviteFloor}
                folderPolicyChoice={folderPolicyChoice}
                setFolderPolicyChoice={setFolderPolicyChoice}
                folderPolicyDirty={folderPolicyDirty}
                policySaving={policySaving}
                policyNotice={policyNotice}
                setPolicyNotice={setPolicyNotice}
                onSave={handleUpdateFolderInvitePolicy}
              />
            )}

            <PermissionBreakdownSection
              effectiveBreakdown={effectiveBreakdown}
              permissions={permissions}
              targetType={targetType}
            />

            <PermissionsList
              permissions={permissions}
              loading={loading}
              canManage={canManage}
              permissionInheritanceMode={permissionInheritanceMode}
              onRevoke={handleRevoke}
              onOpenGuestDetail={setGuestDetailUserId}
            />
          </>
        )}

        {guestDetailUserId && (
          <GuestSummaryCard
            userId={guestDetailUserId}
            onClose={() => setGuestDetailUserId(null)}
          />
        )}
      </div>
    </ModalShell>
  );
}
