import { processCopySubtreeJobChunk } from '../services/workspace-operations';
import type { JobsQueueMessage } from '../types/classification';
import type { OidcEnv } from '../types/oidc';
import { handleClassifyFile } from './classification/file-classify';
import { handlePropagateFolderClassification } from './classification/folder-propagate';

export async function handleJobsQueueBatch(
  batch: MessageBatch<JobsQueueMessage>,
  env: OidcEnv
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    try {
      if (body?.type === 'propagate_folder_classification') {
        await handlePropagateFolderClassification(body, env);
        message.ack();
      } else if (body?.type === 'classify_file') {
        const outcome = await handleClassifyFile(body, env);
        if (outcome === 'ack') {
          message.ack();
        } else {
          message.retry();
        }
      } else if (body?.type === 'copy_subtree') {
        await processCopySubtreeJobChunk(body, env);
        message.ack();
      } else {
        message.ack();
      }
    } catch (err) {
      console.error('[queue] job processing error:', err);
      message.retry();
    }
  }
}
