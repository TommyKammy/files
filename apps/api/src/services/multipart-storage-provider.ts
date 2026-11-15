import { AwsClient } from 'aws4fetch';
import type { Env } from '../types/api';

const MIB = 1024 * 1024;
export const MAX_MULTIPART_PARTS = 9500;
export const INITIAL_SIGNED_PARTS_LIMIT = 50;
export const PART_URLS_BATCH_MAX = 100;

export interface MultipartPlan {
  partSizeBytes: number;
  totalParts: number;
}

export interface CompletedPartInput {
  partNumber: number;
  etag: string;
}

/**
 * Automatically compute part size (16..64 MiB default; scaled up above ~593 GiB)
 * so total part count never exceeds 9,500 up to 4.995 TiB.
 */
export function computeMultipartPlan(sizeBytes: number): MultipartPlan {
  let partSizeBytes = 16 * MIB;
  if (Math.ceil(sizeBytes / partSizeBytes) > MAX_MULTIPART_PARTS) {
    partSizeBytes = 32 * MIB;
  }
  if (Math.ceil(sizeBytes / partSizeBytes) > MAX_MULTIPART_PARTS) {
    partSizeBytes = 64 * MIB;
  }
  if (Math.ceil(sizeBytes / partSizeBytes) > MAX_MULTIPART_PARTS) {
    const rawMinPart = Math.ceil(sizeBytes / MAX_MULTIPART_PARTS);
    partSizeBytes = Math.ceil(rawMinPart / MIB) * MIB;
  }

  return {
    partSizeBytes,
    totalParts: Math.max(1, Math.ceil(sizeBytes / partSizeBytes)),
  };
}

function createR2AwsClient(env: Env): {
  aws: AwsClient;
  endpointPrefix: string;
} {
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_BUCKET_NAME ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error('Missing R2 S3 credentials for multipart operation');
  }
  return {
    aws: new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
    }),
    endpointPrefix: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}`,
  };
}

function encodeR2Key(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function escapeXml(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function initiateMultipartUpload(
  env: Env,
  objectKey: string,
  contentType: string
): Promise<string> {
  if (env.STORAGE_MODE === 'local_proxy') {
    const mpu = await env.BUCKET.createMultipartUpload(objectKey, {
      httpMetadata: { contentType },
    });
    return mpu.uploadId;
  }

  const { aws, endpointPrefix } = createR2AwsClient(env);
  const res = await aws.fetch(`${endpointPrefix}/${encodeR2Key(objectKey)}?uploads`, {
    method: 'POST',
    headers: contentType ? { 'Content-Type': contentType } : undefined,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`S3 CreateMultipartUpload failed (${res.status}): ${errText}`);
  }
  const xml = await res.text();
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match?.[1]) {
    throw new Error('S3 CreateMultipartUpload response missing UploadId');
  }
  return match[1];
}

export async function completeMultipartUpload(
  env: Env,
  objectKey: string,
  uploadId: string,
  parts: CompletedPartInput[]
): Promise<void> {
  const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);

  if (env.STORAGE_MODE === 'local_proxy') {
    const mpu = env.BUCKET.resumeMultipartUpload(objectKey, uploadId);
    await mpu.complete(
      sortedParts.map((p) => ({
        partNumber: p.partNumber,
        etag: p.etag,
      }))
    );
    return;
  }

  const partsXml = sortedParts
    .map((p) => {
      const stripped = p.etag.replace(/^"+|"+$/g, '');
      return `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>&quot;${escapeXml(stripped)}&quot;</ETag></Part>`;
    })
    .join('');
  const bodyXml = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

  const { aws, endpointPrefix } = createR2AwsClient(env);
  const res = await aws.fetch(
    `${endpointPrefix}/${encodeR2Key(objectKey)}?uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: bodyXml,
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`S3 CompleteMultipartUpload failed (${res.status}): ${errText}`);
  }
  const resText = await res.text();
  if (resText.includes('<Error>')) {
    throw new Error(`S3 CompleteMultipartUpload returned XML error: ${resText}`);
  }
}

export async function abortMultipartUpload(
  env: Env,
  objectKey: string,
  uploadId: string
): Promise<void> {
  if (env.STORAGE_MODE === 'local_proxy') {
    const mpu = env.BUCKET.resumeMultipartUpload(objectKey, uploadId);
    await mpu.abort().catch(() => {
      // Idempotent abort
    });
    return;
  }

  const { aws, endpointPrefix } = createR2AwsClient(env);
  const res = await aws.fetch(
    `${endpointPrefix}/${encodeR2Key(objectKey)}?uploadId=${encodeURIComponent(uploadId)}`,
    { method: 'DELETE' }
  );
  if (!res.ok && res.status !== 404) {
    const errText = await res.text().catch(() => '');
    throw new Error(`S3 AbortMultipartUpload failed (${res.status}): ${errText}`);
  }
}
