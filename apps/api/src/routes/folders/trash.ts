import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { type FolderRow } from '../../services/folder-closure-service';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  ChildFileRow,
  FILE_CHILD_COLS,
  FOLDER_CHILD_COLS,
  parseLimit,
} from './shared';

export function registerFolderTrashRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/folders/trash — top-level soft-deleted folders & files accessible to user */
  routes.get('/trash', async (c) => {
    const user = getAuthenticatedUser(c);
    const limit = parseLimit(c.req.query('limit'));

    const [foldersRes, filesRes] = await Promise.all([
      c.env.DB.prepare(
        `SELECT DISTINCT f.${FOLDER_CHILD_COLS.split(', ').join(', f.')}
           FROM folders f
           LEFT JOIN folders pf ON pf.id = f.parent_id
           JOIN folder_closures fc
             ON fc.tenant_id = f.tenant_id AND fc.descendant_id = f.id
           JOIN permissions p
             ON p.tenant_id = f.tenant_id AND p.target_type = 'folder' AND p.target_id = fc.ancestor_id
          WHERE f.tenant_id = ?
            AND f.deleted_at IS NOT NULL
            AND (f.parent_id IS NULL OR pf.deleted_at IS NULL)
            AND (
              (p.grantee_type = 'user' AND p.grantee_id = ?)
              OR (
                p.grantee_type = 'group'
                AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = p.grantee_id AND gm.user_id = ?)
              )
            )
          ORDER BY f.deleted_at DESC
          LIMIT ?`
      )
        .bind(user.tenantId, user.id, user.id, limit)
        .all<FolderRow>(),
      c.env.DB.prepare(
        `SELECT DISTINCT fl.${FILE_CHILD_COLS.split(', ').join(', fl.')}, fl.deleted_at
           FROM files fl
           LEFT JOIN folders pf ON pf.id = fl.folder_id
           JOIN permissions p
             ON p.tenant_id = fl.tenant_id
            AND (
              (p.target_type = 'file' AND p.target_id = fl.id)
              OR (
                p.target_type = 'folder'
                AND fl.folder_id IS NOT NULL
                AND p.target_id IN (
                  SELECT fc.ancestor_id FROM folder_closures fc
                   WHERE fc.tenant_id = fl.tenant_id AND fc.descendant_id = fl.folder_id
                )
              )
            )
          WHERE fl.tenant_id = ?
            AND fl.upload_state = 'active'
            AND fl.deleted_at IS NOT NULL
            AND (fl.folder_id IS NULL OR pf.deleted_at IS NULL)
            AND (
              (p.grantee_type = 'user' AND p.grantee_id = ?)
              OR (
                p.grantee_type = 'group'
                AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = p.grantee_id AND gm.user_id = ?)
              )
            )
          ORDER BY fl.deleted_at DESC
          LIMIT ?`
      )
        .bind(user.tenantId, user.id, user.id, limit)
        .all<ChildFileRow & { deleted_at: string }>(),
    ]);

    return c.json({
      folders: foldersRes.results,
      files: filesRes.results,
    });
  });

}

