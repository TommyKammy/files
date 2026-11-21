import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import {
  getAuthenticatedUser,
  requireSecOrSysAdmin,
} from '../services/authorization';
import {
  normalizeTargetId,
  parseItemTargetType,
  verifyItemTargetAccess,
} from '../services/item-target-access';
import type { OidcHonoEnv } from '../types/oidc';

export type MetadataFieldType = 'text' | 'number' | 'date' | 'enum';

export interface MetadataFieldDefinition {
  key: string;
  label: string;
  type: MetadataFieldType;
  required?: boolean;
  options?: string[];
}

interface MetadataTemplateRow {
  id: string;
  tenant_id: string;
  key: string;
  display_name: string;
  description: string | null;
  fields_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ItemMetadataRow {
  template_id: string;
  template_key: string;
  display_name: string;
  values_json: string;
  updated_by: string;
  updated_at: string;
}

const MAX_TEMPLATE_FIELDS = 50;

const VALID_FIELD_TYPES = new Set<MetadataFieldType>([
  'text',
  'number',
  'date',
  'enum',
]);

function parseTemplateFieldsJson(raw: string): MetadataFieldDefinition[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as MetadataFieldDefinition[]) : [];
  } catch {
    return [];
  }
}

function parseValuesJson(
  raw: string
): Record<string, string | number | null> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, string | number | null>;
  } catch {
    return {};
  }
}

function formatTemplate(row: MetadataTemplateRow) {
  return {
    id: row.id,
    key: row.key,
    displayName: row.display_name,
    description: row.description,
    fields: parseTemplateFieldsJson(row.fields_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateFieldsSchema(
  rawFields: unknown
):
  | { ok: true; fields: MetadataFieldDefinition[] }
  | { ok: false; error: string } {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return { ok: false, error: 'fields must be a non-empty array' };
  }
  if (rawFields.length > MAX_TEMPLATE_FIELDS) {
    return {
      ok: false,
      error: `fields cannot exceed ${MAX_TEMPLATE_FIELDS} items`,
    };
  }

  const seenKeys = new Set<string>();
  const normalized: MetadataFieldDefinition[] = [];

  for (let i = 0; i < rawFields.length; i++) {
    const item = rawFields[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `fields[${i}] must be an object` };
    }

    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!key || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(key)) {
      return {
        ok: false,
        error: `fields[${i}].key must be 1..64 alphanumeric/underscore/hyphen characters`,
      };
    }
    if (seenKeys.has(key)) {
      return { ok: false, error: `Duplicate field key: ${key}` };
    }
    seenKeys.add(key);

    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!label || label.length > 80) {
      return {
        ok: false,
        error: `fields[${i}].label must be 1..80 characters`,
      };
    }

    const type = item.type as MetadataFieldType;
    if (!VALID_FIELD_TYPES.has(type)) {
      return {
        ok: false,
        error: `fields[${i}].type must be one of text, number, date, enum`,
      };
    }

    const required = Boolean(item.required);
    const fieldDef: MetadataFieldDefinition = {
      key,
      label,
      type,
      ...(required ? { required: true } : {}),
    };

    if (type === 'enum') {
      if (!Array.isArray(item.options) || item.options.length === 0) {
        return {
          ok: false,
          error: `fields[${i}].options must be a non-empty array for enum fields`,
        };
      }
      const cleanOptions: string[] = [];
      const seenOptions = new Set<string>();
      for (const opt of item.options) {
        if (typeof opt !== 'string') {
          return {
            ok: false,
            error: `fields[${i}].options entries must be strings`,
          };
        }
        const trimmedOpt = opt.trim();
        if (!trimmedOpt || trimmedOpt.length > 100) {
          return {
            ok: false,
            error: `fields[${i}].options entries must be 1..100 characters`,
          };
        }
        if (!seenOptions.has(trimmedOpt)) {
          seenOptions.add(trimmedOpt);
          cleanOptions.push(trimmedOpt);
        }
      }
      fieldDef.options = cleanOptions;
    }

    normalized.push(fieldDef);
  }

  return { ok: true, fields: normalized };
}

