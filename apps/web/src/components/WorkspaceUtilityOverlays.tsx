'use client';

import {
  ClassificationPickerModal,
  ShortcutsHelpModal,
} from '@/components/WorkspaceKeyboardOverlays';
import {
  SecurePreviewModal,
  type PreviewTargetFile,
} from '@/components/SecurePreviewModal';
import type { FileItem } from '@/types/files';

export type ClassificationPickerState =
  | { mode: 'single'; file: FileItem }
  | { mode: 'bulk'; files: FileItem[] };

export function WorkspaceUtilityOverlays({
  previewTarget,
  previewCanNavigatePrev,
  previewCanNavigateNext,
  classificationPicker,
  shortcutsHelpOpen,
  onNavigatePreview,
  onClosePreview,
  onSelectClassification,
  onCloseClassification,
  onCloseShortcuts,
}: {
  previewTarget: {
    file: PreviewTargetFile;
    canDownload: boolean;
  } | null;
  previewCanNavigatePrev: boolean;
  previewCanNavigateNext: boolean;
  classificationPicker: ClassificationPickerState | null;
  shortcutsHelpOpen: boolean;
  onNavigatePreview: (direction: 1 | -1) => void;
  onClosePreview: () => void;
  onSelectClassification: (label: 'confidential' | 'internal' | 'public') => void;
  onCloseClassification: () => void;
  onCloseShortcuts: () => void;
}) {
  return (
    <>
      {previewTarget && (
        <SecurePreviewModal
          file={previewTarget.file}
          canDownload={previewTarget.canDownload}
          canNavigatePrev={previewCanNavigatePrev}
          canNavigateNext={previewCanNavigateNext}
          onNavigateFile={onNavigatePreview}
          onClose={onClosePreview}
        />
      )}

      {classificationPicker && (
        <ClassificationPickerModal
          targetLabel={
            classificationPicker.mode === 'single'
              ? classificationPicker.file.name
              : `${classificationPicker.files.length} 件のファイルを一括変更`
          }
          currentClassification={
            classificationPicker.mode === 'single'
              ? classificationPicker.file.classification
              : null
          }
          aiSuggestedLabel={
            classificationPicker.mode === 'single'
              ? classificationPicker.file.ai_suggested_label
              : null
          }
          onSelect={onSelectClassification}
          onClose={onCloseClassification}
        />
      )}

      {shortcutsHelpOpen && (
        <ShortcutsHelpModal onClose={onCloseShortcuts} />
      )}
    </>
  );
}
