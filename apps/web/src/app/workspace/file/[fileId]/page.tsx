import { connection } from 'next/server';
import { Suspense } from 'react';
import { FileViewerPage } from '@/components/FileViewerPage';

export default async function WorkspaceFilePage({
  params,
}: {
  params: Promise<{ fileId: string }>;
}) {
  await connection();
  const { fileId } = await params;

  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
          ファイルを読み込み中...
        </div>
      }
    >
      <FileViewerPage fileId={fileId} />
    </Suspense>
  );
}
