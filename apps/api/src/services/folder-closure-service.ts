export {
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  fetchFolderBreadcrumbsRows,
  getFolderBreadcrumbs,
  validateFolderName,
} from './folder-closure/shared';
export type { BreadcrumbItem, FolderRow } from './folder-closure/shared';
export { createFolderWithClosures } from './folder-closure/create';
export { moveFolderSubtree } from './folder-closure/move';
export {
  restoreFolderSubtree,
  softDeleteFolderSubtree,
} from './folder-closure/delete-restore';