function validateMetadataValues(
  fields: MetadataFieldDefinition[],
  rawValues: unknown
):
  | { ok: true; values: Record<string, string | number | null> }
  | { ok: false; error: string } {
  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    return { ok: false, error: 'values must be an object' };
  }

  const input = rawValues as Record<string, unknown>;
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));

  for (const key of Object.keys(input)) {
    if (!fieldByKey.has(key)) {
      return { ok: false, error: `Unknown metadata field: ${key}` };
    }
  }

  const normalized: Record<string, string | number | null> = {};

  for (const field of fields) {
    const rawVal = input[field.key];
    if (rawVal === undefined || rawVal === null || rawVal === '') {
      if (field.required) {
        return { ok: false, error: `Field "${field.label}" is required` };
      }
      continue;
    }

    if (field.type === 'text') {
      if (typeof rawVal !== 'string') {
        return {
          ok: false,
          error: `Field "${field.label}" must be a string`,
        };
      }
      const trimmed = rawVal.trim();
      if (trimmed.length > 1000) {
        return {
          ok: false,
          error: `Field "${field.label}" exceeds 1000 characters`,
        };
      }
      normalized[field.key] = trimmed;
    } else if (field.type === 'number') {
      if (typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
        return {
          ok: false,
          error: `Field "${field.label}" must be a finite number`,
        };
      }
      normalized[field.key] = rawVal;
    } else if (field.type === 'date') {
      if (typeof rawVal !== 'string') {
        return {
          ok: false,
          error: `Field "${field.label}" must be a date string`,
        };
      }
      const trimmed = rawVal.trim();
      if (Number.isNaN(Date.parse(trimmed))) {
        return {
          ok: false,
          error: `Field "${field.label}" must be a valid date`,
        };
      }
      normalized[field.key] = trimmed;
    } else if (field.type === 'enum') {
      if (typeof rawVal !== 'string') {
        return {
          ok: false,
          error: `Field "${field.label}" must be a string option`,
        };
      }
      const options = field.options ?? [];
      if (!options.includes(rawVal)) {
        return {
          ok: false,
          error: `Field "${field.label}" must be one of: ${options.join(', ')}`,
        };
      }
      normalized[field.key] = rawVal;
    }
  }

  return { ok: true, values: normalized };
}

export const metadataTemplatesRoutes = new Hono<OidcHonoEnv>();

metadataTemplatesRoutes.use(
  '/metadata-templates',
  sessionAuthMiddleware({ required: true })
);
metadataTemplatesRoutes.use(
  '/admin/metadata-templates',
  sessionAuthMiddleware({ required: true }),
  requireSecOrSysAdmin
);
metadataTemplatesRoutes.use(
  '/admin/metadata-templates/*',
  sessionAuthMiddleware({ required: true }),
  requireSecOrSysAdmin
);
metadataTemplatesRoutes.use(
  '/items/:itemType/:itemId/metadata',
  sessionAuthMiddleware({ required: true })
);
metadataTemplatesRoutes.use(
  '/items/:itemType/:itemId/metadata/*',
  sessionAuthMiddleware({ required: true })
);

