export interface WorkspacePaletteActions {
  hasTargetItem: boolean;
  canClassifyTarget: boolean;
  canShareTarget: boolean;
  canTrashTarget: boolean;
  canCopyTarget?: boolean;
  canCutTarget?: boolean;
  canPasteClipboard?: boolean;
  canDuplicateTarget?: boolean;
  onCommand: (
    commandId:
      | 'cmd:new-folder'
      | 'cmd:move-copy'
      | 'cmd:copy'
      | 'cmd:cut'
      | 'cmd:paste'
      | 'cmd:duplicate'
      | 'cmd:toggle-inspector'
      | 'cmd:toggle-view'
      | 'cmd:change-classification'
      | 'cmd:share'
      | 'cmd:trash'
      | 'cmd:shortcuts'
  ) => void;
}
