'use client';

import {
  Check,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  createEmptyFieldDraft,
  createEmptyTemplateDraft,
  templateToDraft,
  validateMetadataTemplateDraft,
  type MetadataTemplateDraft,
  type MetadataTemplateFieldDraft,
} from '@/lib/admin-metadata-templates';
import {
  createMetadataTemplate,
  deleteMetadataTemplate,
  listMetadataTemplates,
  updateMetadataTemplate,
  type MetadataFieldType,
  type MetadataTemplate,
} from '@/lib/files-api/tags-metadata';
import { formatDateTime } from '@/lib/formatters';

const FIELD_TYPE_LABELS: Record<MetadataFieldType, string> = {
  text: 'テキスト',
  number: '数値',
  date: '日付',
  enum: '選択肢 (enum)',
};

export function AdminMetadataTemplatesSection() {
  const [templates, setTemplates] = useState<MetadataTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [mode, setMode] = useState<'idle' | 'create' | 'edit'>('idle');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MetadataTemplateDraft>(
    createEmptyTemplateDraft
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listMetadataTemplates(signal);
      setTemplates(res.templates);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(
        err instanceof Error
          ? err.message
          : 'メタデータテンプレートの取得に失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function openCreate() {
    setMode('create');
    setEditingId(null);
    setDraft(createEmptyTemplateDraft());
    setConfirmDeleteId(null);
    setError(null);
    setNotice(null);
  }

  function openEdit(template: MetadataTemplate) {
    setMode('edit');
    setEditingId(template.id);
    setDraft(templateToDraft(template));
    setConfirmDeleteId(null);
    setError(null);
    setNotice(null);
  }

  function closeForm() {
    setMode('idle');
    setEditingId(null);
    setError(null);
  }

  function updateField(
    index: number,
    patch: Partial<MetadataTemplateFieldDraft>
  ) {
    setDraft((prev) => ({
      ...prev,
      fields: prev.fields.map((field, idx) =>
        idx === index ? { ...field, ...patch } : field
      ),
    }));
  }

  function addFieldRow() {
    setDraft((prev) => ({
      ...prev,
      fields: [...prev.fields, createEmptyFieldDraft()],
    }));
  }

  function removeFieldRow(index: number) {
    setDraft((prev) => ({
      ...prev,
      fields: prev.fields.filter((_, idx) => idx !== index),
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const validation = validateMetadataTemplateDraft(draft, {
      requireKey: mode === 'create',
    });
    if (!validation.valid) {
      setError(validation.error);
      return;
    }

    setSaving(true);
    try {
      if (mode === 'create') {
        const res = await createMetadataTemplate({
          key: validation.key,
          displayName: validation.displayName,
          description: validation.description,
          fields: validation.fields,
        });
        setTemplates((prev) => [...prev, res.template]);
        setNotice(`テンプレート「${res.template.displayName}」を作成しました。`);
        setMode('idle');
      } else if (mode === 'edit' && editingId) {
        const res = await updateMetadataTemplate(editingId, {
          displayName: validation.displayName,
          description: validation.description,
          fields: validation.fields,
        });
        setTemplates((prev) =>
          prev.map((t) => (t.id === editingId ? res.template : t))
        );
        setNotice(`テンプレート「${res.template.displayName}」を更新しました。`);
        setMode('idle');
        setEditingId(null);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'メタデータテンプレートの保存に失敗しました'
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(template: MetadataTemplate) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await deleteMetadataTemplate(template.id);
      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
      if (editingId === template.id) {
        setMode('idle');
        setEditingId(null);
      }
      setConfirmDeleteId(null);
      setNotice(`テンプレート「${template.displayName}」を削除しました。`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'メタデータテンプレートの削除に失敗しました'
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="admin-metadata-templates-heading"
      className="space-y-4 rounded-xl border border-[#e7e7ea] bg-white p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="admin-metadata-templates-heading"
            className="flex items-center gap-2 text-[0.9375rem] font-semibold text-[#111214]"
          >
            <Tag className="h-4 w-4 text-[#5e6ad2]" />
            カスタムメタデータテンプレート
          </h2>
          <p className="mt-1 text-[0.75rem] text-[#6b6f76]">
            ファイルやフォルダに付与する構造化メタデータ（契約番号・取引先・承認期限など）のテンプレートを管理します。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] font-medium text-[#111214] transition hover:bg-[#f4f4f6] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            更新
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4e59be]"
          >
            <Plus className="h-3.5 w-3.5" />
            テンプレート作成
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[0.75rem] text-rose-800"
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[0.75rem] text-emerald-800"
        >
          {notice}
        </div>
      )}

      {mode !== 'idle' && (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="space-y-4 rounded-xl border border-[#d7d9e4] bg-[#fafafe] p-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-[0.8125rem] font-semibold text-[#111214]">
              {mode === 'create'
                ? '新規メタデータテンプレート'
                : `テンプレート編集: ${draft.key}`}
            </h3>
            <button
              type="button"
              onClick={closeForm}
              aria-label="フォームを閉じる"
              className="rounded-md p-1 text-[#6b6f76] hover:bg-[#ededf0]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="meta-tpl-key"
                className="block text-[0.75rem] font-medium text-[#111214]"
              >
                テンプレートキー (英小文字・数字・_・-)
              </label>
              <input
                id="meta-tpl-key"
                type="text"
                value={draft.key}
                disabled={mode === 'edit'}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, key: e.target.value }))
                }
                placeholder="例: contract_info"
                className="mt-1 h-8 w-full rounded-lg border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] text-[#111214] focus:border-[#5e6ad2] focus:outline-none disabled:bg-[#f4f4f6] disabled:text-[#6b6f76]"
              />
            </div>
            <div>
              <label
                htmlFor="meta-tpl-display-name"
                className="block text-[0.75rem] font-medium text-[#111214]"
              >
                表示名
              </label>
              <input
                id="meta-tpl-display-name"
                type="text"
                value={draft.displayName}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, displayName: e.target.value }))
                }
                placeholder="例: 契約管理情報"
                className="mt-1 h-8 w-full rounded-lg border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] text-[#111214] focus:border-[#5e6ad2] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="meta-tpl-description"
              className="block text-[0.75rem] font-medium text-[#111214]"
            >
              説明（任意）
            </label>
            <input
              id="meta-tpl-description"
              type="text"
              value={draft.description}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder="用途や入力ガイドラインを入力"
              className="mt-1 h-8 w-full rounded-lg border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] text-[#111214] focus:border-[#5e6ad2] focus:outline-none"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[0.75rem] font-medium text-[#111214]">
                フィールド定義 ({draft.fields.length}/30)
              </span>
              <button
                type="button"
                onClick={addFieldRow}
                disabled={draft.fields.length >= 30}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e7e7ea] bg-white px-2.5 text-[0.6875rem] font-medium text-[#5e6ad2] hover:bg-[#f4f4f6] disabled:opacity-50"
              >
                <Plus className="h-3 w-3" />
                フィールドを追加
              </button>
            </div>

            <div className="space-y-2">
              {draft.fields.map((field, index) => (
                <div
                  key={index}
                  className="rounded-lg border border-[#e7e7ea] bg-white p-3"
                >
                  <div className="grid gap-2 sm:grid-cols-12 sm:items-center">
                    <div className="sm:col-span-3">
                      <label className="block text-[0.6875rem] text-[#6b6f76]">
                        キー
                      </label>
                      <input
                        type="text"
                        value={field.key}
                        onChange={(e) =>
                          updateField(index, { key: e.target.value })
                        }
                        placeholder="contract_no"
                        className="mt-0.5 h-7 w-full rounded-md border border-[#e7e7ea] px-2 text-[0.75rem] focus:border-[#5e6ad2] focus:outline-none"
                      />
                    </div>
                    <div className="sm:col-span-4">
                      <label className="block text-[0.6875rem] text-[#6b6f76]">
                        ラベル
                      </label>
                      <input
                        type="text"
                        value={field.label}
                        onChange={(e) =>
                          updateField(index, { label: e.target.value })
                        }
                        placeholder="契約番号"
                        className="mt-0.5 h-7 w-full rounded-md border border-[#e7e7ea] px-2 text-[0.75rem] focus:border-[#5e6ad2] focus:outline-none"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label className="block text-[0.6875rem] text-[#6b6f76]">
                        型
                      </label>
                      <select
                        value={field.type}
                        onChange={(e) =>
                          updateField(index, {
                            type: e.target.value as MetadataFieldType,
                          })
                        }
                        className="mt-0.5 h-7 w-full rounded-md border border-[#e7e7ea] bg-white px-2 text-[0.75rem] focus:border-[#5e6ad2] focus:outline-none"
                      >
                        {(
                          Object.keys(FIELD_TYPE_LABELS) as MetadataFieldType[]
                        ).map((typeKey) => (
                          <option key={typeKey} value={typeKey}>
                            {FIELD_TYPE_LABELS[typeKey]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center justify-between pt-4 sm:col-span-2 sm:justify-end sm:gap-2">
                      <label className="inline-flex items-center gap-1 text-[0.75rem] text-[#111214]">
                        <input
                          type="checkbox"
                          checked={field.required}
                          onChange={(e) =>
                            updateField(index, { required: e.target.checked })
                          }
                          className="rounded border-[#d7d7dc]"
                        />
                        必須
                      </label>
                      {draft.fields.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeFieldRow(index)}
                          aria-label={`フィールド ${index + 1} を削除`}
                          className="rounded-md p-1 text-[#6b6f76] hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {field.type === 'enum' && (
                    <div className="mt-2">
                      <label className="block text-[0.6875rem] text-[#6b6f76]">
                        選択肢（カンマ区切り）
                      </label>
                      <input
                        type="text"
                        value={field.optionsText}
                        onChange={(e) =>
                          updateField(index, { optionsText: e.target.value })
                        }
                        placeholder="例: ドラフト, レビュー中, 締結済"
                        className="mt-0.5 h-7 w-full rounded-md border border-[#e7e7ea] px-2 text-[0.75rem] focus:border-[#5e6ad2] focus:outline-none"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={closeForm}
              className="inline-flex h-8 items-center rounded-lg border border-[#e7e7ea] bg-white px-3 text-[0.75rem] text-[#6b6f76] hover:bg-[#f4f4f6]"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#5e6ad2] px-3.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4e59be] disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {mode === 'create' ? 'テンプレートを作成' : '変更を保存'}
            </button>
          </div>
        </form>
      )}

      {loading && templates.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[0.8125rem] text-[#6b6f76]">
          <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
          <span>テンプレートを読み込み中...</span>
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#d7d7dc] px-6 py-10 text-center">
          <Tag className="mx-auto h-6 w-6 text-[#9ea3ae]" />
          <p className="mt-2 text-[0.8125rem] font-medium text-[#111214]">
            カスタムメタデータテンプレートはまだありません
          </p>
          <p className="mt-1 text-[0.75rem] text-[#6b6f76]">
            「テンプレート作成」から最初のテンプレートを定義してください。
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[#ededf0] rounded-xl border border-[#e7e7ea]">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="flex flex-wrap items-start justify-between gap-3 p-4"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.875rem] font-semibold text-[#111214]">
                    {tpl.displayName}
                  </span>
                  <code className="rounded bg-[#f4f4f6] px-1.5 py-0.5 text-[0.6875rem] text-[#4c5057]">
                    {tpl.key}
                  </code>
                  <span className="text-[0.6875rem] text-[#6b6f76]">
                    更新: {formatDateTime(tpl.updatedAt)}
                  </span>
                </div>
                {tpl.description && (
                  <p className="text-[0.75rem] text-[#6b6f76]">
                    {tpl.description}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {tpl.fields.map((field) => (
                    <span
                      key={field.key}
                      className="inline-flex items-center gap-1 rounded-md border border-[#e7e7ea] bg-[#fafafb] px-2 py-0.5 text-[0.6875rem] text-[#111214]"
                    >
                      <span className="font-medium">{field.label}</span>
                      <span className="text-[#6b6f76]">({field.type})</span>
                      {field.required && (
                        <span className="text-rose-600">*</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => openEdit(tpl)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] text-[#111214] hover:bg-[#f4f4f6]"
                >
                  <Pencil className="h-3 w-3" />
                  編集
                </button>
                {confirmDeleteId === tpl.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleDelete(tpl)}
                      className="inline-flex h-7 items-center rounded-md bg-rose-600 px-2.5 text-[0.75rem] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                    >
                      削除を確定
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="inline-flex h-7 items-center rounded-md border border-[#e7e7ea] px-2 text-[0.75rem] text-[#6b6f76] hover:bg-[#f4f4f6]"
                    >
                      戻る
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(tpl.id)}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-200 bg-white px-2.5 text-[0.75rem] text-rose-600 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3 w-3" />
                    削除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
