import type {
  MetadataFieldDefinition,
  MetadataFieldType,
  MetadataTemplate,
} from '@/lib/files-api/tags-metadata';

export interface MetadataTemplateFieldDraft {
  key: string;
  label: string;
  type: MetadataFieldType;
  required: boolean;
  optionsText: string;
}

export interface MetadataTemplateDraft {
  key: string;
  displayName: string;
  description: string;
  fields: MetadataTemplateFieldDraft[];
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function createEmptyFieldDraft(): MetadataTemplateFieldDraft {
  return {
    key: '',
    label: '',
    type: 'text',
    required: false,
    optionsText: '',
  };
}

export function createEmptyTemplateDraft(): MetadataTemplateDraft {
  return {
    key: '',
    displayName: '',
    description: '',
    fields: [createEmptyFieldDraft()],
  };
}

export function templateToDraft(
  template: MetadataTemplate
): MetadataTemplateDraft {
  return {
    key: template.key,
    displayName: template.displayName,
    description: template.description ?? '',
    fields:
      template.fields.length > 0
        ? template.fields.map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            required: Boolean(field.required),
            optionsText: (field.options ?? []).join(', '),
          }))
        : [createEmptyFieldDraft()],
  };
}

export function parseEnumOptionsText(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function validateMetadataTemplateDraft(
  draft: MetadataTemplateDraft,
  options: { requireKey: boolean }
):
  | {
      valid: true;
      key: string;
      displayName: string;
      description: string | null;
      fields: MetadataFieldDefinition[];
    }
  | { valid: false; error: string } {
  const key = draft.key.trim().toLowerCase();
  if (options.requireKey && !KEY_PATTERN.test(key)) {
    return {
      valid: false,
      error:
        'テンプレートキーは1〜64文字の半角英小文字・数字・アンダースコア・ハイフンで入力してください（先頭は英数字）。',
    };
  }

  const displayName = draft.displayName.trim();
  if (!displayName || displayName.length > 100) {
    return {
      valid: false,
      error: '表示名は1〜100文字で入力してください。',
    };
  }

  const trimmedDesc = draft.description.trim();
  if (trimmedDesc.length > 500) {
    return {
      valid: false,
      error: '説明は500文字以内で入力してください。',
    };
  }

  if (draft.fields.length === 0 || draft.fields.length > 30) {
    return {
      valid: false,
      error: 'フィールドは1〜30件の範囲で定義してください。',
    };
  }

  const seenKeys = new Set<string>();
  const parsedFields: MetadataFieldDefinition[] = [];

  for (let i = 0; i < draft.fields.length; i++) {
    const field = draft.fields[i];
    const fieldKey = field.key.trim().toLowerCase();
    if (!KEY_PATTERN.test(fieldKey)) {
      return {
        valid: false,
        error: `フィールド #${i + 1} のキーは1〜64文字の半角英小文字・数字・_・- で入力してください。`,
      };
    }
    if (seenKeys.has(fieldKey)) {
      return {
        valid: false,
        error: `フィールドキー "${fieldKey}" が重複しています。`,
      };
    }
    seenKeys.add(fieldKey);

    const label = field.label.trim();
    if (!label || label.length > 100) {
      return {
        valid: false,
        error: `フィールド "${fieldKey}" のラベルは1〜100文字で入力してください。`,
      };
    }

    if (field.type === 'enum') {
      const enumOptions = parseEnumOptionsText(field.optionsText);
      if (enumOptions.length === 0 || enumOptions.length > 50) {
        return {
          valid: false,
          error: `選択肢フィールド "${fieldKey}" にはカンマ区切りで1〜50個の選択肢を入力してください。`,
        };
      }
      parsedFields.push({
        key: fieldKey,
        label,
        type: 'enum',
        required: field.required,
        options: enumOptions,
      });
    } else {
      parsedFields.push({
        key: fieldKey,
        label,
        type: field.type,
        required: field.required,
      });
    }
  }

  return {
    valid: true,
    key,
    displayName,
    description: trimmedDesc || null,
    fields: parsedFields,
  };
}
