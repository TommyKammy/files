import { connection } from 'next/server';
import { Suspense } from 'react';
import { WorkspaceFileBrowser } from '@/components/WorkspaceFileBrowser';

export default async function WorkspacePage() {
  // Nonce-based CSP requires request-time rendering so a fresh nonce can be
  // applied to framework and page scripts.
  await connection();

  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
          ワークスペースを読み込み中...
        </div>
      }
    >
      <WorkspaceFileBrowser />
    </Suspense>
  );
}
