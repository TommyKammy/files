import type { ClassificationLabel } from './api';

export type AiClassificationMode = 'disabled' | 'metadata_only' | 'content_excerpt';
export type AiSuggestibleLabel = Exclude<ClassificationLabel, 'unset'>;

export interface ClassifyFileQueueMessage {
  type: 'classify_file';
  tenantId: string;
  fileId: string;
  versionId: string;
  r2ObjectKey: string;
  mimeType: string;
  fileName: string;
  extension: string | null;
}

export interface PropagateFolderClassificationQueueMessage {
  type: 'propagate_folder_classification';
  tenantId: string;
  folderId: string;
  targetClassification: ClassificationLabel;
  actorId: string;
  actorEmail: string;
  actorIp: string;
}

export interface CopySubtreeQueueMessage {
  type: 'copy_subtree';
  jobId: string;
  tenantId: string;
  actorId: string;
  actorEmail: string;
  actorIp: string;
}

export type JobsQueueMessage =
  | ClassifyFileQueueMessage
  | PropagateFolderClassificationQueueMessage
  | CopySubtreeQueueMessage;

export interface ExtractedClassificationContext {
  tenantId: string;
  fileId: string;
  fileName: string;
  extension: string | null;
  mimeType: string;
  sizeBytes: number;
  folderPath: string;
  uploaderEmail: string;
  uploaderGroups: string[];
  mode: AiClassificationMode;
  autoApplyThreshold: number | null;
  ancestorFloorClassification: ClassificationLabel;
  excerpt: string | null;
  excerptIncluded: boolean;
}

export interface LlmClassificationResult {
  suggestedLabel: AiSuggestibleLabel;
  confidence: number;
  reason: string;
}
