import { connection } from 'next/server';
import { HybridGovernanceDashboard } from '@/components/HybridGovernanceDashboard';

export default async function AdminInsightsPage() {
  // Keep the CSP nonce and the rendered script tags in the same request.
  await connection();

  return <HybridGovernanceDashboard section="insights" />;
}
