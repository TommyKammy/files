'use client';

import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Home,
  Lock,
} from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import type { ClassificationLabel, ResourceRole } from '@/types/files';

export interface DestinationRow {
  rowKey: string;
  section: 'recent' | 'tree';
  folderId: string | null;
  name: string;
  depth: number;
  classification: ClassificationLabel;
  effectiveRole: ResourceRole;
  isExpanded: boolean;
  canExpand: boolean;
}

interface DestinationEvaluation {
  moveEval: { allowed: boolean; reason?: string };
  copyEval: { allowed: boolean; reason?: string };
}

export function DestinationRowButton({
  row,
  modeHint,
  evaluate,
  highlighted,
  onSelect,
  onToggleExpand,
}: {
  row: DestinationRow;
  modeHint: 'move' | 'copy';
  evaluate: (row: DestinationRow) => DestinationEvaluation;
  highlighted: boolean;
  onSelect: () => void;
  onToggleExpand: (folderId: string) => void;
}) {
  const { moveEval, copyEval } = evaluate(row);
  const locked =
    modeHint === 'copy'
      ? !copyEval.allowed
      : !moveEval.allowed && !copyEval.allowed;
  const lockReason =
    modeHint === 'copy' ? copyEval.reason : moveEval.reason ?? copyEval.reason;

  return (
    <div
      style={{ paddingLeft: `${10 + row.depth * 16}px` }}
      onClick={onSelect}
      onDoubleClick={() => {
        if (row.folderId && row.canExpand) {
          onToggleExpand(row.folderId);
        }
      }}
      className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg pr-3 py-2 text-xs transition ${
        highlighted
          ? 'bg-blue-50 text-blue-900 ring-1 ring-inset ring-blue-300'
          : locked
            ? 'text-slate-400 hover:bg-slate-50'
            : 'text-slate-700 hover:bg-slate-50'
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {row.canExpand && row.folderId ? (
          <button
            type="button"
            aria-label={row.isExpanded ? '折りたたむ' : '展開する'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(row.folderId!);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200/70 hover:text-slate-700"
          >
            {row.isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {row.folderId === null ? (
          <Home className="h-4 w-4 shrink-0 text-blue-500" />
        ) : row.isExpanded ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
        )}

        <span className="truncate font-medium">{row.name}</span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {row.classification !== 'unset' && (
          <ClassificationBadge classification={row.classification} compact />
        )}
        {locked && lockReason && (
          <span title={lockReason} className="text-slate-500">
            <Lock className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}
