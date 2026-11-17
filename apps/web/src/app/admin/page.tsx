import { connection } from 'next/server';
import { HybridGovernanceDashboard } from '@/components/HybridGovernanceDashboard';

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Keep the nonce and the rendered script tags in the same request.
  await connection();
  const { tab } = await searchParams;

  return <HybridGovernanceDashboard section="all" initialTab={tab ?? null} />;
}
