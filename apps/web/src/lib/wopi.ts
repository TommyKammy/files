import type { FileItem } from '@/types/files';

export type WopiEditorFile = Pick<FileItem, 'id' | 'name' | 'extension'>;

const WOPI_EDITABLE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'dot',
  'dotx',
  'odt',
  'fodt',
  'rtf',
  'txt',
  'xls',
  'xlsx',
  'xlt',
  'xltx',
  'ods',
  'fods',
  'csv',
  'ppt',
  'pptx',
  'pot',
  'potx',
  'odp',
  'fodp',
]);

export function getFileExtension(file: Pick<FileItem, 'name' | 'extension'>): string {
  if (file.extension) return file.extension.toLowerCase();
  const lastDot = file.name.lastIndexOf('.');
  return lastDot > 0 ? file.name.slice(lastDot + 1).toLowerCase() : '';
}

export function isWopiEditableFile(
  file: Pick<FileItem, 'name' | 'extension'>
): boolean {
  return WOPI_EDITABLE_EXTENSIONS.has(getFileExtension(file));
}
