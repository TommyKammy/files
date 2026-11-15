import { Suspense } from 'react';
import { WorkspaceFileBrowser } from '@/components/WorkspaceFileBrowser';

export default function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] text-sm text-slate-500">
          ワークスペースを読み込み中...
        </div>
      }
    >
      <WorkspaceFileBrowser />
    </Suspense>
  );
}
