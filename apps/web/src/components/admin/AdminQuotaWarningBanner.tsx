'use client';

import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { evaluateQuotaBanner, type QuotaThresholds } from '@/lib/admin-compliance';

/**
 * Storage quota warning banner shared by the integrated dashboard and the
 * insights route. Thresholds come from the tenant policy (projected into
 * `/api/admin/storage-stats`) so both routes can render without fetching the
 * policy endpoint owned by `/admin/settings`.
 */
export function AdminQuotaWarningBanner({
  usedPct,
  thresholds,
}: {
  usedPct: number;
  thresholds: QuotaThresholds;
}) {
  const state = evaluateQuotaBanner(usedPct, thresholds);
  if (state.level === 'normal') return null;

  const critical = state.level === 'critical';
  const Icon = critical ? ShieldAlert : AlertTriangle;
  return (
    <div
      role="alert"
      data-testid="admin-quota-warning-banner"
      data-level={state.level}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-[0.75rem] ${
        critical
          ? 'border-red-300 bg-red-50 text-red-800'
          : 'border-amber-300 bg-amber-50 text-amber-900'
      }`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-semibold">{state.title}</p>
        <p className="break-words leading-relaxed">{state.message}</p>
      </div>
      <span
        className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums ${
          critical ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'
        }`}
      >
        {state.usedPct}%
      </span>
    </div>
  );
}
