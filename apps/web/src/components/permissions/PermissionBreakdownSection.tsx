'use client';

import { useMemo } from 'react';
import {
  CapabilityChips,
  capabilityLabels,
} from '@/components/permissions/CapabilityChips';
import {
  ROLE_META,
  formatRoleBreakdown,
  synthesizeEffectiveAccessFromRoles,
} from '@/lib/capabilities';
import type {
  Capability,
  EffectiveBreakdownGrant,
  PermissionEntry,
  ResourceRole,
} from '@/types/files';

function grantLabel(
  entry: Pick<PermissionEntry, 'role' | 'inherited' | 'sourceName'>,
  targetType: 'folder' | 'file'
): string {
  const source = entry.inherited
    ? `親フォルダ (${entry.sourceName ?? '親フォルダ'})`
    : targetType === 'folder'
      ? 'このフォルダ'
      : 'このファイル';
  return `${source} の ${ROLE_META[entry.role]?.label ?? entry.role}`;
}

export function PermissionBreakdownSection({
  effectiveBreakdown,
  permissions,
  targetType,
}: {
  effectiveBreakdown: EffectiveBreakdownGrant[];
  permissions: PermissionEntry[];
  targetType: 'folder' | 'file';
}) {
  const requesterBreakdown = useMemo(() => {
    if (effectiveBreakdown.length === 0) return null;
    const ordered = [...effectiveBreakdown].sort(
      (a, b) => Number(b.inherited) - Number(a.inherited)
    );
    return {
      roles: ordered.map((grant) => grant.role),
      label: ordered
        .map((grant) =>
          grant.inherited
            ? `親フォルダ (${grant.sourceName ?? '親フォルダ'}) の ${
                ROLE_META[grant.role]?.label ?? grant.role
              }`
            : `この${targetType === 'folder' ? 'フォルダ' : 'ファイル'} の ${
                ROLE_META[grant.role]?.label ?? grant.role
              }`
        )
        .join(' + '),
      capabilities: synthesizeEffectiveAccessFromRoles(
        ordered.map((grant) => grant.role)
      ).capabilities,
    };
  }, [effectiveBreakdown, targetType]);

  const granteeBreakdowns = useMemo(() => {
    const groups = new Map<string, PermissionEntry[]>();
    for (const entry of permissions) {
      const key = `${entry.granteeType}:${entry.granteeId}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    const rows: Array<{
      key: string;
      name: string;
      label: string;
      roles: ResourceRole[];
      capabilities: Capability[];
      inheritedCount: number;
      directCount: number;
    }> = [];
    for (const [key, entries] of groups) {
      const inheritedCount = entries.filter((entry) => entry.inherited).length;
      const directCount = entries.length - inheritedCount;
      if (entries.length < 2) continue;
      // Inherited grants first: matches the documented breakdown example
      // (`親フォルダ の Viewer + このフォルダ の Uploader ＝ Viewer + Uploader`).
      const ordered = [...entries].sort(
        (a, b) => Number(b.inherited) - Number(a.inherited)
      );
      const roles = ordered.map((entry) => entry.role);
      rows.push({
        key,
        name: ordered[0].granteeName ?? ordered[0].granteeId,
        label: ordered
          .map((entry) => grantLabel(entry, targetType))
          .join(' + '),
        roles,
        capabilities: synthesizeEffectiveAccessFromRoles(roles).capabilities,
        inheritedCount,
        directCount,
      });
    }
    return rows;
  }, [permissions, targetType]);

  if (!requesterBreakdown && granteeBreakdowns.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="permission-breakdown-heading"
      className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4"
    >
      <h3
        id="permission-breakdown-heading"
        className="text-xs font-semibold text-indigo-900"
      >
        実効権限の内訳
      </h3>

      {requesterBreakdown && (
        <div className="space-y-1.5" data-testid="permission-breakdown-self">
          <p className="text-[0.6875rem] font-semibold text-indigo-800">
            あなたの実効権限
          </p>
          <p className="break-words text-[0.6875rem] leading-relaxed text-indigo-900">
            {requesterBreakdown.label} ＝{' '}
            <span className="font-semibold">
              {formatRoleBreakdown(requesterBreakdown.roles)}
            </span>
          </p>
          <CapabilityChips
            capabilityLabels={capabilityLabels(requesterBreakdown.capabilities)}
            ariaLabel="あなたの合成権限"
          />
        </div>
      )}

      {granteeBreakdowns.length > 0 && (
        <div className="space-y-2">
          <p className="text-[0.6875rem] font-semibold text-indigo-800">
            共同作業者の合成権限
          </p>
          {granteeBreakdowns.map((row) => (
            <div
              key={row.key}
              data-testid="permission-breakdown-grantee"
              className="space-y-1.5 rounded-lg border border-indigo-100 bg-white/80 p-2.5"
            >
              <p className="text-[0.6875rem] font-medium text-slate-800">
                {row.name}
              </p>
              <p className="break-words text-[0.6875rem] leading-relaxed text-slate-700">
                {row.label} ＝{' '}
                <span className="font-semibold text-indigo-800">
                  {formatRoleBreakdown(row.roles)}
                </span>
              </p>
              <p className="text-[0.625rem] text-slate-500">
                直接 {row.directCount} 件 / 継承 {row.inheritedCount} 件
              </p>
              <CapabilityChips
                capabilityLabels={capabilityLabels(row.capabilities)}
                ariaLabel={`${row.name} の合成権限`}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
