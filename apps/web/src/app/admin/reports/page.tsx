import { connection } from 'next/server';
import { HybridGovernanceDashboard } from '@/components/HybridGovernanceDashboard';

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Keep the CSP nonce and the rendered script tags in the same request.
  await connection();
  const { auditPreset } = await searchParams;

  return (
    <HybridGovernanceDashboard
      section="reports"
      auditPreset={auditPreset ?? null}
    />
  );
}
