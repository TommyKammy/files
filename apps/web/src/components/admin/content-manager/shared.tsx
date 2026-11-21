'use client';

import { FileText, Folder } from 'lucide-react';

export const DATE_TIME_OPTIONS = {
  timeZone: 'Asia/Tokyo',
  timeZoneName: 'short' as const,
};

/** Renders a file or folder icon matching an admin content target type. */
export function TargetIcon({ targetType }: { targetType: 'file' | 'folder' }) {
  const Icon = targetType === 'file' ? FileText : Folder;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-slate-500" />;
}
