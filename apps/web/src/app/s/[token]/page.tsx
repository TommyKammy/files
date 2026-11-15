import { SharedLinkLanding } from '@/components/SharedLinkLanding';

export default async function SharedLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SharedLinkLanding token={token} />;
}
