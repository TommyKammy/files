import { PublicFileRequestUploader } from '@/components/PublicFileRequestUploader';

export default async function FileRequestPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PublicFileRequestUploader token={token} />;
}
