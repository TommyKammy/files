'use client';

import { Check, Loader2, Plus, Tag, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  addItemTag,
  listItemMetadata,
  listItemTags,
  listMetadataTemplates,
  listTenantTags,
  MAX_TAGS_PER_ITEM,
  removeItemTag,
  saveItemMetadata,
  validateTagInput,
  type ItemMetadataEntry,
  type ItemTagEntry,
  type MetadataFieldDefinition,
  type MetadataTemplate,
  type MetadataValueMap,
  type TagItemType,
} from '@/lib/files-api/tags-metadata';

export interface InspectorTagsMetadataSectionProps {
  itemType: TagItemType;
  itemId: string;
  canEdit: boolean;
}

export function InspectorTagsMetadataSection({
  itemType,
  itemId,
  canEdit,
}: InspectorTagsMetadataSectionProps) {
  const datalistId = useId();

  const [tags, setTags] = useState<ItemTagEntry[]>([]);
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [tagSubmitting, setTagSubmitting] = useState(false);
  const [removingTag, setRemovingTag] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);

  const [templates, setTemplates] = useState<MetadataTemplate[]>([]);
  const [itemMetadata, setItemMetadata] = useState<ItemMetadataEntry[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [metaSaving, setMetaSaving] = useState(false);
  const [metaSavedNotice, setMetaSavedNotice] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setTagError(null);
      setMetaError(null);
      try {
        const [tagsRes, tenantTagsRes, templatesRes, metadataRes] =
          await Promise.all([
            listItemTags(itemType, itemId, signal),
            listTenantTags(undefined, signal).catch(() => ({ tags: [] })),
            listMetadataTemplates(signal).catch(() => ({ templates: [] })),
            listItemMetadata(itemType, itemId, signal),
          ]);
        if (signal?.aborted) return;

        setTags(tagsRes.tags);
        setSuggestedTags(tenantTagsRes.tags);
        setTemplates(templatesRes.templates);
        setItemMetadata(metadataRes.metadata);

        const defaultTemplateId =
          metadataRes.metadata[0]?.templateId ??
          templatesRes.templates[0]?.id ??
          '';
        setSelectedTemplateId((prev) =>
          prev && templatesRes.templates.some((t) => t.id === prev)
            ? prev
            : defaultTemplateId
        );
      } catch (err) {
        if (signal?.aborted) return;
        const message =
          err instanceof Error
            ? err.message
            : 'タグ・メタデータの読み込みに失敗しました。';
        setTagError(message);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [itemType, itemId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadAll(controller.signal);
    return () => controller.abort();
  }, [loadAll]);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId]
  );

  useEffect(() => {
    if (!selectedTemplate) {
      setDraftValues({});
      return;
    }
    const existing = itemMetadata.find(
      (m) => m.templateId === selectedTemplate.id
    );
    const nextDraft: Record<string, string> = {};
    for (const field of selectedTemplate.fields) {
      const val = existing?.values[field.key];
      nextDraft[field.key] =
        val === undefined || val === null ? '' : String(val);
    }
    setDraftValues(nextDraft);
    setMetaSavedNotice(false);
    setMetaError(null);
  }, [selectedTemplate, itemMetadata]);

  const handleAddTag = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canEdit || tagSubmitting) return;

    const check = validateTagInput(tagInput);
    if (!check.valid) {
      setTagError(check.error);
      return;
    }
    if (tags.length >= MAX_TAGS_PER_ITEM) {
      setTagError(`タグは1アイテムあたり最大${MAX_TAGS_PER_ITEM}個までです。`);
      return;
    }

    setTagSubmitting(true);
    setTagError(null);
    try {
      const res = await addItemTag(itemType, itemId, check.tag);
      setTags((prev) =>
        prev.some((t) => t.tag === res.tag.tag) ? prev : [...prev, res.tag]
      );
      setSuggestedTags((prev) =>
        prev.includes(res.tag.tag) ? prev : [...prev, res.tag.tag].sort()
      );
      setTagInput('');
    } catch (err) {
      setTagError(
        err instanceof Error ? err.message : 'タグの追加に失敗しました。'
      );
    } finally {
      setTagSubmitting(false);
    }
  };

  const handleRemoveTag = async (tag: string) => {
    if (!canEdit || removingTag) return;
    setRemovingTag(tag);
    setTagError(null);
    try {
      await removeItemTag(itemType, itemId, tag);
      setTags((prev) => prev.filter((t) => t.tag !== tag));
    } catch (err) {
      setTagError(
        err instanceof Error ? err.message : 'タグの削除に失敗しました。'
      );
    } finally {
      setRemovingTag(null);
    }
  };

  const handleSaveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !selectedTemplate || metaSaving) return;

    const payload: MetadataValueMap = {};
    for (const field of selectedTemplate.fields) {
      const raw = (draftValues[field.key] ?? '').trim();
      if (!raw) {
        if (field.required) {
          setMetaError(`「${field.label}」は必須項目です。`);
          return;
        }
        payload[field.key] = null;
        continue;
      }

      if (field.type === 'number') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          setMetaError(`「${field.label}」は数値で入力してください。`);
          return;
        }
        payload[field.key] = parsed;
      } else {
        payload[field.key] = raw;
      }
    }

    setMetaSaving(true);
    setMetaError(null);
    setMetaSavedNotice(false);
    try {
      const res = await saveItemMetadata(
        itemType,
        itemId,
        selectedTemplate.id,
        payload
      );
      setItemMetadata((prev) => {
        const filtered = prev.filter(
          (m) => m.templateId !== selectedTemplate.id
        );
        return [...filtered, res.metadata];
      });
      setMetaSavedNotice(true);
    } catch (err) {
      setMetaError(
        err instanceof Error
          ? err.message
          : 'メタデータの保存に失敗しました。'
      );
    } finally {
      setMetaSaving(false);
    }
  };

  const renderFieldInput = (field: MetadataFieldDefinition) => {
    const value = draftValues[field.key] ?? '';
    const onChange = (nextVal: string) => {
      setMetaSavedNotice(false);
      setDraftValues((prev) => ({ ...prev, [field.key]: nextVal }));
    };

    if (field.type === 'enum') {
      return (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={!canEdit}
          className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-900 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
        >
          <option value="">選択してください</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }

    const inputType =
      field.type === 'number'
        ? 'number'
        : field.type === 'date'
          ? 'date'
          : 'text';

    return (
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!canEdit}
        className="h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
      />
    );
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>タグ・メタデータを読み込み中...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Tags Section */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <Tag className="h-3.5 w-3.5 text-slate-500" />
            <span>タグ</span>
          </h4>
          <span className="text-[11px] text-slate-400">
            {tags.length}/{MAX_TAGS_PER_ITEM}
          </span>
        </div>

        {tags.length === 0 ? (
          <p className="text-xs text-slate-400">タグはまだ設定されていません</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((entry) => (
              <span
                key={entry.tag}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-700"
              >
                <span>#{entry.tag}</span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => void handleRemoveTag(entry.tag)}
                    disabled={removingTag === entry.tag}
                    aria-label={`タグ ${entry.tag} を削除`}
                    className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {canEdit && (
          <form onSubmit={(e) => void handleAddTag(e)} className="flex gap-1.5">
            <input
              type="text"
              list={datalistId}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="タグを追加 (例: urgent)"
              aria-label="新しいタグ"
              className="h-8 flex-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
            />
            <datalist id={datalistId}>
              {suggestedTags
                .filter((s) => !tags.some((t) => t.tag === s))
                .map((s) => (
                  <option key={s} value={s} />
                ))}
            </datalist>
            <button
              type="submit"
              disabled={tagSubmitting || !tagInput.trim()}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-slate-900 px-2.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {tagSubmitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              <span>追加</span>
            </button>
          </form>
        )}

        {tagError && (
          <p role="alert" className="text-xs text-red-600">
            {tagError}
          </p>
        )}
      </section>

      {/* Custom Metadata Section */}
      <section className="space-y-2 border-t border-slate-200 pt-3">
        <h4 className="text-xs font-semibold text-slate-700">
          カスタムメタデータ
        </h4>

        {templates.length === 0 ? (
          <p className="text-xs text-slate-400">
            利用可能なメタデータテンプレートはありません
          </p>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1 text-xs">
              <span className="text-slate-500">テンプレート</span>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                aria-label="メタデータテンプレート"
                className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-900 focus:border-blue-500 focus:outline-none"
              >
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.displayName} ({tpl.key})
                  </option>
                ))}
              </select>
            </label>

            {selectedTemplate && (
              <form
                onSubmit={(e) => void handleSaveMetadata(e)}
                className="space-y-2.5"
              >
                {selectedTemplate.description && (
                  <p className="text-[11px] text-slate-500">
                    {selectedTemplate.description}
                  </p>
                )}

                {selectedTemplate.fields.map((field) => (
                  <label key={field.key} className="block space-y-1 text-xs">
                    <span className="font-medium text-slate-700">
                      {field.label}
                      {field.required && (
                        <span className="ml-0.5 text-red-500">*</span>
                      )}
                    </span>
                    {renderFieldInput(field)}
                  </label>
                ))}

                {metaError && (
                  <p role="alert" className="text-xs text-red-600">
                    {metaError}
                  </p>
                )}

                {metaSavedNotice && (
                  <p className="flex items-center gap-1 text-xs text-emerald-700">
                    <Check className="h-3.5 w-3.5" />
                    <span>メタデータを保存しました</span>
                  </p>
                )}

                {canEdit && (
                  <button
                    type="submit"
                    disabled={metaSaving}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {metaSaving && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    <span>保存</span>
                  </button>
                )}
              </form>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