/** GET /api/metadata-templates — list tenant templates for authenticated users */
metadataTemplatesRoutes.get('/metadata-templates', async (c) => {
  const user = getAuthenticatedUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT id, tenant_id, key, display_name, description, fields_json, created_by, created_at, updated_at
       FROM metadata_templates
      WHERE tenant_id = ?
      ORDER BY display_name ASC, created_at ASC`
  )
    .bind(user.tenantId)
    .all<MetadataTemplateRow>();

  return c.json({
    templates: rows.results.map(formatTemplate),
  });
});

/** POST /api/admin/metadata-templates */
metadataTemplatesRoutes.post('/admin/metadata-templates', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    key?: unknown;
    displayName?: unknown;
    description?: unknown;
    fields?: unknown;
  } | null;

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const key = typeof body.key === 'string' ? body.key.trim().toLowerCase() : '';
  if (!key || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) {
    return c.json(
      { error: 'key must be 1..64 lowercase alphanumeric, underscore, or hyphen characters' },
      400
    );
  }

  const displayName =
    typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName || displayName.length > 100) {
    return c.json({ error: 'displayName must be 1..100 characters' }, 400);
  }

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string' || body.description.trim().length > 500) {
      return c.json({ error: 'description must be up to 500 characters' }, 400);
    }
    description = body.description.trim() || null;
  }

  const fieldsCheck = validateFieldsSchema(body.fields);
  if (!fieldsCheck.ok) {
    return c.json({ error: fieldsCheck.error }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM metadata_templates WHERE tenant_id = ? AND key = ?`
  )
    .bind(user.tenantId, key)
    .first<{ id: string }>();

  if (existing) {
    return c.json({ error: `Template key "${key}" already exists` }, 409);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const fieldsJson = JSON.stringify(fieldsCheck.fields);

  await c.env.DB.prepare(
    `INSERT INTO metadata_templates
       (id, tenant_id, key, display_name, description, fields_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      user.tenantId,
      key,
      displayName,
      description,
      fieldsJson,
      user.id,
      now,
      now
    )
    .run();

  return c.json(
    {
      template: {
        id,
        key,
        displayName,
        description,
        fields: fieldsCheck.fields,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      },
    },
    201
  );
});

/** PATCH /api/admin/metadata-templates/:id */
metadataTemplatesRoutes.patch('/admin/metadata-templates/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const templateId = c.req.param('id').trim();
  if (!templateId) {
    return c.json({ error: 'Invalid template id' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, tenant_id, key, display_name, description, fields_json, created_by, created_at, updated_at
       FROM metadata_templates
      WHERE id = ? AND tenant_id = ?`
  )
    .bind(templateId, user.tenantId)
    .first<MetadataTemplateRow>();

  if (!existing) {
    return c.json({ error: 'Metadata template not found' }, 404);
  }

  const body = (await c.req.json().catch(() => null)) as {
    displayName?: unknown;
    description?: unknown;
    fields?: unknown;
  } | null;

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  let nextDisplayName = existing.display_name;
  if (body.displayName !== undefined) {
    if (
      typeof body.displayName !== 'string' ||
      !body.displayName.trim() ||
      body.displayName.trim().length > 100
    ) {
      return c.json({ error: 'displayName must be 1..100 characters' }, 400);
    }
    nextDisplayName = body.displayName.trim();
  }

  let nextDescription = existing.description;
  if (body.description !== undefined) {
    if (body.description === null) {
      nextDescription = null;
    } else if (
      typeof body.description !== 'string' ||
      body.description.trim().length > 500
    ) {
      return c.json({ error: 'description must be up to 500 characters' }, 400);
    } else {
      nextDescription = body.description.trim() || null;
    }
  }

  let nextFields = parseTemplateFieldsJson(existing.fields_json);
  let nextFieldsJson = existing.fields_json;
  if (body.fields !== undefined) {
    const fieldsCheck = validateFieldsSchema(body.fields);
    if (!fieldsCheck.ok) {
      return c.json({ error: fieldsCheck.error }, 400);
    }
    nextFields = fieldsCheck.fields;
    nextFieldsJson = JSON.stringify(fieldsCheck.fields);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE metadata_templates
        SET display_name = ?,
            description = ?,
            fields_json = ?,
            updated_at = ?
      WHERE id = ? AND tenant_id = ?`
  )
    .bind(
      nextDisplayName,
      nextDescription,
      nextFieldsJson,
      now,
      templateId,
      user.tenantId
    )
    .run();

  return c.json({
    template: {
      id: existing.id,
      key: existing.key,
      displayName: nextDisplayName,
      description: nextDescription,
      fields: nextFields,
      createdBy: existing.created_by,
      createdAt: existing.created_at,
      updatedAt: now,
    },
  });
});

/** DELETE /api/admin/metadata-templates/:id */
metadataTemplatesRoutes.delete('/admin/metadata-templates/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const templateId = c.req.param('id').trim();
  if (!templateId) {
    return c.json({ error: 'Invalid template id' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM metadata_templates WHERE id = ? AND tenant_id = ?`
  )
    .bind(templateId, user.tenantId)
    .first<{ id: string }>();

  if (!existing) {
    return c.json({ error: 'Metadata template not found' }, 404);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM item_metadata_values WHERE tenant_id = ? AND template_id = ?`
    ).bind(user.tenantId, templateId),
    c.env.DB.prepare(
      `DELETE FROM metadata_templates WHERE id = ? AND tenant_id = ?`
    ).bind(templateId, user.tenantId),
  ]);

  return c.json({ ok: true, id: templateId });
});

/** GET /api/items/:itemType/:itemId/metadata */
metadataTemplatesRoutes.get('/items/:itemType/:itemId/metadata', async (c) => {
  const user = getAuthenticatedUser(c);
  const itemType = parseItemTargetType(c.req.param('itemType'));
  if (!itemType) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeTargetId(c.req.param('itemId'));
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const authz = await verifyItemTargetAccess(
    c.env.DB,
    user,
    itemType,
    itemId,
    'read'
  );
  if (!authz.ok) {
    return c.json({ error: authz.error }, authz.status);
  }

  const rows = await c.env.DB.prepare(
    `SELECT imv.template_id,
            mt.key AS template_key,
            mt.display_name,
            imv.values_json,
            imv.updated_by,
            imv.updated_at
       FROM item_metadata_values imv
       JOIN metadata_templates mt
         ON mt.id = imv.template_id
        AND mt.tenant_id = imv.tenant_id
      WHERE imv.tenant_id = ?
        AND imv.item_type = ?
        AND imv.item_id = ?
      ORDER BY mt.display_name ASC`
  )
    .bind(user.tenantId, itemType, itemId)
    .all<ItemMetadataRow>();

  return c.json({
    itemType,
    itemId,
    metadata: rows.results.map((r) => ({
      templateId: r.template_id,
      templateKey: r.template_key,
      displayName: r.display_name,
      values: parseValuesJson(r.values_json),
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
    })),
  });
});

/** PUT /api/items/:itemType/:itemId/metadata/:templateId */
metadataTemplatesRoutes.put(
  '/items/:itemType/:itemId/metadata/:templateId',
  async (c) => {
    const user = getAuthenticatedUser(c);
    const itemType = parseItemTargetType(c.req.param('itemType'));
    if (!itemType) {
      return c.json({ error: 'Invalid itemType' }, 400);
    }
    const itemId = normalizeTargetId(c.req.param('itemId'));
    const templateId = c.req.param('templateId').trim();
    if (!itemId || !templateId) {
      return c.json({ error: 'Invalid itemId or templateId' }, 400);
    }

    const authz = await verifyItemTargetAccess(
      c.env.DB,
      user,
      itemType,
      itemId,
      'write'
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const template = await c.env.DB.prepare(
      `SELECT id, tenant_id, key, display_name, description, fields_json, created_by, created_at, updated_at
         FROM metadata_templates
        WHERE id = ? AND tenant_id = ?`
    )
      .bind(templateId, user.tenantId)
      .first<MetadataTemplateRow>();

    if (!template) {
      return c.json({ error: 'Metadata template not found' }, 404);
    }

    const body = (await c.req.json().catch(() => null)) as {
      values?: unknown;
    } | null;

    const fields = parseTemplateFieldsJson(template.fields_json);
    const validation = validateMetadataValues(fields, body?.values);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    const now = new Date().toISOString();
    const valuesJson = JSON.stringify(validation.values);

    await c.env.DB.prepare(
      `INSERT INTO item_metadata_values
         (tenant_id, item_type, item_id, template_id, values_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, item_type, item_id, template_id)
       DO UPDATE SET
         values_json = excluded.values_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
      .bind(
        user.tenantId,
        itemType,
        itemId,
        templateId,
        valuesJson,
        user.id,
        now
      )
      .run();

    return c.json({
      ok: true,
      metadata: {
        templateId,
        templateKey: template.key,
        displayName: template.display_name,
        values: validation.values,
        updatedBy: user.id,
        updatedAt: now,
      },
    });
  }
);
