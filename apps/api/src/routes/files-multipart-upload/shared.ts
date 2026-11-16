import { FileUploadError } from '../../services/file-upload-common';

export const MIN_MULTIPART_INIT_BYTES = 5 * 1024 * 1024; // R2/S3 5 MiB minimum non-final part size

export function handleMultipartError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 413) => Response },
  err: unknown
): Response {
  if (err instanceof FileUploadError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}
